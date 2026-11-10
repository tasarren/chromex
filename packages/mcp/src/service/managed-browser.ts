import { type ChildProcess, spawn } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { once } from "node:events"
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, delimiter, dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  configHome,
  EXTENSION_ORIGIN,
  errorMessage,
  hasDisplayEnv,
  MANAGED_ENVIRONMENT_FILE,
  MANAGED_ENVIRONMENT_KEYS,
  NATIVE_HOST_NAME,
} from "@chromex/protocol"
import { z } from "zod"
import { BrokerStatusSchema } from "../shared/schema.ts"
import { BrokerClient, BrokerRefusal } from "../shared/broker-client.ts"
import { CONFIG_PATH_ENV, SERVICE_KEY_ENV } from "../shared/env.ts"
import { CdpPipe } from "./cdp-pipe.ts"
import { ExtensionList } from "../shared/extension-list.ts"
import { ManagedProcessOutputCapture, type ManagedProcessOutputSource } from "../shared/process-output.ts"
import { acquireProfileLock, isErrno } from "../shared/profile-lock.ts"
import type { BrowserOptions } from "../server/session-browser.ts"
import { type Workspace, workspaceStorage } from "../shared/workspace.ts"

const PROFILE_NAME = /^[A-Za-z0-9._-]{1,64}$/
const OWNERSHIP_FLAG =
  /^--(?:user-data-dir|load-extension|disable-extensions-except|remote-debugging(?:-[A-Za-z0-9-]+)?)(?:=|\s|$)/
const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url))

/** Persistent storage and locks are scoped by `workspace`; a temporary profile lives in runtime storage. */
export type ManagedLaunchOptions = Pick<BrowserOptions, "profile" | "temporary"> & { workspace: Workspace }

type ManagedBrowserDependencies = {
  browserPath?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  extensionPath?: string | undefined;
  managedEnvironmentPath?: string | undefined;
  nativeHostPath?: string | undefined;
  ready?: ((broker: BrokerClient, child: ChildProcess) => Promise<void>) | undefined;
  shutdownGraceMs?: number | undefined;
}

export class ManagedBrowser {
  readonly broker: BrokerClient
  readonly browserPid: number
  /** Browser-level CDP; only this process holds the pipe. */
  readonly cdp: CdpPipe
  readonly configPath: string
  readonly diagnostics: ManagedProcessOutputSource
  readonly extensions: ExtensionList
  readonly profile: string
  readonly profileDirectory: string
  readonly runtimeDirectory: string
  readonly temporary: boolean
  private closePromise: Promise<void> | null = null
  private readonly child: ChildProcess
  private readonly nativeManifestPath: string
  private readonly releaseLock: () => Promise<void>
  private readonly shutdownGraceMs: number

  private constructor(
    broker: BrokerClient,
    child: ChildProcess,
    releaseLock: () => Promise<void>,
    details: {
      cdp: CdpPipe;
      configPath: string;
      extensions: ExtensionList;
      profile: string;
      profileDirectory: string;
      runtimeDirectory: string;
      shutdownGraceMs: number;
      temporary: boolean;
      nativeManifestPath: string;
      diagnostics: ManagedProcessOutputSource;
    },
  ) {
    if (child.pid === undefined) throw new Error("Chromium started without a process ID")
    this.child = child
    this.releaseLock = releaseLock
    this.broker = broker
    this.browserPid = child.pid
    this.cdp = details.cdp
    this.configPath = details.configPath
    this.extensions = details.extensions
    this.diagnostics = details.diagnostics
    this.profile = details.profile
    this.profileDirectory = details.profileDirectory
    this.runtimeDirectory = details.runtimeDirectory
    this.shutdownGraceMs = details.shutdownGraceMs
    this.temporary = details.temporary
    this.nativeManifestPath = details.nativeManifestPath
  }

