import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import {
  access,
  chmod,
  cp,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, delimiter, dirname, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  CONFIG_DIRECTORY,
  CONFIG_FILE,
  configHome,
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  hasDisplayEnv,
  MANAGED_ENVIRONMENT_FILE,
  MANAGED_ENVIRONMENT_KEYS,
  NATIVE_HOST_NAME,
  STORE_EXTENSION_ID,
} from "@chromex/protocol"
import {
  asError,
  ClientRegistrar,
  type ClientResult,
  type Environment,
  type FindCommand,
  isObject,
  LEGACY,
  pluginName,
  type RunCommand,
  runCommand,
  type Scope,
  type StepReporter,
} from "./clients.ts"

// Both `src/setup.ts` and the bundled `dist/cli.mjs` sit one level below the package root.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const chromeIdAlphabet = "abcdefghijklmnop"
// The skills CLI reads the local unpacked package; pin it so setup output is reproducible.
const skillsCli = "skills@1.7.6"
const browserCandidates = [
  { commands: ["chromium", "chromium-browser"], configDirectory: "chromium", name: "chromium" },
  { commands: ["google-chrome-stable", "google-chrome"], configDirectory: "google-chrome", name: "chrome" },
  { commands: ["google-chrome-beta"], configDirectory: "google-chrome-beta", name: "chrome-beta" },
  { commands: ["google-chrome-unstable"], configDirectory: "google-chrome-unstable", name: "chrome-dev" },
  { commands: ["brave-browser", "brave"], configDirectory: "BraveSoftware/Brave-Browser", name: "brave" },
  { commands: ["microsoft-edge-stable", "microsoft-edge"], configDirectory: "microsoft-edge", name: "edge" },
  { commands: ["vivaldi-stable", "vivaldi"], configDirectory: "vivaldi", name: "vivaldi" },
] as const

type Logger = Pick<Console, "error" | "log" | "warn">
type LaunchBrowser = (
  executable: string,
  args: string[],
  environment: Environment,
) => void | Promise<void>
type Browser = { configDirectory: string; executable: string; name: string }
type StorePageResult = { detail: string; opened: boolean }
type StepOptions = { spinner?: boolean }
type BridgeConfig = { extensionOrigin: string; socketPath: string; token: string }

/** Numbered step lines; slow steps animate only on an interactive terminal. */
class Steps {
  private readonly animate: boolean
  private count = 0
  private readonly logger: Logger
  private timer: NodeJS.Timeout | undefined
  private readonly total: number

  constructor(total: number, logger: Logger, animate: boolean) {
    this.animate = animate
    this.logger = logger
    this.total = total
  }

  async run<T>(label: string, action: () => Promise<T>, options: StepOptions = {}): Promise<T> {
    const value = await this.measure(label, action, options)
    this.logger.log("  done")
    return value
  }

  async report(
    label: string,
    action: () => Promise<string>,
    options: StepOptions = {},
  ): Promise<void> {
    const detail = await this.measure(label, action, options)
    this.logger.log(`  ${detail || "done"}`)
  }

  private async measure<T>(
    label: string,
    action: () => Promise<T>,
    options: StepOptions,
  ): Promise<T> {
    this.count += 1
    this.logger.log(`[${this.count}/${this.total}] ${label}...`)
    if (options.spinner && this.animate) this.startSpinner()
    try {
      return await action()
    } finally {
      this.stopSpinner()
    }
  }

  private startSpinner(): void {
    const frames = ["-", "\\", "|", "/"]
    let frame = 0
    this.timer = setInterval(() => {
      process.stdout.write(`\r${frames[frame++ % frames.length]}`)
    }, 100)
    this.timer.unref()
  }

  private stopSpinner(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
    process.stdout.write("\r\x1b[K")
  }
}

export type SetupOptions = {
  artifactRoot?: string;
  browsers?: string;
  environment?: Environment;
  findCommand?: FindCommand;
  homeDirectory?: string;
  installRoot?: string;
  installSkill?: boolean;
  interactive?: boolean;
  launchBrowser?: LaunchBrowser;
  logger?: Logger;
  noOpen?: boolean;
  nodePath?: string;
  platform?: NodeJS.Platform;
  projectRoot?: string;
  runCommand?: RunCommand;
  scope?: Scope;
}

export type SetupResult = {
  bridge: { config: BridgeConfig; configPath: string };
  browsers: Browser[];
  clientResults: ClientResult[];
  extensionPath: string;
  installRoot: string;
  managedEnvironmentPath: string;
  nativeHostPaths: string[];
  openedStorePage: boolean;
}

