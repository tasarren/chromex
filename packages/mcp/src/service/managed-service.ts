import { randomBytes } from "node:crypto"
import { chmod, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type DocumentIdentity, EXTENSION_ID, errorMessage, readDocument, replacesDocument } from "@chromex/protocol"
import { z } from "zod"
import {
  installConfiguredExtensions,
  resolveConfiguredExtensions,
  resolveExtensionDirectory,
  UnpackedExtensionSchema,
} from "../shared/extension-list.ts"
import { BrokerRefusal } from "../shared/broker-client.ts"
import { ManagedBrowser, ManagedBrowserLaunchError, shutdownBrowser } from "./managed-browser.ts"
import {
  FenceRefusal,
  removeCursor,
  runFenced,
  runInspect,
  runServiceInput,
  ServiceGestureExecutor,
  type ServicePipeInput,
} from "./pipe-input.ts"
import { ProfileProgress, profileFailure } from "./profile-change.ts"
import type { ManagedProcessOutputSource } from "../shared/process-output.ts"
import type { ServiceRecord } from "../server/shared-browser.ts"

const options = z
  .object({
    browserId: z.string(),
    descriptorPath: z.string(),
    profile: z.string(),
    temporary: z.boolean().optional(),
    workspace: z.object({ key: z.string().min(1), root: z.string().min(1) }),
  })
  .parse(JSON.parse(process.argv[2] ?? "{}"))
const OutputQuerySchema = z.object({
  stream: z.enum(["all", "stdout", "stderr"]),
  cursor: z.number().int().positive().optional(),
  maxChars: z.number().int().min(500).max(100_000),
})
const directory = await mkdtemp(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "chromex-service-"))
await chmod(directory, 0o700)
const socketPath = join(directory, "control.sock")
const token = randomBytes(32).toString("hex")
let browser: ManagedBrowser | undefined
let diagnostics: ManagedProcessOutputSource | undefined
let gestureExecutor: ServiceGestureExecutor | undefined
/** Pipe targets this service bound to a tab, for document/detach invalidation. */
const pipeTabs = new Map<string, number>()
const pipeSessions = new Map<string, number>()
/** Local replacement count per exact attached session; the executor reads it before each input. */
const pipeEpochs = new Map<string, number>()
let stopping = false
let exitedAt: number | null = null
let queue: Promise<unknown> = Promise.resolve()

function record(): ServiceRecord {
  return {
    browserId: options.browserId,
    configPath: browser?.configPath ?? "",
    pid: process.pid,
    profile: options.profile,
    socketPath,
    temporary: options.temporary === true,
    token,
    workspace: options.workspace,
  }
}

