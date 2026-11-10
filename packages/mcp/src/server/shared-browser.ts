import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { request } from "node:http"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { BrokerClient } from "../shared/broker-client.ts"
import { extensionResults } from "../shared/extension-list.ts"
import { managedDataHome, type ManagedLaunchOptions, validateProfileName } from "../service/managed-browser.ts"
import {
  type ManagedProcessOutputQuery,
  type ManagedProcessOutputResult,
  ManagedProcessOutputResultSchema,
} from "../shared/process-output.ts"
import { acquireProfileLock, isErrno, isPidAlive } from "../shared/profile-lock.ts"
import { workspaceStorage } from "../shared/workspace.ts"

const ServiceRecordSchema = z.object({
  browserId: z.string(),
  configPath: z.string(),
  pid: z.number().int().nonnegative(),
  profile: z.string(),
  socketPath: z.string(),
  temporary: z.boolean(),
  token: z.string().min(32),
  workspace: z.object({ key: z.string(), root: z.string() }),
})
export type ServiceRecord = z.infer<typeof ServiceRecordSchema>

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const ServiceErrorSchema = z.object({ error: z.string() })

/** Start-lock releases that failed, by descriptor path; the next start of that path retries them first. */
const pendingUnlocks = new Map<string, () => Promise<void>>()

/**
 * Release the start lock for `path`. A failed release is kept for retry and reported together with
 * any `original` start failure, so neither is hidden.
 */
async function releaseStartLock(path: string, unlock: () => Promise<void>, original?: unknown): Promise<void> {
  try {
    await unlock()
  } catch(cause) {
    pendingUnlocks.set(path, unlock)
    const release = `the start lock ${path}.lock.owner was not released (${errorText(cause)}); the next start retries it`
    if (original === undefined) {
      throw new Error(`Managed browser service started, but ${release}. Reconnect to join it`, { cause })
    }
    throw new AggregateError([original, cause], `${errorText(original)}; also ${release}`, { cause })
  }
}