/** Run `chromex setup`: install the runtime, write owner-only config, register hosts and clients. */
export async function installChromex(options: SetupOptions = {}): Promise<SetupResult> {
  if ((options.platform ?? process.platform) !== "linux") {
    throw new Error("The Chromex local installer currently supports Linux only")
  }
  return await new Installation(options).run()
}

/** One setup run. Paths, environment and injected functions are resolved once here. */
class Installation {
  private readonly artifactRoot: string
  private readonly browserSelection: string | undefined
  private readonly configHome: string
  private readonly environment: Environment
  private readonly findCommand: FindCommand
  private readonly homeDirectory: string
  private readonly installRoot: string
  private readonly installSkill: boolean
  private readonly legacyInstallRoot: string
  private readonly interactive: boolean
  private readonly launchBrowser: LaunchBrowser
  private readonly logger: Logger
  private readonly noOpen: boolean
  private readonly nodePath: string
  private readonly projectRoot: string
  private readonly runCommand: RunCommand
  private readonly runtimeDirectory: string
  private readonly scopeOption: Scope | undefined

  constructor(options: SetupOptions) {
    this.environment = options.environment ?? process.env
    this.homeDirectory = options.homeDirectory ?? homedir()
    this.configHome = configHome(this.environment, this.homeDirectory)
    this.runtimeDirectory =
      this.environment.XDG_RUNTIME_DIR ||
      resolve(tmpdir(), `${pluginName}-${process.getuid?.() ?? 0}`)
    this.artifactRoot = options.artifactRoot ?? resolve(packageRoot, "dist", pluginName)
    this.browserSelection = options.browsers
    this.installRoot = options.installRoot ?? resolve(this.homeDirectory, "plugins", pluginName)
    this.installSkill = options.installSkill ?? true
    this.legacyInstallRoot = resolve(dirname(this.installRoot), LEGACY.plugin)
    this.projectRoot = options.projectRoot ?? process.cwd()
    this.scopeOption = options.scope
    this.findCommand = options.findCommand ?? findCommand
    this.runCommand = options.runCommand ?? runCommand
    this.launchBrowser = options.launchBrowser ?? launchBrowser
    this.logger = options.logger ?? console
    this.nodePath = options.nodePath ?? process.execPath
    this.interactive = options.interactive ?? (process.stdout.isTTY && process.stdin.isTTY)
    this.noOpen = options.noOpen ?? false
  }

  async run(): Promise<SetupResult> {
    await validateArtifact(this.artifactRoot)
    const detected = await this.detectBrowsers()
    const scope = await this.chooseScope()
    const browsers = await this.selectBrowsers(detected)
    const steps = new Steps(
      10 + Math.max(browsers.length, 1),
      this.logger,
      this.interactive && this.environment.CI !== "true",
    )
    const reporter: StepReporter = (label, action, options) => steps.report(label, action, options)

    await steps.run("Copy the Chromex runtime", async() => this.replaceInstalledPlugin())
    await steps.run("Remove the old install", async() => {
      await this.removeLegacyInstall()
      await this.removeLegacySkillLink()
      await this.removeLegacyNativeHosts(browsers)
    })
    const config = await steps.run("Write the bridge configuration", async() => ({
      bridge: await this.writeBridgeConfig(),
      managedEnvironmentPath: await this.writeManagedEnvironment(),
    }))

    const nativeHostPaths: string[] = []
    if (browsers.length === 0) {
      await steps.report("Write native hosts", async() => "skipped: no browser selected")
    } else {
      for (const browser of browsers) {
        nativeHostPaths.push(
          await steps.run(`Write the native host for ${browser.name}`, async() =>
            this.registerNativeHost(browser)),
        )
      }
    }

    let openedStorePage = false
    await steps.report("Open the extension page", async() => {
      const page = await this.openStorePage(browsers)
      openedStorePage = page.opened
      return page.detail
    })

    const registrar = new ClientRegistrar({
      configHome: this.configHome,
      environment: this.environment,
      findCommand: this.findCommand,
      homeDirectory: this.homeDirectory,
      installRoot: this.installRoot,
      nodePath: this.nodePath,
      projectRoot: this.projectRoot,
      runCommand: this.runCommand,
      scope,
    })
    if (scope === "project") {
      await steps.report("Write the project .mcp.json", async() =>
        registrar.registerProjectMcpJson())
    }
    const clientResults = await registrar.registerAll(reporter)

    await steps.report("Install the Chromex skill", async() => this.installSkills(scope), {
      spinner: true,
    })

    const extensionPath = resolve(this.installRoot, "dist/extension")
    const { logger } = this
    logger.log(`Installed Chromex plugin: ${this.installRoot}`)
    logger.log(`Bridge config: ${config.bridge.configPath}`)
    logger.log(`Managed environment: ${config.managedEnvironmentPath}`)
    for (const path of nativeHostPaths) logger.log(`Native host: ${path}`)
    for (const result of clientResults) {
      switch (result.status) {
        case "configured":
          logger.log(`${result.client}: ${result.detail ?? "configured"}`)
          break
        case "skipped":
          logger.warn(`${result.client}: CLI not found; skipped MCP registration`)
          break
        case "failed":
          logger.error(`${result.client}: ${result.error.message}`)
          break
      }
    }
    logger.log(`Observe extension: ${extensionPath}`)

    return {
      bridge: config.bridge,
      browsers,
      clientResults,
      extensionPath,
      installRoot: this.installRoot,
      managedEnvironmentPath: config.managedEnvironmentPath,
      nativeHostPaths,
      openedStorePage,
    }
  }

