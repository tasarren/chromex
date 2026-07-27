import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXTENSION_ORIGIN, errorMessage, NATIVE_HOST_NAME } from "../protocol/schema.js";
import { BrokerClient } from "./broker-client.js";
import { ManagedProcessOutputCapture, type ManagedProcessOutputSource } from "./process-output.js";

const PROFILE_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const OWNERSHIP_FLAG =
  /^--(?:user-data-dir|load-extension|disable-extensions-except|remote-debugging(?:-[A-Za-z0-9-]+)?)(?:=|\s|$)/;
const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const MANAGED_ENVIRONMENT_FILE = "managed-environment.json";

export const MANAGED_ENVIRONMENT_KEYS = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
] as const;

type LockOwner = { pid: number; sessionId: string };

export type ManagedLaunchOptions = {
  profile?: string | undefined;
  projectPath: string;
  temporary?: boolean | undefined;
};

export type ManagedBrowserDependencies = {
  browserPath?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  extensionPath?: string | undefined;
  managedEnvironmentPath?: string | undefined;
  nativeHostPath?: string | undefined;
  ready?: ((broker: BrokerClient, child: ChildProcess) => Promise<void>) | undefined;
  shutdownGraceMs?: number | undefined;
};

export class ManagedBrowser {
  readonly broker: BrokerClient;
  readonly browserPid: number;
  readonly configPath: string;
  readonly diagnostics: ManagedProcessOutputSource;
  readonly profile: string;
  readonly profileDirectory: string;
  readonly projectKey: string;
  readonly registryPath: string;
  readonly runtimeDirectory: string;
  readonly temporary: boolean;
  private closePromise: Promise<void> | null = null;
  private readonly nativeManifestPath: string;
  private readonly shutdownGraceMs: number;

  private constructor(
    broker: BrokerClient,
    private readonly child: ChildProcess,
    private readonly releaseLock: () => Promise<void>,
    details: {
      configPath: string;
      profile: string;
      profileDirectory: string;
      projectKey: string;
      registryPath: string;
      runtimeDirectory: string;
      shutdownGraceMs: number;
      temporary: boolean;
      nativeManifestPath: string;
      diagnostics: ManagedProcessOutputSource;
    },
  ) {
    if (child.pid === undefined) throw new Error("Chromium started without a process ID");
    this.broker = broker;
    this.browserPid = child.pid;
    this.configPath = details.configPath;
    this.diagnostics = details.diagnostics;
    this.profile = details.profile;
    this.profileDirectory = details.profileDirectory;
    this.projectKey = details.projectKey;
    this.registryPath = details.registryPath;
    this.runtimeDirectory = details.runtimeDirectory;
    this.shutdownGraceMs = details.shutdownGraceMs;
    this.temporary = details.temporary;
    this.nativeManifestPath = details.nativeManifestPath;
  }