async function publish(pid = process.pid): Promise<void> {
  const temporary = `${options.descriptorPath}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify({ ...record(), pid }), { mode: 0o600 })
  await rename(temporary, options.descriptorPath)
}

async function ensure(): Promise<ServiceRecord> {
  if (stopping) throw new Error("Managed browser service is stopping")
  if (browser && !browser.exited) {
    try {
      await browser.ensureBridge()
    } catch(cause) {
      // `exited` is a live getter; the failed check above may have seen the browser die.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!browser.exited) throw cause
    }
  }
  if (!browser || browser.exited) {
    await browser?.close()
    browser = undefined
    try {
      browser = await ManagedBrowser.launch(options)
      diagnostics = browser.diagnostics
      pipeTabs.clear()
      pipeSessions.clear()
      pipeEpochs.clear()
      watchPipe(browser)
    } catch(cause) {
      if (cause instanceof ManagedBrowserLaunchError) diagnostics = cause.diagnostics
      exitedAt = Date.now()
      throw cause
    }
    exitedAt = null
    await publish()
  }
  return record()
}

const ExtensionParamsSchema = z.object({
  clientId: z.string(),
  id: z.string().optional(),
  path: z.string().optional(),
})
const BridgeClientsSchema = z.object({
  clients: z.array(z.object({ clientId: z.string(), label: z.string().optional() })),
})
const ConfigureParamsSchema = z.object({
  paths: z.array(z.string().min(1)),
})

/** Resolve extension arguments before reserving a profile fence, so a bad path cannot orphan it. */
async function prepareExtension(
  method: "/extensionInstall" | "/extensionRemove",
  params: unknown,
): Promise<{ request: z.infer<typeof ExtensionParamsSchema>; path?: string }> {
  const request = ExtensionParamsSchema.parse(params)
  if (method === "/extensionInstall") {
    return { request, path: await resolveExtensionDirectory(request.path ?? "") }
  }
  const path = request.path && (await realpath(request.path).catch(() => request.path))
  return { request, ...(path === undefined ? {} : { path }) }
}

/** Install configured directories only when not loaded; one serialized call keeps joins idempotent. */
async function configureExtensions(
  active: ManagedBrowser,
  ready: readonly string[],
  progress: ProfileProgress,
  skipped: string[],
) {
  const { installed } = await installConfiguredExtensions(ready, {
    add: async(path) => {
      progress.dispatch()
      await active.extensions.add(path)
    },
    load: async(path) => {
      progress.dispatch()
      await active.cdp.send("Extensions.loadUnpacked", { path })
    },
    loaded: async() =>
      z
        .object({ extensions: z.array(UnpackedExtensionSchema) })
        .parse(await active.cdp.send("Extensions.getExtensions"))
        .extensions.map((extension) => extension.path),
    resolve: resolveExtensionDirectory,
    step: (step) => { progress.step(step) },
  })
  return { installed, skipped }
}

/** Read the loaded unpacked extensions and this profile's configured list. */
async function extensionList(active: ManagedBrowser) {
  const loaded = z
    .object({ extensions: z.array(UnpackedExtensionSchema) })
    .parse(await active.cdp.send("Extensions.getExtensions")).extensions
  return { extensions: loaded, listed: await active.extensions.read() }
}

/** Install or remove an unpacked extension and keep the profile list in step. */
async function extensionAction(
  active: ManagedBrowser,
  prepared: Awaited<ReturnType<typeof prepareExtension>>,
  method: "/extensionInstall" | "/extensionRemove",
  progress: ProfileProgress,
) {
  const { request } = prepared
  const loaded = z
    .object({ extensions: z.array(UnpackedExtensionSchema) })
    .parse(await active.cdp.send("Extensions.getExtensions")).extensions
  // Extension edits reach every agent in this profile; name the others.
  const otherClients = async() =>
    BridgeClientsSchema.parse(await active.broker.request("bridge.status"))
      .clients.filter(({ clientId }) => ![request.clientId, active.broker.clientId].includes(clientId))
      .map(({ clientId, label }) => label ?? clientId)
  switch (method) {
    case "/extensionInstall": {
      const path = prepared.path ?? ""
      const reloaded = loaded.some((extension) => extension.path === path)
      // Loading a loaded path again reloads it in place (same ID, new manifest).
      // ponytail: reload is explicit (install again); add a file watcher if reload calls get frequent.
      progress.dispatch()
      const { id } = z
        .object({ id: z.string() })
        .parse(await active.cdp.send("Extensions.loadUnpacked", { path }))
      progress.step(`loaded ${path}`)
      progress.dispatch()
      await active.extensions.add(path)
      progress.step(`listed ${path}`)
      return { id, otherClients: await otherClients(), path, reloaded }
    }
    case "/extensionRemove": {
      const path = prepared.path
      const target = loaded.find((extension) =>
        request.id ? extension.id === request.id : extension.path === path)
      if (!target && !path) throw new Error(`No unpacked extension has ID ${request.id}`)
      if (target?.id === EXTENSION_ID) throw new Error("Chromex cannot remove itself")
      if (target) {
        // Chromium uninstalls only CDP-loaded extensions; reloading converts a launch-loaded one.
        progress.dispatch()
        await active.cdp.send("Extensions.loadUnpacked", { path: target.path })
        progress.step(`reloaded ${target.id}`)
        progress.dispatch()
        await active.cdp.send("Extensions.uninstall", { id: target.id })
        progress.step(`uninstalled ${target.id}`)
      }
      const listedPath = target?.path ?? path ?? null
      if (listedPath) {
        progress.dispatch()
        await active.extensions.remove(listedPath)
        progress.step(`unlisted ${listedPath}`)
      }
      return { id: target?.id ?? null, otherClients: await otherClients(), path: listedPath }
    }
  }
}

/** Register the pipe target this service executes for one tab, with its current document. */
async function bindGesture(active: ManagedBrowser, tabId: number, targetId: string): Promise<void> {
  const sessionId = await active.cdp.session(targetId)
  await active.cdp.send("Page.enable", {}, sessionId)
  const epoch = pipeEpochs.get(sessionId) ?? 0
  pipeEpochs.set(sessionId, epoch)
  const document: DocumentIdentity = await readDocument(
    (method, params) => active.cdp.send(method, params, sessionId),
    () => pipeEpochs.get(sessionId) ?? epoch,
  )
  pipeTabs.set(targetId, tabId)
  pipeSessions.set(sessionId, tabId)
  await active.broker.request("gesture.bind", { document, sessionId, tabId, targetId })
}

/** Count page replacement and session loss for every bound pipe page. */
function watchPipe(active: ManagedBrowser): void {
  gestureExecutor = new ServiceGestureExecutor({
    broker: active.broker,
    cdp: active.cdp,
    epoch: (sessionId) => pipeEpochs.get(sessionId) ?? 0,
  })
  active.broker.onNotification((method, params) => {
    if (method === "gesture.cleanup") void gestureExecutor?.cleanup().catch(() => undefined)
    if (method === "gesture.cancel") {
      const parsed = z.object({ gestureId: z.string() }).safeParse(params)
      if (parsed.success) gestureExecutor?.cancel(parsed.data.gestureId)
    }
  })
  active.cdp.onEvent((event) => {
    const params = event.params
    const targetId = typeof params.targetId === "string" ? params.targetId : undefined
    const sessionId = typeof params.sessionId === "string"
      ? params.sessionId
      : event.sessionId
    const tabId = (sessionId === undefined ? undefined : pipeSessions.get(sessionId)) ??
      (targetId === undefined ? undefined : pipeTabs.get(targetId))
    if (tabId === undefined) return
    const detached = event.method === "Target.detachedFromTarget" || event.method === "Target.targetDestroyed"
    if (!detached && !replacesDocument(event.method, params)) return
    if (sessionId !== undefined) {
      pipeEpochs.set(sessionId, (pipeEpochs.get(sessionId) ?? 0) + 1)
      pipeSessions.delete(sessionId)
    }
    if (targetId !== undefined) {
      for (const [attached, bound] of pipeSessions) {
        if (bound !== tabId) continue
        pipeEpochs.set(attached, (pipeEpochs.get(attached) ?? 0) + 1)
        pipeSessions.delete(attached)
      }
      pipeTabs.delete(targetId)
    }
    void active.broker.request("gesture.invalidate", { detached, tabId }).catch(() => undefined)
  })
}

const InputParamsSchema = z.object({ token: z.string().min(1) })
const GestureParamsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("bind"), tabId: z.number().int().nonnegative(), targetId: z.string().min(1) }),
  z.object({ action: z.literal("run"), token: z.string().min(1) }),
  z.object({ action: z.literal("cleanup") }),
  z.object({ action: z.literal("release"), tabId: z.number().int().nonnegative() }),
])
const OperationSchema = z.object({
  commands: z.array(z.object({ method: z.string(), params: z.record(z.string(), z.unknown()) })),
  field: z.object({ backendNodeId: z.number().int(), clear: z.boolean() }).optional(),
})
const BegunSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("input"), operation: OperationSchema, targetId: z.string().min(1) }),
  z.object({ kind: z.literal("cdp"), operation: OperationSchema, targetId: z.string().min(1) }),
  z.object({ kind: z.literal("profile"), operation: z.record(z.string(), z.unknown()) }),
])

/** The extension's fence over this browser: begin is the persisted intent, end proves completion. */
function fence(active: ManagedBrowser): ServicePipeInput {
  const sessions = new Map<string, Promise<string>>()
  return {
    // An input begin keeps its original reply shape, without a kind.
    begin: async(token) => {
      const begun = await active.broker.request("input.begin", { token })
      return BegunSchema.parse(typeof begun === "object" && begun !== null ? { kind: "input", ...begun } : begun)
    },
    command: async(targetId, method, params) => {
      let session = sessions.get(targetId)
      if (!session) sessions.set(targetId, session = active.cdp.session(targetId))
      return await active.cdp.send(method, params, await session)
    },
    end: async(token) => await active.broker.request("input.end", { token }),
    uncertain: async(token) => await active.broker.request("input.uncertain", { token }),
  }
}

/**
 * Run reserved pipe input or page commands for a `chrome://` tab. The extension admitted them for
 * the lease and names the target, so a caller cannot redirect them. An uncertain outcome leaves the
 * admission fenced, so the extension keeps the target hidden until a browser restart.
 */
async function runPipe(active: ManagedBrowser, token: string, kind: "cdp" | "input") {
  const pipe = fence(active)
  if (kind === "input") return { results: await runServiceInput(token, pipe) }
  return await runFenced(token, pipe, async(begun) => {
    if (begun.kind !== "cdp" || begun.operation.commands.length !== 1) {
      throw new FenceRefusal("Expected one reserved page command")
    }
    const [command] = begun.operation.commands
    if (!command) throw new FenceRefusal("Expected one reserved page command")
    return await pipe.command(begun.targetId, command.method, command.params)
  })
}

/**
 * Change the profile's extensions inside a `profile` fence the service reserves itself. A crash or
 * timeout mid-change leaves the persisted intent, which blocks handoff until the browser restarts.
 */
async function profileChange<T>(
  active: ManagedBrowser,
  operation: Record<string, unknown>,
  change: (progress: ProfileProgress) => Promise<T>,
): Promise<T> {
  const { token } = z.object({ token: z.string().min(1) }).parse(
    await active.broker.request("input.reserve", { kind: "profile", operation }),
  )
  return await runFenced(token, fence(active), async(begun) => {
    if (begun.kind !== "profile") throw new FenceRefusal("Expected a profile change")
    const progress = new ProfileProgress()
    try {
      return await change(progress)
    } catch(cause) {
      throw profileFailure(cause, progress)
    }
  })
}

const CLOSING_MESSAGE = "Managed browser service is closing"
/** In-flight `/inspect` reads, which run outside the queue. */
const reads = new Set<Promise<unknown>>()
let closing = false
/** Set when the browser outlived its forced close: a terminal state that a retry cannot change. */
let survivor: string | null = null

/**
 * Close this service's own browser and keep its profile. Runs at the head of the queue and refuses
 * every later request, waits for running reads, then asks the extension to admit the close. Only a
 * definite refusal (another agent, a lease, input or an uncertain state) reopens the service. A
 * lost answer may mean the extension is closing, so the service stays closed to new work and only
 * a repeated `/shutdown` can reconcile it; the extension admits a repeated close idempotently.
 */
async function closeBrowser() {
  if (!browser || browser.exited) throw new Error("Managed browser is not running")
  if (survivor) throw new Error(survivor)
  const active = browser
  closing = true
  try {
    await Promise.allSettled([...reads])
    const result = await shutdownBrowser(active)
    return { ...result, browserPid: active.browserPid, profile: options.profile, temporary: options.temporary === true }
  } catch(cause) {
    if (cause instanceof BrokerRefusal && !active.exited) closing = false
    throw cause
  }
}

const server = createServer((req, res) => void respond(req, res))

async function respond(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST" || req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(403).end()
    return
  }
  try {
    let body = ""
    req.setEncoding("utf8")
    for await (const chunk of req as AsyncIterable<string>) {
      body += chunk
      if (body.length > 64 * 1024) throw new Error("Request too large")
    }
    const params: unknown = JSON.parse(body)
    const running = () => {
      if (!browser || browser.exited) throw new Error("Managed browser is not running")
      return browser
    }
    const action = async() => {
      switch (req.url) {
        case "/status":
          return record()
        case "/ensure":
          return await ensure()
        case "/extensionList":
          await ensure()
          return await extensionList(running())
        case "/extensionInstall":
        case "/extensionRemove": {
          const method = req.url
          const prepared = await prepareExtension(method, params)
          await ensure()
          const active = running()
          return await profileChange(active, { method, params }, async(progress) =>
            await extensionAction(active, prepared, method, progress))
        }
        case "/extensionConfigure": {
          const request = ConfigureParamsSchema.parse(params)
          const { ready, skipped } = await resolveConfiguredExtensions(request.paths, resolveExtensionDirectory)
          await ensure()
          const active = running()
          return await profileChange(active, { method: req.url, paths: request.paths }, async(progress) =>
            await configureExtensions(active, ready, progress, skipped))
        }
        case "/cdp":
        case "/input": {
          const { token: fenceToken } = InputParamsSchema.parse(params)
          return await runPipe(running(), fenceToken, req.url === "/cdp" ? "cdp" : "input")
        }
        case "/gesture": {
          const request = GestureParamsSchema.parse(params)
          const active = running()
          if (request.action === "bind") {
            await bindGesture(active, request.tabId, request.targetId)
            return {}
          }
          if (request.action === "release") {
            // Only a tab this service drives over the pipe; the extension removes its own cursors.
            const targetId = [...pipeTabs].find(([, tabId]) => tabId === request.tabId)?.[0]
            if (targetId !== undefined) {
              const sessionId = await active.cdp.session(targetId)
              await removeCursor((method, commandParams) => active.cdp.send(method, commandParams, sessionId))
            }
            return {}
          }
          if (!gestureExecutor) throw new Error("Gesture executor is not initialized")
          if (request.action === "run") return await gestureExecutor.run(request.token)
          return await gestureExecutor.cleanup()
        }
        case "/output": {
          const query = OutputQuerySchema.parse(params)
          if (!diagnostics) throw new Error("No Managed process diagnostics available")
          return diagnostics.read(query)
        }
        default:
          throw new Error("Unknown Managed service method")
      }
    }
    // A repeated `/shutdown` is admitted: it reconciles a close whose admission answer was lost.
    const refuseWhileClosing = () => {
      if (closing && !["/output", "/shutdown", "/status"].includes(req.url ?? "")) throw new Error(CLOSING_MESSAGE)
    }
    // Checked on arrival, so work refuses at once instead of queueing behind the close, and again
    // at the head of the queue, for work that arrived before the close began.
    refuseWhileClosing()
    const admitted = (run: () => Promise<unknown>) => async() => {
      refuseWhileClosing()
      return await run()
    }
    const inspect = async() => {
      const active = running()
      return { result: await runInspect(active.broker, active.cdp, InputParamsSchema.parse(params).token) }
    }
    let result: Promise<unknown>
    if (req.url === "/inspect") {
      // Reads skip the queue; a close waits for the ones already running.
      result = admitted(inspect)()
      reads.add(result)
      void result.catch(() => undefined).finally(() => reads.delete(result))
    } else {
      // Teardown stays in the queue, so a repeated `/shutdown` cannot interleave with it. A browser
      // that already exited needs no close admission: its process is gone, so finish the service.
      result = queue.then(admitted(req.url === "/shutdown" ? async() => {
        const active = browser
        if (active !== undefined && active.exited) {
          const exit = await active.waitForExit(0)
          if (exit === null) throw new Error("Managed browser exited without an exit status")
          const cleanupError = await active.close().then(
            () => null,
            (cause: unknown) => errorMessage(cause),
          )
          return await finishShutdown({
            browserPid: active.browserPid,
            clean: exit.code === 0 && exit.signal === null && cleanupError === null,
            cleanupError,
            exited: true,
            exitCode: exit.code,
            forced: false,
            profile: options.profile,
            signal: exit.signal,
            temporary: options.temporary === true,
          })
        }
        return await finishShutdown(await closeBrowser())
      } : action))
      queue = result.catch(() => undefined)
    }
    const reply = await result
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify(reply))
    if (req.url === "/shutdown") server.closeAllConnections()
  } catch(cause) {
    res
      .writeHead(500, { "content-type": "application/json" })
      .end(JSON.stringify({ error: errorMessage(cause) }))
  }
}