  /** Ask once where to install; without a TTY the default is global. */
  private async chooseScope(): Promise<Scope> {
    if (this.scopeOption !== undefined) return this.scopeOption
    if (!this.interactive) return "global"
    const { createInterface } = await import("node:readline/promises")
    const readline = createInterface({ input: process.stdin, output: process.stdout })
    try {
      for (;;) {
        const answer = (
          await readline.question(
            "Install for this project or globally? [project/global] [global]: ",
          )
        ).trim().toLowerCase()
        if (answer === "" || answer === "global" || answer === "g") return "global"
        if (answer === "project" || answer === "p") return "project"
        this.logger.warn("Answer project or global.")
      }
    } finally {
      readline.close()
    }
  }

  /** Stage a validated copy, then swap it in; the previous install is restored if the swap fails. */
  private async replaceInstalledPlugin(): Promise<void> {
    const installParent = dirname(this.installRoot)
    const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`
    const stagingRoot = resolve(installParent, `.${pluginName}.staging-${suffix}`)
    const backupRoot = resolve(installParent, `.${pluginName}.backup-${suffix}`)
    let movedExisting = false
    let installedStaging = false

    await mkdir(installParent, { recursive: true })
    try {
      await cp(this.artifactRoot, stagingRoot, { recursive: true })
      await validateArtifact(stagingRoot)
      await chmod(resolve(stagingRoot, "dist/native-host.mjs"), 0o700)

      try {
        await rename(this.installRoot, backupRoot)
        movedExisting = true
      } catch(cause) {
        if (errorCode(cause) !== "ENOENT") throw cause
      }

      try {
        await rename(stagingRoot, this.installRoot)
        installedStaging = true
      } catch(cause) {
        if (movedExisting) await rename(backupRoot, this.installRoot)
        throw cause
      }

      if (movedExisting) await rm(backupRoot, { force: true, recursive: true })
    } finally {
      if (!installedStaging) await rm(stagingRoot, { force: true, recursive: true })
    }
  }

  /** Remove the install root earlier versions used. */
  private async removeLegacyInstall(): Promise<void> {
    if (this.legacyInstallRoot === this.installRoot) return
    await rm(this.legacyInstallRoot, { force: true, recursive: true })
  }

  /** Drop the old skill link only when it is a symlink into the old install root. */
  private async removeLegacySkillLink(): Promise<void> {
    const skillPath = resolve(this.homeDirectory, ".agents/skills", LEGACY.skill)
    const target = await readlink(skillPath).catch(() => null)
    if (target === null) {
      if (await access(skillPath).then(() => true, () => false)) {
        this.logger.warn(`Kept ${skillPath}: it is not a Chromex symlink`)
      }
      return
    }
    if (target.startsWith(`${this.legacyInstallRoot}/`)) {
      await rm(skillPath, { force: true })
      return
    }
    this.logger.warn(`Kept ${skillPath}: it points to ${target}`)
  }

  private async writeManagedEnvironment(): Promise<string> {
    const snapshot: Record<string, string> = {}
    for (const name of MANAGED_ENVIRONMENT_KEYS) {
      const value = this.environment[name]
      if (value) snapshot[name] = value
    }
    const path = resolve(this.installRoot, "dist", MANAGED_ENVIRONMENT_FILE)
    await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
    await chmod(path, 0o600)
    return path
  }

  private async writeBridgeConfig(): Promise<SetupResult["bridge"]> {
    const configDirectory = resolve(this.configHome, CONFIG_DIRECTORY)
    const configPath = resolve(configDirectory, CONFIG_FILE)
    await mkdir(configDirectory, { mode: 0o700, recursive: true })
    await chmod(configDirectory, 0o700)
    await mkdir(this.runtimeDirectory, { mode: 0o700, recursive: true })
    await chmod(this.runtimeDirectory, 0o700)

    const config = {
      extensionOrigin: EXTENSION_ORIGIN,
      socketPath: resolve(this.runtimeDirectory, "bridge.sock"),
      token: await existingToken(configPath),
    }
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    await chmod(configPath, 0o600)
    return { config, configPath }
  }

  private async detectBrowsers(): Promise<Browser[]> {
    const browsers: Browser[] = []
    const seen = new Set<string>()
    const override = this.environment.CHROMEX_BROWSER
    if (override) {
      const executable = await this.findCommand(override, this.environment)
      if (!executable) throw new Error(`CHROMEX_BROWSER is not executable: ${override}`)
      const configDirectory = browserConfigDirectory(executable)
      browsers.push({ configDirectory, executable, name: "custom" })
      seen.add(configDirectory)
    }
    for (const candidate of browserCandidates) {
      if (seen.has(candidate.configDirectory)) continue
      for (const command of candidate.commands) {
        const executable = await this.findCommand(command, this.environment)
        if (!executable) continue
        browsers.push({
          configDirectory: candidate.configDirectory,
          executable,
          name: candidate.name,
        })
        seen.add(candidate.configDirectory)
        break
      }
    }
    return browsers
  }

  /** Apply `--browsers`, else ask on a TTY, else keep every detected browser. */
  private async selectBrowsers(detected: Browser[]): Promise<Browser[]> {
    if (detected.length === 0) {
      this.logger.warn("No supported browser found; native-host files and the store page are skipped.")
      return []
    }
    if (this.browserSelection !== undefined) {
      return pickBrowsers(detected, this.browserSelection, this.logger)
    }
    if (!this.interactive) return detected
    return await promptBrowsers(detected, this.logger)
  }

  private async registerNativeHost(browser: Browser): Promise<string> {
    const manifest = {
      allowed_origins:
        STORE_EXTENSION_ID === null
          ? [EXTENSION_ORIGIN]
          : [EXTENSION_ORIGIN, `chrome-extension://${STORE_EXTENSION_ID}/`],
      description: "Chromex native host",
      name: NATIVE_HOST_NAME,
      path: resolve(this.installRoot, "dist/native-host.mjs"),
      type: "stdio",
    }
    const path = resolve(
      this.configHome,
      browser.configDirectory,
      "NativeMessagingHosts",
      `${NATIVE_HOST_NAME}.json`,
    )
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
    await chmod(path, 0o644)
    return path
  }

  /** Delete old native-host files that this installer wrote; keep any other file with a warning. */
  private async removeLegacyNativeHosts(browsers: Browser[]): Promise<void> {
    const directories = new Set([
      ...browsers.map((browser) => browser.configDirectory),
      ...browserCandidates.map((candidate) => candidate.configDirectory),
    ])
    for (const configDirectory of directories) {
      const path = resolve(
        this.configHome,
        configDirectory,
        "NativeMessagingHosts",
        `${LEGACY.nativeHost}.json`,
      )
      const contents = await readFile(path, "utf8").catch(() => null)
      if (contents === null) continue
      let manifest: unknown
      try {
        manifest = JSON.parse(contents)
      } catch {
        this.logger.warn(`Kept ${path}: it is not a JSON native-host manifest`)
        continue
      }
      if (!isObject(manifest) || manifest.name !== LEGACY.nativeHost) {
        this.logger.warn(`Kept ${path}: it was not written by Chromex`)
        continue
      }
      await rm(path, { force: true })
    }
  }

  /** Open the store page in each picked browser, or print where to get the extension. */
  private async openStorePage(browsers: Browser[]): Promise<StorePageResult> {
    if (browsers.length === 0) return { opened: false, detail: "skipped: no browser selected" }
    if (STORE_EXTENSION_ID === null) {
      return {
        opened: false,
        detail: `skipped: not published yet; load the unpacked extension from ${resolve(this.installRoot, "dist/extension")}`,
      }
    }
    const url = `https://chromewebstore.google.com/detail/${STORE_EXTENSION_ID}`
    if (this.noOpen || this.environment.CI === "true" || !hasDisplayEnv(this.environment)) {
      return { opened: false, detail: `skipped: open ${url} in each selected browser` }
    }
    const failures: string[] = []
    const opened: string[] = []
    for (const browser of browsers) {
      try {
        await this.launchBrowser(browser.executable, [url], this.environment)
        opened.push(browser.name)
      } catch(cause) {
        failures.push(`${browser.name}: ${asError(cause).message}`)
      }
    }
    if (opened.length === 0) {
      return { opened: false, detail: `warning: could not open the store page (${failures.join("; ")})` }
    }
    return {
      opened: true,
      detail:
        failures.length === 0
          ? `opened in ${opened.join(", ")}`
          : `warning: opened in ${opened.join(", ")}; ${failures.join("; ")}`,
    }
  }

  /** Install the packaged skill with the skills CLI; a failure is a warning, not a setup failure. */
  private async installSkills(scope: Scope): Promise<string> {
    if (!this.installSkill) return "skipped: --skills none"
    const args = ["--yes", skillsCli, "add", this.installRoot, "--skill", pluginName, "-y"]
    if (scope === "global") args.push("-g")
    try {
      await this.runCommand("npx", args, { env: this.environment })
      return scope === "global" ? "installed globally" : "installed in this project"
    } catch(cause) {
      return `warning: Skill install failed: ${asError(cause).message}`
    }
  }
}