  static async launch(
    options: ManagedLaunchOptions,
    dependencies: ManagedBrowserDependencies = {},
  ): Promise<ManagedBrowser> {
    const env = await resolveManagedEnvironment(
      dependencies.env ?? process.env,
      dependencies.managedEnvironmentPath ?? join(MODULE_DIRECTORY, MANAGED_ENVIRONMENT_FILE),
    )
    const headless = env.CHROMEX_HEADLESS === "1"
    if (!headless) assertGraphicalEnvironment(env)
    const profile = validateProfileName(options.profile ?? "default")
    const temporary = options.temporary === true
    const sessionId = randomUUID()
    const runtimeRoot = join(env.XDG_RUNTIME_DIR || tmpdir(), "chromex")
    const sessionsRoot = join(runtimeRoot, "sessions")
    await mkdir(sessionsRoot, { mode: 0o700, recursive: true })
    const runtimeDirectory = await mkdtemp(join(sessionsRoot, "session-"))
    await chmod(runtimeDirectory, 0o700)

    const dataHome = managedDataHome(env)
    let profileDirectory = join(runtimeDirectory, "profile")
    let releaseLock = async() => {}
    let child: ChildProcess | null = null
    let broker: BrokerClient | null = null
    let diagnostics: ManagedProcessOutputCapture | null = null
    let nativeManifestPath: string | null = null

    try {
      if (!temporary) {
        // The marker is checked before the lock or profile is touched.
        const storage = await workspaceStorage(options.workspace, dataHome)
        releaseLock = await acquireProfileLock(join(storage.locks, `${profile}.lock`), sessionId, process.pid)
        profileDirectory = join(storage.profiles, profile)
      }
      await mkdir(profileDirectory, { mode: 0o700, recursive: true })

      const browserPath = await resolveBrowserPath(dependencies.browserPath, env)
      assertSupportedBrowser(browserPath)
      const extensionPath = resolve(
        dependencies.extensionPath ??
          env.CHROMEX_EXTENSION_PATH ??
          join(MODULE_DIRECTORY, "extension"),
      )
      const nativeHostPath = resolve(
        dependencies.nativeHostPath ?? join(MODULE_DIRECTORY, "native-host.mjs"),
      )
      await Promise.all([access(extensionPath), access(nativeHostPath)])
      const extensions = new ExtensionList(profileDirectory)

      const privateConfigHome = join(runtimeDirectory, "config")
      const sourceConfigHome = configHome(env, env.HOME || homedir())
      await copyChromiumFlags(sourceConfigHome, privateConfigHome)

      const socketPath = join(runtimeDirectory, "bridge.sock")
      const configPath = join(runtimeDirectory, "bridge-config.json")
      const bridgeToken = randomBytes(32).toString("hex")
      // The service role credential stays in the service process and its private launcher, never
      // in the shared bridge config that agents read.
      const serviceKey = randomBytes(32).toString("hex")
      await writePrivateFile(
        configPath,
        `${JSON.stringify({
          extensionOrigin: EXTENSION_ORIGIN,
          managed: true,
          socketPath,
          token: bridgeToken,
        })}\n`,
      )
      const launcherPath = join(runtimeDirectory, "native-host-launcher.mjs")
      await writePrivateFile(
        launcherPath,
        `#!${process.execPath}\nprocess.env.${CONFIG_PATH_ENV} = ${JSON.stringify(configPath)};\nprocess.env.${SERVICE_KEY_ENV} = ${JSON.stringify(serviceKey)};\nawait import(${JSON.stringify(pathToFileURL(nativeHostPath).href)});\n`,
      )
      await chmod(launcherPath, 0o700)
      nativeManifestPath = await writeNativeManifests(
        privateConfigHome,
        profileDirectory,
        launcherPath,
      )

      const browserArguments = [
        `--user-data-dir=${profileDirectory}`,
        `--load-extension=${[extensionPath, ...(await extensions.present())].join(",")}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-mode",
        "--remote-debugging-pipe",
        "--enable-unsafe-extension-debugging",
        // No startup window: the extension creates the first one unfocused on demand, so launching
        // Managed Chromium does not take focus from the foreground application.
        "--no-startup-window",
        // One CSS pixel per screenshot pixel regardless of desktop DPI (ISS-17).
        "--force-device-scale-factor=1",
        // Test runs only: headless with a desktop-sized window (default 800 px clips wheel hit
        // testing on wider emulated viewports), and no sandbox in a capability-less CI container.
        ...(headless ? ["--headless", "--window-size=1920,1080"] : []),
        ...(headless && env.CI ? ["--no-sandbox"] : []),
      ]
      const processDiagnostics = new ManagedProcessOutputCapture(browserPath, browserArguments, [
        bridgeToken,
        serviceKey,
      ])
      diagnostics = processDiagnostics
      child = spawn(browserPath, browserArguments, {
        env: {
          ...env,
          [CONFIG_PATH_ENV]: configPath,
          XDG_CONFIG_HOME: privateConfigHome,
        },
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
      })
      processDiagnostics.attach(child)
      const cdp = new CdpPipe(child)
      broker = new BrokerClient({ configPath, mode: "managed", serviceKey })
      await (
        dependencies.ready ??
        ((activeBroker, activeChild) =>
          waitForBridge(activeBroker, activeChild, processDiagnostics))
      )(broker, child)

      return new ManagedBrowser(broker, child, releaseLock, {
        cdp,
        configPath,
        extensions,
        profile,
        profileDirectory,
        runtimeDirectory,
        shutdownGraceMs: dependencies.shutdownGraceMs ?? 3_000,
        temporary,
        nativeManifestPath,
        diagnostics: processDiagnostics,
      })
    } catch(cause) {
      await broker?.close()
      if (child) await terminateChild(child)
      await diagnostics?.waitForDrain()
      if (nativeManifestPath) await rm(nativeManifestPath, { force: true })
      await releaseLock()
      await rm(runtimeDirectory, { force: true, recursive: true })
      if (diagnostics) {
        diagnostics.markFailed()
        throw new ManagedBrowserLaunchError(errorMessage(cause), diagnostics)
      }
      throw cause
    }
  }

  get exited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null
  }

  /** The child's exit status once it exits within the timeout; `null` while it still runs. */
  async waitForExit(timeoutMs: number): Promise<ExitStatus | null> {
    if (!(await waitForChildExit(this.child, timeoutMs))) return null
    return { code: this.child.exitCode, signal: this.child.signalCode }
  }

  async ensureBridge(): Promise<void> {
    await waitForBridge(this.broker, this.child)
  }

  /** A failed cleanup can be retried: every step is idempotent, and a success is cached. */
  close(): Promise<void> {
    this.closePromise ??= this.closeNow().catch((cause: unknown) => {
      this.closePromise = null
      throw cause
    })
    return this.closePromise
  }

  private async closeNow(): Promise<void> {
    await this.broker.close()
    if (!(await waitForChildExit(this.child, this.shutdownGraceMs))) {
      await terminateChild(this.child)
    }
    await rm(this.nativeManifestPath, { force: true })
    await this.releaseLock()
    await rm(this.runtimeDirectory, { force: true, recursive: true })
  }
}

export type ExitStatus = { readonly code: number | null; readonly signal: NodeJS.Signals | null }

export type BrowserShutdown = {
  /** Chromium exited by itself with code 0 after `Browser.close`, nothing was signalled and cleanup finished. */
  readonly clean: boolean
  /** Chromium did not exit in time, so `close()` signalled this process's own child. */
  readonly forced: boolean
  /** The final status; `exited: false` means the child was still running after cleanup. */
  readonly exited: boolean
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  /** The cleanup step that still failed after one retry; the browser itself may be gone. */
  readonly cleanupError: string | null
}

type ShutdownTarget = {
  readonly broker: { request(method: string, params?: Record<string, unknown>): Promise<unknown> }
  readonly cdp: { send(method: string): Promise<unknown> }
  close(): Promise<void>
  waitForExit(timeoutMs: number): Promise<ExitStatus | null>
}

const BROWSER_EXIT_MS = 15_000

/**
 * Close the service's own browser so its profile data is flushed and kept. The extension first
 * admits the close: it refuses while any client, lease, input or inspection remains, and that
 * `BrokerRefusal` is rethrown with nothing changed. A lost or late answer is not a refusal: the
 * extension may be closing, so the error says the admission is uncertain. Only the exit Chromium
 * reports by itself counts as clean; when it does not exit in time, `close()` stops this process's
 * own child handle, and `forced` plus the final status say so.
 */
export async function shutdownBrowser(
  browser: ShutdownTarget,
  exitTimeoutMs = BROWSER_EXIT_MS,
): Promise<BrowserShutdown> {
  try {
    await browser.broker.request("bridge.close")
  } catch(cause) {
    if (cause instanceof BrokerRefusal) throw cause
    throw new Error(`Close admission is uncertain (${errorMessage(cause)}); retry the shutdown`, { cause })
  }
  // The pipe can close before Chromium answers; the exit status below is the evidence.
  await browser.cdp.send("Browser.close").catch(() => undefined)
  const exit = await browser.waitForExit(exitTimeoutMs)
  // Every close() step is idempotent, so one retry can finish a cleanup a transient error stopped.
  const cleanupError = await browser.close().then(
    () => null,
    async() => await browser.close().then(() => null, (cause: unknown) => errorMessage(cause)),
  )
  const final = exit ?? (await browser.waitForExit(0))
  return {
    clean: exit !== null && exit.code === 0 && exit.signal === null && cleanupError === null,
    cleanupError,
    exitCode: final?.code ?? null,
    exited: final !== null,
    forced: exit === null,
    signal: final?.signal ?? null,
  }
}

export async function resolveManagedEnvironment(
  current: NodeJS.ProcessEnv,
  snapshotPath: string,
): Promise<NodeJS.ProcessEnv> {
  const resolved = { ...current }
  let snapshot: unknown
  try {
    snapshot = JSON.parse(await readFile(snapshotPath, "utf8"))
  } catch {
    return resolved
  }
  const values = z.record(z.string(), z.unknown()).safeParse(snapshot)
  if (!values.success) return resolved
  for (const key of MANAGED_ENVIRONMENT_KEYS) {
    const value = values.data[key]
    if (!resolved[key] && typeof value === "string" && value.length > 0) resolved[key] = value
  }
  return resolved
}

function assertGraphicalEnvironment(env: NodeJS.ProcessEnv): void {
  if (hasDisplayEnv(env)) return
  throw new Error(
    "Managed Chromium has no graphical display environment. Re-run pnpm install:local from the graphical Linux session, or configure the MCP harness to forward DISPLAY or WAYLAND_DISPLAY.",
  )
}

export class ManagedBrowserLaunchError extends Error {
  readonly summary: string
  readonly diagnostics: ManagedProcessOutputSource

  constructor(summary: string, diagnostics: ManagedProcessOutputSource) {
    super(diagnostics.failureMessage(summary))
    this.name = "ManagedBrowserLaunchError"
    this.summary = summary
    this.diagnostics = diagnostics
  }
}

export function validateProfileName(profile: string): string {
  if (!PROFILE_NAME.test(profile) || profile === "." || profile === "..") {
    throw new Error(
      "Managed profile name must be 1-64 letters, numbers, dots, underscores, or dashes",
    )
  }
  return profile
}

export function managedDataHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local/share")
}

export function findConflictingChromiumFlag(contents: string): string | null {
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length > 0 && !line.startsWith("#") && OWNERSHIP_FLAG.test(line)) return line
  }
  return null
}

export async function copyChromiumFlags(
  sourceConfigHome: string,
  targetConfigHome: string,
): Promise<boolean> {
  let contents: string
  try {
    contents = await readFile(join(sourceConfigHome, "chromium-flags.conf"), "utf8")
  } catch(cause) {
    if (isErrno(cause, "ENOENT")) return false
    throw cause
  }
  const conflict = findConflictingChromiumFlag(contents)
  if (conflict) {
    throw new Error(`chromium-flags.conf contains a Managed-session ownership flag: ${conflict}`)
  }
  await mkdir(targetConfigHome, { mode: 0o700, recursive: true })
  await writeFile(join(targetConfigHome, "chromium-flags.conf"), contents, { mode: 0o600 })
  return true
}

async function waitForBridge(
  broker: BrokerClient,
  child: ChildProcess,
  diagnostics?: ManagedProcessOutputCapture,
): Promise<void> {
  const deadline = Date.now() + 15_000
  let lastError: unknown = new Error("Chromex extension did not connect")
  while (Date.now() < deadline) {
    if (diagnostics?.launchError) {
      throw new Error(`Managed Chromium could not start: ${diagnostics.launchError}`)
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Managed Chromium exited before the Chromex extension connected")
    }
    try {
      const status = BrokerStatusSchema.parse(await broker.request("broker.status", {}, 1_000))
      if (status.extension) return
    } catch(cause) {
      lastError = cause
    }
    await delay(100)
  }
  throw new Error(
    `Managed Chromium did not connect to Chromex: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

async function resolveBrowserPath(
  override: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const requested = override ?? env.CHROMEX_BROWSER
  if (requested) {
    const path = resolve(requested)
    await access(path, 0o1)
    return path
  }
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue
    for (const name of ["chromium", "chromium-browser", "chrome-for-testing"]) {
      const path = join(directory, name)
      try {
        await access(path, 0o1)
        return path
      } catch {
        // Not an executable here; try the next candidate.
      }
    }
  }
  throw new Error("Chromium was not found. Set CHROMEX_BROWSER to its executable path.")
}

function assertSupportedBrowser(browserPath: string): void {
  const name = basename(browserPath).toLowerCase()
  if (name.includes("chromium") || name.includes("chrome-for-testing")) return
  throw new Error(
    "Managed mode requires Chromium or Chrome for Testing; Chrome-branded builds block unpacked command-line extensions",
  )
}

async function writeNativeManifests(
  configHome: string,
  profileDirectory: string,
  launcherPath: string,
): Promise<string> {
  const contents = `${JSON.stringify({
    allowed_origins: [EXTENSION_ORIGIN],
    description: "Private native host for one Chromex managed session",
    name: NATIVE_HOST_NAME,
    path: launcherPath,
    type: "stdio",
  })}\n`
  const profileManifestPath = join(
    profileDirectory,
    "NativeMessagingHosts",
    `${NATIVE_HOST_NAME}.json`,
  )
  const directories = [
    dirname(profileManifestPath),
    ...["chromium", "google-chrome"].map((browserDirectory) =>
      join(configHome, browserDirectory, "NativeMessagingHosts"),
    ),
  ]
  for (const directory of directories) {
    await mkdir(directory, { mode: 0o700, recursive: true })
    await writePrivateFile(join(directory, `${NATIVE_HOST_NAME}.json`), contents)
  }
  return profileManifestPath
}

async function writePrivateFile(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: 0o600 })
  await chmod(path, 0o600)
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || hasExited(child)) return
  const closed = once(child, "close")
  child.kill("SIGTERM")
  const graceful = await Promise.race([
    closed.then(() => true),
    delay(3_000, false, { ref: false }),
  ])
  if (graceful || hasExited(child)) return
  const killed = once(child, "close")
  child.kill("SIGKILL")
  // A child that survives SIGKILL (for example, stuck in the kernel) is reported, not awaited forever.
  const gone = await Promise.race([killed.then(() => true), delay(5_000, false, { ref: false })])
  if (!gone && !hasExited(child)) throw new Error(`Chromium process ${child.pid} did not exit after SIGKILL`)
}

/** Reads live child state; a call after an await is not narrowed by an earlier check. */
function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return true
  if (timeoutMs <= 0) return false
  return await new Promise<boolean>((resolveExit) => {
    const onClose = () => { finish(true) }
    const timer = setTimeout(() => { finish(false) }, timeoutMs)
    timer.unref()
    child.once("close", onClose)
    function finish(exited: boolean) {
      clearTimeout(timer)
      child.off("close", onClose)
      resolveExit(exited)
    }
  })
}