/**
 * Tear the service down before `/shutdown` answers, so the reply is the outcome: no new connection
 * is accepted, the descriptor says the service ended, and its runtime directory is gone. A rejoin
 * after the reply starts a new service. A browser that is still running keeps this service alive
 * and closed to new work instead. Each failed step is reported, never hidden.
 */
async function finishShutdown(result: Awaited<ReturnType<typeof closeBrowser>>) {
  if (!result.exited) {
    survivor = `Managed browser process ${result.browserPid} is still running after Browser.close and a forced stop of its own child; the service stays closed and keeps the profile lock. Inspect that process manually; the service finishes its teardown once it exits`
    throw new Error(survivor)
  }
  stopping = true
  clearInterval(watch)
  const teardown: string[] = []
  // Stop accepting now; the `/shutdown` connection itself closes after its reply.
  server.close()
  server.closeIdleConnections()
  await publish(0).catch((cause: unknown) => teardown.push(`descriptor: ${errorMessage(cause)}`))
  await rm(directory, { force: true, recursive: true })
    .catch((cause: unknown) => teardown.push(`runtime directory: ${errorMessage(cause)}`))
  return { ...result, clean: result.clean && teardown.length === 0, teardownErrors: teardown }
}

/**
 * Stop on a signal. A running browser closes only through the same admitted close as `/shutdown`:
 * a refused or lost admission (for example an unresolved held gesture) keeps the browser, service,
 * descriptor and runtime directory, and a repeated signal retries. Without a running browser the
 * service cleans up as before.
 */
async function shutdown(): Promise<void> {
  if (stopping) return
  const admitted = queue.then(async() => browser && !browser.exited ? await finishShutdown(await closeBrowser()) : null)
  queue = admitted.catch(() => undefined)
  try {
    if (await admitted !== null) {
      server.closeAllConnections()
      return
    }
  } catch(cause) {
    process.stderr.write(`Managed browser service kept running after a stop signal: ${errorMessage(cause)}\n`)
    return
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- another signal can set this while awaiting the queue
  if (stopping) return
  stopping = true
  clearInterval(watch)
  await browser?.close()
  // Mark clean shutdown so later PID reuse cannot block rediscovery.
  await publish(0)
  server.close()
  server.closeAllConnections()
  await rm(directory, { force: true, recursive: true })
}

// Keep exit diagnostics briefly available; a later use can restart the same profile.
const watch = setInterval(() => {
  if (browser && !browser.exited) return
  exitedAt ??= Date.now()
  if (Date.now() - exitedAt > 60_000) void shutdown()
}, 1_000)
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void shutdown())
try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, resolve)
  })
  await chmod(socketPath, 0o600)
  await publish()
  process.send?.(record())
} catch(cause) {
  process.send?.({ error: errorMessage(cause) })
  await shutdown()
}