async function validateArtifact(artifactRoot: string): Promise<void> {
  const requiredPaths = [
    ".agents/plugins/marketplace.json",
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "dist/mcp-server.mjs",
    "dist/managed-service.mjs",
    "dist/native-host.mjs",
    "dist/extension/manifest.json",
    "skills/chromex/SKILL.md",
  ]
  for (const relativePath of requiredPaths) {
    const path = resolve(artifactRoot, relativePath)
    if (!(await stat(path)).isFile()) throw new Error(`Required artifact is not a file: ${path}`)
  }

  const pluginManifest = await readJson(resolve(artifactRoot, ".codex-plugin/plugin.json"))
  if (!isObject(pluginManifest) || pluginManifest.name !== pluginName) {
    throw new Error(`Plugin manifest name must be ${pluginName}`)
  }

  const extensionManifest = await readJson(resolve(artifactRoot, "dist/extension/manifest.json"))
  const key = isObject(extensionManifest) ? extensionManifest.key : undefined
  if (typeof key !== "string" || extensionIdFromKey(key) !== EXTENSION_ID) {
    throw new Error(`Packaged extension key must produce extension ID ${EXTENSION_ID}`)
  }
}

function extensionIdFromKey(key: string): string {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16)
  let id = ""
  for (const byte of digest) {
    id += chromeIdAlphabet.charAt(byte >> 4) + chromeIdAlphabet.charAt(byte & 0x0f)
  }
  return id
}