async function retryStartLock(path: string): Promise<void> {
  const pending = pendingUnlocks.get(path)
  if (!pending) return
  await pending()
  if (pendingUnlocks.get(path) === pending) pendingUnlocks.delete(path)
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Each Managed service method and the decoder for its answer. */
const serviceResults = {
  ...extensionResults,
  cdp: z.record(z.string(), z.unknown()),
  ensure: ServiceRecordSchema,
  gesture: z.unknown(),
  inspect: z.object({ result: z.unknown() }),
  input: z.object({ results: z.array(z.unknown()) }),
  output: ManagedProcessOutputResultSchema,
  status: ServiceRecordSchema,
}
type ServiceMethod = keyof typeof serviceResults

/** Call the Managed service over its private socket and decode the answer for that method. */
export async function callService<Method extends ServiceMethod>(
  record: ServiceRecord,
  method: Method,
  params: unknown = {},
): Promise<z.infer<(typeof serviceResults)[Method]>> {
  const body = await new Promise<{ statusCode: number | undefined; text: string }>(
    (resolve, reject) => {
      const req = request(
        {
          socketPath: record.socketPath,
          method: "POST",
          path: `/${method}`,
          headers: { authorization: `Bearer ${record.token}`, "content-type": "application/json" },
        },
        (res) => {
          let text = ""
          let bytes = 0
          res.setEncoding("utf8")
          res.on("data", (chunk: string) => {
            text += chunk
            bytes += Buffer.byteLength(chunk, "utf8")
            if (bytes > MAX_RESPONSE_BYTES)
              req.destroy(new Error("Managed service response too large"))
          })
          res.on("error", reject)
          res.on("end", () => { resolve({ statusCode: res.statusCode, text }) })
        },
      )
      req.setTimeout(25_000, () => req.destroy(new Error("Managed service timed out")))
      req.on("error", reject)
      req.end(JSON.stringify(params))
    },
  )
  let value: unknown
  try {
    value = JSON.parse(body.text)
  } catch {
    throw new Error(`Managed service sent invalid JSON for ${method}`)
  }
  if (body.statusCode !== 200) {
    const failure = ServiceErrorSchema.safeParse(value)
    throw new Error(failure.success ? failure.data.error : "Managed service request failed")
  }
  const result = serviceResults[method].safeParse(value)
  if (!result.success) throw new Error(`Managed service sent an invalid ${method} answer`)
  // Already validated by this method's decoder; TypeScript cannot narrow the indexed union.
  return result.data as z.infer<(typeof serviceResults)[Method]>
}

export class SharedBrowser {
  broker: BrokerClient
  readonly record: ServiceRecord
  private constructor(record: ServiceRecord) {
    this.record = record
    this.broker = new BrokerClient({ configPath: record.configPath, mode: "managed" })
  }

  /**
   * Join or start the service for this workspace binding. Lookup never leaves the workspace's own
   * service directory, so a legacy or foreign `browserId` cannot select another scope. Agents that
   * join share the browser; the extension's tab leases admit one controller per tab.
   */
  static async connect(options: ManagedLaunchOptions, browserId?: string): Promise<SharedBrowser> {
    const { workspace } = options
    const profile = validateProfileName(options.profile ?? "default")
    const id = browserId ?? (options.temporary ? randomUUID() : profile)
    if (!/^[A-Za-z0-9._-]{1,180}$/.test(id)) throw new Error("Invalid Managed browser ID")
    // The workspace marker is validated before the services directory or any start lock is touched.
    const storage = await workspaceStorage(workspace, managedDataHome())
    const directory = storage.services
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, `${id}.json`)
    // Every selector the caller gave must agree with the record, so a browser ID cannot pull in
    // another profile (or its configured extensions) inside the same workspace.
    const assertInScope = (record: ServiceRecord) => {
      if (record.workspace.root !== workspace.root || record.workspace.key !== workspace.key) {
        throw new Error(`Managed browser ${id} belongs to another workspace (${record.workspace.root})`)
      }
      if (record.browserId !== id) throw new Error(`Managed browser descriptor ${id} names ${record.browserId}`)
      if (options.profile !== undefined && record.profile !== profile) {
        throw new Error(`Managed browser ${id} uses profile "${record.profile}", not "${profile}"`)
      }
      if (options.temporary !== undefined && record.temporary !== options.temporary) {
        throw new Error(`Managed browser ${id} is ${record.temporary ? "" : "not "}temporary`)
      }
    }
    // A joining caller needs no start lock, so a start lock this process failed to release before is
    // retried here without blocking the join; a start below retries it again and stops on failure.
    await retryStartLock(path).catch(() => undefined)
    const deadline = Date.now() + 30_000
    for (;;) {
      let record: ServiceRecord | undefined
      try {
        record = ServiceRecordSchema.parse(JSON.parse(await readFile(path, "utf8")))
      } catch(cause) {
        if (!isErrno(cause, "ENOENT")) throw cause
      }
      if (record) {
        assertInScope(record)
        try {
          const active = await callService(record, "status")
          assertInScope(active)
          return new SharedBrowser(active)
        } catch(cause) {
          if (!isErrno(cause, "ENOENT", "ECONNREFUSED")) throw cause
          if (record.pid > 0 && isPidAlive(record.pid)) {
            throw new Error("Managed browser service is alive but unavailable; retry shortly", {
              cause,
            })
          }
        }
      }
      if (browserId && !record)
        throw new Error(
          "Managed browser ID is no longer available; reconnect using its profile",
        )
      // A start lock this process failed to release earlier is released before taking it again.
      await retryStartLock(path)
      let unlock: () => Promise<void>
      try {
        unlock = await acquireProfileLock(`${path}.lock`, randomUUID(), process.pid)
      } catch(cause) {
        if (!String(cause).includes("profile is active") || Date.now() >= deadline) throw cause
        await delay(100)
        continue
      }
      let failed = false
      try {
        // Another starter may have published its service while this caller waited for the lock.
        // Unreadable, empty or malformed descriptors throw; only a still-absent one may start a service.
        let current: ServiceRecord | undefined
        try {
          current = ServiceRecordSchema.parse(JSON.parse(await readFile(path, "utf8")))
        } catch(cause) {
          if (!isErrno(cause, "ENOENT")) throw cause
          if (record) {
            throw new Error(`Managed browser descriptor ${id} disappeared while waiting to start it; retry`, {
              cause,
            })
          }
        }
        if (current) {
          assertInScope(current)
          try {
            const active = await callService(current, "status")
            assertInScope(active)
            return new SharedBrowser(active)
          } catch(cause) {
            if (!isErrno(cause, "ENOENT", "ECONNREFUSED")) throw cause
            // A competing starter may have published while this caller waited: never start a second service.
            if (current.pid > 0 && isPidAlive(current.pid)) {
              throw new Error("Managed browser service is alive but unavailable; retry shortly", { cause })
            }
          }
        }
        const entry = join(dirname(fileURLToPath(import.meta.url)), "managed-service.mjs")
        const launch = current
          ? { profile: current.profile, temporary: current.temporary, workspace }
          : { ...options, profile, workspace }
        const child = spawn(
          process.execPath,
          [entry, JSON.stringify({ ...launch, browserId: id, descriptorPath: path })],
          { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
        )
        const result = await new Promise<ServiceRecord>((resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill()
            reject(new Error("Managed browser service startup timed out"))
          }, 25_000)
          child.once("error", (cause) => {
            clearTimeout(timer)
            reject(cause)
          })
          child.once("exit", (code) => {
            clearTimeout(timer)
            reject(new Error(`Managed browser service exited (${code})`))
          })
          child.once("message", (value) => {
            clearTimeout(timer)
            const failure = ServiceErrorSchema.safeParse(value)
            const started = ServiceRecordSchema.safeParse(value)
            if (failure.success) reject(new Error(failure.data.error))
            else if (started.success) resolve(started.data)
            else reject(new Error("Managed browser service sent an invalid startup message"))
          })
        })
        child.disconnect()
        child.unref()
        assertInScope(result)
        return new SharedBrowser(result)
      } catch(cause) {
        failed = true
        await releaseStartLock(path, unlock, cause)
        throw cause
      } finally {
        if (!failed) await releaseStartLock(path, unlock)
      }
    }
  }

  async ensure(): Promise<boolean> {
    const current = await callService(this.record, "ensure")
    if (current.workspace.root !== this.record.workspace.root || current.browserId !== this.record.browserId) {
      throw new Error("Managed browser service changed scope; reconnect")
    }
    const same = current.configPath === this.record.configPath
    if (!same) {
      await this.broker.close()
      Object.assign(this.record, current)
      this.broker = new BrokerClient({ configPath: current.configPath, mode: "managed" })
    }
    return same
  }

  async output(query: ManagedProcessOutputQuery): Promise<ManagedProcessOutputResult> {
    return await callService(this.record, "output", query)
  }

  /** Install configured extension directories that are not loaded yet; one serialized service call. */
  async configureExtensions(
    paths: readonly string[],
  ): Promise<{ installed: string[]; skipped: string[] }> {
    return await callService(this.record, "extensionConfigure", { paths })
  }

  /** Run one unpacked-extension method in the service for this agent. */
  async extension<Method extends "extensionInstall" | "extensionList" | "extensionRemove">(
    method: Method,
    params: Record<string, unknown>,
  ) {
    return await callService(this.record, method, { ...params, clientId: this.broker.clientId })
  }

  /** Bind a pipe-driven tab to this service's exact target and document. */
  async bind(tabId: number, targetId: string): Promise<void> {
    await callService(this.record, "gesture", { action: "bind", tabId, targetId })
  }

  /** Remove the agent cursor from a pipe-driven tab before its lease is released (ISS-07). */
  async release(tabId: number): Promise<void> {
    await callService(this.record, "gesture", { action: "release", tabId })
  }

  /** Run or clean up one pipe gesture step as the bound executor. */
  async gesture(token: string): Promise<unknown> {
    return await callService(this.record, "gesture", { action: "run", token })
  }

  /** Run the one page command the extension reserved under `token` over the service's browser pipe. */
  async cdp(token: string): Promise<unknown> {
    return await callService(this.record, "cdp", { token })
  }

  /** Run the fixed read the extension issued under `token` for a tab another client controls. */
  async inspect(token: string): Promise<unknown> {
    return (await callService(this.record, "inspect", { token })).result
  }

  /** Run pipe input the extension reserved under `token`; the service ends it even if we exit. */
  async input(token: string): Promise<unknown> {
    return await callService(this.record, "input", { token })
  }

  /** End this agent's bridge client; the browser and its tabs stay open. */
  async close(): Promise<void> {
    await this.broker.close()
  }
}