  static async launch(
    options: ManagedLaunchOptions,
    dependencies: ManagedBrowserDependencies = {},
  ): Promise<ManagedBrowser> {
    const env = await resolveManagedEnvironment(
      dependencies.env ?? process.env,
      dependencies.managedEnvironmentPath ?? join(MODULE_DIRECTORY, MANAGED_ENVIRONMENT_FILE),
    );
    assertGraphicalEnvironment(env);
    const projectPath = await realpath(resolve(options.projectPath));
    const projectKey = managedProjectKey(projectPath);
    const profile = validateProfileName(options.profile ?? "default");
    const temporary = options.temporary === true;
    const sessionId = randomUUID();
    const runtimeRoot = join(env.XDG_RUNTIME_DIR || tmpdir(), "chromex");
    const sessionsRoot = join(runtimeRoot, "sessions");
    await mkdir(sessionsRoot, { mode: 0o700, recursive: true });
    const runtimeDirectory = await mkdtemp(join(sessionsRoot, "session-"));
    await chmod(runtimeDirectory, 0o700);

    const dataHome = env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local/share");
    const profileDirectory = temporary
      ? join(runtimeDirectory, "profile")
      : join(dataHome, "chromex/profiles", projectKey, profile);
    const lockPath = join(dataHome, "chromex/locks", projectKey, `${profile}.lock`);
    let releaseLock = async () => {};
    let child: ChildProcess | null = null;
    let broker: BrokerClient | null = null;
    let diagnostics: ManagedProcessOutputCapture | null = null;
    let nativeManifestPath: string | null = null;
    const registryDirectory = join(runtimeRoot, "registry");
    const registryPath = join(registryDirectory, `${sessionId}.json`);

    try {
      if (!temporary) releaseLock = await acquireProfileLock(lockPath, sessionId, process.pid);
      await mkdir(profileDirectory, { mode: 0o700, recursive: true });

      const browserPath = await resolveBrowserPath(dependencies.browserPath, env);
      assertSupportedBrowser(browserPath);
      const extensionPath = resolve(
        dependencies.extensionPath ??
          env.CHROMEX_EXTENSION_PATH ??
          join(MODULE_DIRECTORY, "extension"),
      );
      const nativeHostPath = resolve(
        dependencies.nativeHostPath ?? join(MODULE_DIRECTORY, "native-host.mjs"),
      );
      await Promise.all([access(extensionPath), access(nativeHostPath)]);

      const privateConfigHome = join(runtimeDirectory, "config");
      const sourceConfigHome = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
      await copyChromiumFlags(sourceConfigHome, privateConfigHome);

      const socketPath = join(runtimeDirectory, "bridge.sock");
      const configPath = join(runtimeDirectory, "bridge-config.json");
      const bridgeToken = randomBytes(32).toString("hex");
      await writePrivateFile(
        configPath,
        `${JSON.stringify({
          extensionOrigin: EXTENSION_ORIGIN,
          managed: true,
          socketPath,
          token: bridgeToken,
        })}\n`,
      );
      const launcherPath = join(runtimeDirectory, "native-host-launcher.mjs");
      await writePrivateFile(
        launcherPath,
        `#!${process.execPath}\nprocess.env.CHROME_BROWSER_BRIDGE_CONFIG = ${JSON.stringify(configPath)};\nawait import(${JSON.stringify(pathToFileURL(nativeHostPath).href)});\n`,
      );
      await chmod(launcherPath, 0o700);
      nativeManifestPath = await writeNativeManifests(
        privateConfigHome,
        profileDirectory,
        launcherPath,
      );

      const browserArguments = [
        `--user-data-dir=${profileDirectory}`,
        `--load-extension=${extensionPath}`,
        `--disable-extensions-except=${extensionPath}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-mode",
        "--new-window",
        "about:blank",
      ];
      const processDiagnostics = new ManagedProcessOutputCapture(browserPath, browserArguments, [
        bridgeToken,
      ]);
      diagnostics = processDiagnostics;
      child = spawn(browserPath, browserArguments, {
        env: {
          ...env,
          CHROME_BROWSER_BRIDGE_CONFIG: configPath,
          XDG_CONFIG_HOME: privateConfigHome,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      processDiagnostics.attach(child);
      broker = new BrokerClient({ configPath, mode: "managed" });
      await (
        dependencies.ready ??
        ((activeBroker, activeChild) =>
          waitForBridge(activeBroker, activeChild, processDiagnostics))
      )(broker, child);

      await mkdir(registryDirectory, { mode: 0o700, recursive: true });
      await writePrivateFile(
        registryPath,
        `${JSON.stringify({
          browserPid: child.pid,
          clientId: broker.clientId,
          configPath,
          profile,
          projectKey,
          projectLabel: basename(projectPath),
          sessionId,
          socketPath,
          startedAt: new Date().toISOString(),
          temporary,
        })}\n`,
      );

      return new ManagedBrowser(broker, child, releaseLock, {
        configPath,
        profile,
        profileDirectory,
        projectKey,
        registryPath,
        runtimeDirectory,
        shutdownGraceMs: dependencies.shutdownGraceMs ?? 3_000,
        temporary,
        nativeManifestPath,
        diagnostics: processDiagnostics,
      });
    } catch (cause) {
      await broker?.close();
      if (child) await terminateChild(child);
      await diagnostics?.waitForDrain();
      await rm(registryPath, { force: true });
      if (nativeManifestPath) await rm(nativeManifestPath, { force: true });
      await releaseLock();
      await rm(runtimeDirectory, { force: true, recursive: true });
      if (diagnostics) {
        diagnostics.markFailed();
        throw new ManagedBrowserLaunchError(errorMessage(cause), diagnostics);
      }
      throw cause;
    }
  }

  get exited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  async ensureBridge(): Promise<void> {
    await waitForBridge(this.broker, this.child);
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeNow();
    return this.closePromise;
  }

  private async closeNow(): Promise<void> {
    await this.broker.close();
    if (!(await waitForChildExit(this.child, this.shutdownGraceMs))) {
      await terminateChild(this.child);
    }
    await rm(this.registryPath, { force: true });
    await rm(this.nativeManifestPath, { force: true });
    await this.releaseLock();
    await rm(this.runtimeDirectory, { force: true, recursive: true });
  }
}

export async function resolveManagedEnvironment(
  current: NodeJS.ProcessEnv,
  snapshotPath: string,
): Promise<NodeJS.ProcessEnv> {
  const resolved = { ...current };
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  } catch {
    return resolved;
  }
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return resolved;
  const values = snapshot as Record<string, unknown>;
  for (const key of MANAGED_ENVIRONMENT_KEYS) {
    const value = values[key];
    if (!resolved[key] && typeof value === "string" && value.length > 0) resolved[key] = value;
  }
  return resolved;
}

function assertGraphicalEnvironment(env: NodeJS.ProcessEnv): void {
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return;
  throw new Error(
    "Managed Chromium has no graphical display environment. Re-run pnpm install:local from the graphical Linux session, or configure the MCP harness to forward DISPLAY or WAYLAND_DISPLAY.",
  );
}

export class ManagedBrowserLaunchError extends Error {
  constructor(
    readonly summary: string,
    readonly diagnostics: ManagedProcessOutputSource,
  ) {
    super(diagnostics.failureMessage(summary));
    this.name = "ManagedBrowserLaunchError";
  }
}

export function managedProjectKey(projectPath: string): string {
  const label = basename(projectPath).replace(/[^A-Za-z0-9._-]+/g, "-") || "project";
  const digest = createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
  return `${label}-${digest}`;
}

export function validateProfileName(profile: string): string {
  if (!PROFILE_NAME.test(profile) || profile === "." || profile === "..") {
    throw new Error(
      "Managed profile name must be 1-64 letters, numbers, dots, underscores, or dashes",
    );
  }
  return profile;
}

export function findConflictingChromiumFlag(contents: string): string | null {
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length > 0 && !line.startsWith("#") && OWNERSHIP_FLAG.test(line)) return line;
  }
  return null;
}

export async function copyChromiumFlags(
  sourceConfigHome: string,
  targetConfigHome: string,
): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(join(sourceConfigHome, "chromium-flags.conf"), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
  const conflict = findConflictingChromiumFlag(contents);
  if (conflict) {
    throw new Error(`chromium-flags.conf contains a Managed-session ownership flag: ${conflict}`);
  }
  await mkdir(targetConfigHome, { mode: 0o700, recursive: true });
  await writeFile(join(targetConfigHome, "chromium-flags.conf"), contents, { mode: 0o600 });
  return true;
}

export async function acquireProfileLock(
  lockPath: string,
  sessionId: string,
  pid: number,
): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { mode: 0o700, recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid, sessionId }), {
        mode: 0o600,
      });
      return async () => {
        const owner = await readLockOwner(lockPath);
        if (owner?.sessionId === sessionId) await rm(lockPath, { force: true, recursive: true });
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      const owner = await readLockOwner(lockPath);
      // mkdir publishes before owner.json: never remove another starter's fresh lock.
      if (
        !owner &&
        Date.now() - (await stat(lockPath).catch(() => ({ mtimeMs: 0 }))).mtimeMs <= 5_000
      ) {
        throw new Error("This managed profile is active; retry shortly");
      }
      if (owner && isPidAlive(owner.pid)) {
        throw new Error("This managed profile is active; choose another profile name");
      }
      await rm(lockPath, { force: true, recursive: true });
    }
  }
  throw new Error("Could not acquire the managed profile lock");
}

async function waitForBridge(
  broker: BrokerClient,
  child: ChildProcess,
  diagnostics?: ManagedProcessOutputCapture,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown = new Error("Chromex extension did not connect");
  while (Date.now() < deadline) {
    if (diagnostics?.launchError) {
      throw new Error(`Managed Chromium could not start: ${diagnostics.launchError}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Managed Chromium exited before the Chromex extension connected");
    }
    try {
      const status = await broker.request<{ extension?: unknown }>("broker.status", {}, 1_000);
      if (status.extension) return;
    } catch (cause) {
      lastError = cause;
    }
    await delay(100);
  }
  throw new Error(
    `Managed Chromium did not connect to Chromex: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function resolveBrowserPath(
  override: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const requested = override ?? env.CHROMEX_BROWSER;
  if (requested) {
    const path = resolve(requested);
    await access(path, 0o1);
    return path;
  }
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const name of ["chromium", "chromium-browser", "chrome-for-testing"]) {
      const path = join(directory, name);
      try {
        await access(path, 0o1);
        return path;
      } catch {}
    }
  }
  throw new Error("Chromium was not found. Set CHROMEX_BROWSER to its executable path.");
}

function assertSupportedBrowser(browserPath: string): void {
  const name = basename(browserPath).toLowerCase();
  if (name.includes("chromium") || name.includes("chrome-for-testing")) return;
  throw new Error(
    "Managed mode requires Chromium or Chrome for Testing; Chrome-branded builds block unpacked command-line extensions",
  );
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
  })}\n`;
  const profileManifestPath = join(
    profileDirectory,
    "NativeMessagingHosts",
    `${NATIVE_HOST_NAME}.json`,
  );
  const directories = [
    dirname(profileManifestPath),
    ...["chromium", "google-chrome"].map((browserDirectory) =>
      join(configHome, browserDirectory, "NativeMessagingHosts"),
    ),
  ];
  for (const directory of directories) {
    await mkdir(directory, { mode: 0o700, recursive: true });
    await writePrivateFile(join(directory, `${NATIVE_HOST_NAME}.json`), contents);
  }
  return profileManifestPath;
}

async function writePrivateFile(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function readLockOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const value = JSON.parse(
      await readFile(join(lockPath, "owner.json"), "utf8"),
    ) as Partial<LockOwner>;
    return typeof value.pid === "number" && typeof value.sessionId === "string"
      ? { pid: value.pid, sessionId: value.sessionId }
      : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    closed.then(() => true),
    delay(3_000, false, { ref: false }),
  ]);
  if (graceful || child.exitCode !== null || child.signalCode !== null) return;
  const killed = once(child, "close");
  child.kill("SIGKILL");
  await killed;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  if (timeoutMs <= 0) return false;
  return await new Promise<boolean>((resolveExit) => {
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once("close", onClose);
    function finish(exited: boolean) {
      clearTimeout(timer);
      child.off("close", onClose);
      resolveExit(exited);
    }
  });
}
