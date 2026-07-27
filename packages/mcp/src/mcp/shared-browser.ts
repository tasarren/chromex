import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { BrokerClient } from "./broker-client.js";
import {
  acquireProfileLock,
  type ManagedLaunchOptions,
  managedProjectKey,
  validateProfileName,
} from "./managed-browser.js";
import type { ManagedProcessOutputQuery, ManagedProcessOutputResult } from "./process-output.js";

export const ServiceRecordSchema = z.object({
  browserId: z.string(),
  configPath: z.string(),
  pid: z.number().int().nonnegative(),
  profile: z.string(),
  projectKey: z.string(),
  projectPath: z.string(),
  socketPath: z.string(),
  temporary: z.boolean(),
  token: z.string().min(32),
});
export type ServiceRecord = z.infer<typeof ServiceRecordSchema>;

export function serviceDirectory(): string {
  return join(
    process.env.XDG_DATA_HOME || join(process.env.HOME || homedir(), ".local/share"),
    "chromex/services",
  );
}

export async function serviceRequest<T>(
  record: ServiceRecord,
  method: string,
  params: unknown = {},
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const req = request(
      {
        socketPath: record.socketPath,
        method: "POST",
        path: `/${method}`,
        headers: { authorization: `Bearer ${record.token}`, "content-type": "application/json" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 2 * 1024 * 1024)
            req.destroy(new Error("Managed service response too large"));
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const value = JSON.parse(body);
            if (res.statusCode !== 200)
              throw new Error(value.error ?? "Managed service request failed");
            resolve(value as T);
          } catch (cause) {
            reject(cause);
          }
        });
      },
    );
    req.setTimeout(25_000, () => req.destroy(new Error("Managed service timed out")));
    req.on("error", reject);
    req.end(JSON.stringify(params));
  });
}

export class SharedBrowser {
  broker: BrokerClient;
  private constructor(readonly record: ServiceRecord) {
    this.broker = new BrokerClient({ configPath: record.configPath, mode: "managed" });
  }

  static async connect(options: ManagedLaunchOptions, browserId?: string): Promise<SharedBrowser> {
    const profile = validateProfileName(options.profile ?? "default");
    const id =
      browserId ??
      (options.temporary ? randomUUID() : `${managedProjectKey(options.projectPath)}--${profile}`);
    if (!/^[A-Za-z0-9._-]{1,180}$/.test(id)) throw new Error("Invalid Managed browser ID");
    const directory = serviceDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${id}.json`);
    const deadline = Date.now() + 30_000;
    while (true) {
      let record: ServiceRecord | undefined;
      try {
        record = ServiceRecordSchema.parse(JSON.parse(await readFile(path, "utf8")));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      if (record) {
        try {
          const current = ServiceRecordSchema.parse(await serviceRequest(record, "status"));
          return new SharedBrowser(current);
        } catch (cause) {
          if (!["ENOENT", "ECONNREFUSED"].includes((cause as NodeJS.ErrnoException).code ?? ""))
            throw cause;
          if (record.pid > 0) {
            try {
              process.kill(record.pid, 0);
              throw new Error("Managed browser service is alive but unavailable; retry shortly");
            } catch (probe) {
              if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
            }
          }
        }
      }
      if (browserId && !record)
        throw new Error(
          "Managed browser ID is no longer available; reconnect using its project/profile",
        );
      let unlock: (() => Promise<void>) | undefined;
      try {
        unlock = await acquireProfileLock(`${path}.lock`, randomUUID(), process.pid);
      } catch (cause) {
        if (!String(cause).includes("profile is active") || Date.now() >= deadline) throw cause;
        await delay(100);
        continue;
      }
      try {
        // Another starter may have published its service while this caller waited for the lock.
        const latest = await readFile(path, "utf8").catch(() => "");
        if (latest) {
          const current = ServiceRecordSchema.parse(JSON.parse(latest));
          try {
            return new SharedBrowser(
              ServiceRecordSchema.parse(await serviceRequest(current, "status")),
            );
          } catch (cause) {
            if (!["ENOENT", "ECONNREFUSED"].includes((cause as NodeJS.ErrnoException).code ?? ""))
              throw cause;
          }
        }
        const entry = join(dirname(fileURLToPath(import.meta.url)), "managed-service.mjs");
        const launch = record
          ? {
              projectPath: record.projectPath,
              profile: record.profile,
              temporary: record.temporary,
            }
          : { ...options, profile };
        const child = spawn(
          process.execPath,
          [entry, JSON.stringify({ ...launch, browserId: id, descriptorPath: path })],
          { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
        );
        const result = await new Promise<ServiceRecord>((resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error("Managed browser service startup timed out"));
          }, 25_000);
          child.once("error", (cause) => {
            clearTimeout(timer);
            reject(cause);
          });
          child.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`Managed browser service exited (${code})`));
          });
          child.once("message", (value) => {
            clearTimeout(timer);
            try {
              if ((value as { error?: string }).error)
                throw new Error((value as { error: string }).error);
              resolve(ServiceRecordSchema.parse(value));
            } catch (cause) {
              reject(cause);
            }
          });
        });
        child.disconnect();
        child.unref();
        return new SharedBrowser(result);
      } finally {
        await unlock();
      }
    }
  }

  async ensure(): Promise<boolean> {
    const current = ServiceRecordSchema.parse(await serviceRequest(this.record, "ensure"));
    const same = current.configPath === this.record.configPath;
    if (!same) {
      await this.broker.close();
      Object.assign(this.record, current);
      this.broker = new BrokerClient({ configPath: current.configPath, mode: "managed" });
    }
    return same;
  }

  async output(
    query: ManagedProcessOutputQuery,
    allowedOrigins: string[],
  ): Promise<ManagedProcessOutputResult> {
    return await serviceRequest(this.record, "output", { ...query, allowedOrigins });
  }

  async close(): Promise<void> {
    await this.broker.close();
  }
}