/** Reuse a valid saved token so connected clients keep working; otherwise mint a new one. */
async function existingToken(configPath: string): Promise<string> {
  const existing = await readJson(configPath).catch(() => undefined)
  const token = isObject(existing) ? existing.token : undefined
  return typeof token === "string" && token.length >= 32 ? token : randomBytes(32).toString("hex")
}

function browserConfigDirectory(command: string): string {
  const executableName = basename(command)
  if (executableName.includes("beta")) return "google-chrome-beta"
  if (executableName.includes("unstable")) return "google-chrome-unstable"
  if (executableName.includes("chrome")) return "google-chrome"
  return "chromium"
}

/** Resolve `all`, `none`, or a comma-separated name list against the detected browsers. */
function pickBrowsers(detected: Browser[], selection: string, logger: Logger): Browser[] {
  const value = selection.trim().toLowerCase()
  if (value === "" || value === "none") return []
  if (value === "all") return detected
  const names = value.split(",").map((name) => name.trim()).filter(Boolean)
  for (const name of names) {
    if (!detected.some((browser) => browser.name === name)) {
      logger.warn(`Browser not found; skipped: ${name}`)
    }
  }
  return detected.filter((browser) => names.includes(browser.name))
}

async function promptBrowsers(detected: Browser[], logger: Logger): Promise<Browser[]> {
  const { createInterface } = await import("node:readline/promises")
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    logger.log(`Detected browsers: ${detected.map((browser) => browser.name).join(", ")}`)
    const answer = await readline.question(
      "Browsers to set up (names, comma separated, or all) [all]: ",
    )
    return pickBrowsers(detected, answer.trim() === "" ? "all" : answer, logger)
  } finally {
    readline.close()
  }
}

const findCommand: FindCommand = async(command, environment) => {
  const candidates =
    isAbsolute(command) || command.includes("/")
      ? [resolve(command)]
      : (environment.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => resolve(directory, command))
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not executable here; try the next candidate.
    }
  }
  return null
}

const launchBrowser: LaunchBrowser = (executable, args, environment) => {
  spawn(executable, args, { detached: true, env: environment, stdio: "ignore" }).unref()
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"))
}

function errorCode(cause: unknown): unknown {
  return isObject(cause) ? cause.code : undefined
}
