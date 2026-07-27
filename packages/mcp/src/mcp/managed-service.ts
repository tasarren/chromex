import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { errorMessage } from "../protocol/schema.js";
import { ManagedBrowser, ManagedBrowserLaunchError, managedProjectKey } from "./managed-browser.js";
import { OriginPolicy } from "./origin-policy.js";
import type { ManagedProcessOutputSource } from "./process-output.js";
import type { ServiceRecord } from "./shared-browser.js";

const options = z
  .object({
    browserId: z.string(),
    descriptorPath: z.string(),
    projectPath: z.string(),
    profile: z.string(),
    temporary: z.boolean().optional(),
  })
  .parse(JSON.parse(process.argv[2] ?? "{}"));
const directory = await mkdtemp(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "chromex-service-"));
await chmod(directory, 0o700);
const socketPath = join(directory, "control.sock");
const token = randomBytes(32).toString("hex");
let browser: ManagedBrowser | undefined;
let diagnostics: ManagedProcessOutputSource | undefined;
let stopping = false;
let exitedAt: number | null = null;
let queue: Promise<unknown> = Promise.resolve();

function record(): ServiceRecord {
  return {
    browserId: options.browserId,
    configPath: browser?.configPath ?? "",
    pid: process.pid,
    profile: options.profile,
    projectKey: managedProjectKey(options.projectPath),
    projectPath: options.projectPath,
    socketPath,
    temporary: options.temporary === true,
    token,
  };
}

async function publish(pid = process.pid): Promise<void> {
  const temporary = `${options.descriptorPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...record(), pid }), { mode: 0o600 });
  await rename(temporary, options.descriptorPath);
}

async function ensure(): Promise<ServiceRecord> {
  if (stopping) throw new Error("Managed browser service is stopping");
  if (browser && !browser.exited) {
    try {
      await browser.ensureBridge();
    } catch (cause) {
      if (!browser.exited) throw cause;
    }
  }
  if (!browser || browser.exited) {
    await browser?.close();
    browser = undefined;
    try {
      browser = await ManagedBrowser.launch(options);
      diagnostics = browser.diagnostics;
    } catch (cause) {
      if (cause instanceof ManagedBrowserLaunchError) diagnostics = cause.diagnostics;
      exitedAt = Date.now();
      throw cause;
    }
    exitedAt = null;
    await publish();
  }
  return record();
}

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(403).end();
    return;
  }
  try {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64 * 1024) throw new Error("Request too large");
    }
    const params: unknown = JSON.parse(body);
    const action = async () => {
      if (req.url === "/status") return record();
      if (req.url === "/ensure") return await ensure();
      if (req.url === "/output") {
        const query = z
          .object({
            stream: z.enum(["all", "stdout", "stderr"]),
            cursor: z.number().int().positive().optional(),
            maxChars: z.number().int().min(500).max(100_000),
            allowedOrigins: z.array(z.string()).max(256),
          })
          .parse(params);
        const policy = new OriginPolicy();
        for (const origin of query.allowedOrigins) await policy.allow(origin, false);
        if (!diagnostics) throw new Error("No Managed process diagnostics available");
        return diagnostics.read(query, policy);
      }
      throw new Error("Unknown Managed service method");
    };
    const result = queue.then(action);
    queue = result.catch(() => undefined);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(await result));
  } catch (cause) {
    res
      .writeHead(500, { "content-type": "application/json" })
      .end(JSON.stringify({ error: errorMessage(cause) }));
  }
});

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(watch);
  await queue;
  await browser?.close();
  // Mark clean shutdown so later PID reuse cannot block rediscovery.
  await publish(0);
  server.close();
  await rm(directory, { force: true, recursive: true });
}

// Keep exit diagnostics briefly available; a later use can restart the same profile.
const watch = setInterval(() => {
  if (browser && !browser.exited) return;
  exitedAt ??= Date.now();
  if (Date.now() - exitedAt > 60_000) void shutdown();
}, 1_000);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void shutdown());
try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  await publish();
  process.send?.(record());
} catch (cause) {
  process.send?.({ error: errorMessage(cause) });
  await shutdown();
}
