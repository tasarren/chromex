import { execFile } from "node:child_process"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import { isDeepStrictEqual, promisify } from "node:util"

export const pluginName = "chromex"
/** Names earlier installs wrote. Setup removes only entries that point at these. */
export const LEGACY = {
  nativeHost: "io.codex.chrome_bridge",
  plugin: "chrome-browser-bridge",
  skill: "chrome-browser",
} as const
const marketplaceName = "chromex"
const serverName = "chromex"
const legacyServerName = LEGACY.plugin

export type Environment = NodeJS.ProcessEnv
export type CommandOutput = { stderr: string; stdout: string }
export type RunCommand = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: Environment },
) => Promise<CommandOutput>
export type FindCommand = (command: string, environment: Environment) => Promise<string | null>
export type Scope = "global" | "project"
export type StepReporter = (
  label: string,
  action: () => Promise<string>,
  options?: { spinner?: boolean },
) => Promise<void>

const harnesses = [
  { client: "Claude Code", commands: ["claude"], global: "claude", project: "mcpJson" },
  { client: "Codex", commands: ["codex"], global: "codex", project: "codex" },
  { client: "OpenCode", commands: ["opencode"], global: "opencode", project: "opencode" },
  { client: "Grok", commands: ["grok"], global: "grok", project: "mcpJson" },
  { client: "Cursor", commands: ["cursor", "cursor-agent"], global: "cursor", project: "none" },
] as const
type Harness = (typeof harnesses)[number]
type ClientName = Harness["client"]
type RegistrationTarget = Harness["global"] | Harness["project"]
export type ClientResult =
  | { client: ClientName; detail?: string; status: "configured" | "skipped" }
  | { client: ClientName; error: Error; status: "failed" }

export class CommandError extends Error {
  readonly args: string[]
  readonly command: string

  constructor(command: string, args: string[], cause: unknown) {
    const detail = isObject(cause)
      ? [cause.stderr, cause.stdout, cause.message]
        .find((value) => typeof value === "string" && value.trim())
        ?.toString()
        .trim()
      : undefined
    super(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`, { cause })
    this.name = "CommandError"
    this.command = command
    this.args = args
  }
}

const execFileAsync = promisify(execFile)

export const runCommand: RunCommand = async(command, args, options = {}) => {
  try {
    const { stderr, stdout } = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: 10 * 1024 * 1024,
    })
    return { stderr, stdout }
  } catch(cause) {
    throw new CommandError(command, args, cause)
  }
}

// Accepted stdio shape per client: Claude `{type?: "stdio", command, args}`, OpenCode
// `{type?: "local", command: [...]}`. Anything else (remote/url, non-object) is not Chromex's.
const clientShapes = {
  claude: { keys: ["type", "command", "args"], type: "stdio" },
  opencode: { keys: ["type", "command"], type: "local" },
} as const
type ConfigClient = keyof typeof clientShapes

export type ClientContext = {
  configHome: string;
  environment: Environment;
  findCommand: FindCommand;
  homeDirectory: string;
  installRoot: string;
  nodePath: string;
  projectRoot: string;
  runCommand: RunCommand;
  scope: Scope;
}

/** Registers the Chromex MCP server with each detected client CLI. */
export class ClientRegistrar {
  private readonly configHome: string
  private readonly environment: Environment
  private readonly findCommand: FindCommand
  private readonly homeDirectory: string
  private readonly installRoot: string
  private readonly legacyInstallRoot: string
  private readonly legacyRuntime: string
  private readonly nodePath: string
  private readonly projectRoot: string
  private readonly run: RunCommand
  private readonly runtime: string
  private readonly scope: Scope

  constructor(context: ClientContext) {
    this.configHome = context.configHome
    this.environment = context.environment
    this.findCommand = context.findCommand
    this.homeDirectory = context.homeDirectory
    this.installRoot = context.installRoot
    this.legacyInstallRoot = resolve(dirname(context.installRoot), LEGACY.plugin)
    this.legacyRuntime = resolve(this.legacyInstallRoot, "dist/mcp-server.mjs")
    this.nodePath = context.nodePath
    this.projectRoot = context.projectRoot
    this.run = context.runCommand
    this.runtime = resolve(context.installRoot, "dist/mcp-server.mjs")
    this.scope = context.scope
  }

  /** Configure every harness found; one failure does not stop the others. */
  async registerAll(onStep?: StepReporter): Promise<ClientResult[]> {
    const results: ClientResult[] = []
    for (const harness of harnesses) {
      const target = this.scope === "project" ? harness.project : harness.global
      if (target === "none") continue
      const client = harness.client
      const label = `Register ${client}`
      const executable = await this.findExecutable(harness.commands)
      if (!executable) {
        results.push({ client, detail: "CLI not found", status: "skipped" })
        if (onStep) await onStep(label, async() => "skipped: CLI not found")
        continue
      }
      let failure: Error | undefined
      let detail = ""
      const attempt = async() => {
        try {
          detail = await this.register(target, executable)
        } catch(cause) {
          failure = asError(cause)
        }
        return failure ? `failed: ${failure.message}` : detail
      }
      if (onStep) await onStep(label, attempt, { spinner: true })
      else await attempt()
      results.push(
        failure
          ? { client, error: failure, status: "failed" }
          : { client, detail, status: "configured" },
      )
    }
    return results
  }

  /** Write the project-standard `.mcp.json` once for this scope. */
  async registerProjectMcpJson(): Promise<string> {
    return await upsertJsonServer(resolve(this.projectRoot, ".mcp.json"), ["mcpServers"], {
      args: [this.runtime],
      command: this.nodePath,
      type: "stdio",
    })
  }

  private async findExecutable(commands: readonly string[]): Promise<string | null> {
    for (const command of commands) {
      const executable = await this.findCommand(command, this.environment)
      if (executable) return executable
    }
    return null
  }

  private async register(target: RegistrationTarget, executable: string): Promise<string> {
    switch (target) {
      case "claude":
        return await this.claude(executable)
      case "codex":
        return await this.codex(executable)
      case "opencode":
        return await this.opencode(executable)
      case "grok":
        return await this.grok(executable)
      case "cursor":
        return await this.cursor()
      case "mcpJson":
        return "covered by .mcp.json"
      case "none":
        return "skipped: no project config for this harness"
    }
  }

  private async codex(codex: string): Promise<string> {
    if (this.scope === "project") return await this.codexProject()
    // The plugin command is a capability, not a version: older CLIs expose only `mcp`.
    if (!(await this.codexHasPlugin(codex))) {
      return await this.codexNative(codex)
    }
    const installed = await this.codexPluginList(codex)
    const codexHome = this.environment.CODEX_HOME || resolve(this.homeDirectory, ".codex")
    const existing = await this.codexServer(codex)
    let detail = "configured through the Codex plugin"
    if (existing && !fromChromexPlugin(existing, codexHome)) {
      await this.command(codex, ["mcp", "remove", serverName])
      detail = "updated"
    }
    await this.command(codex, ["plugin", "marketplace", "add", this.installRoot, "--json"])
    await this.command(codex, ["plugin", "add", `${pluginName}@${marketplaceName}`, "--json"])
    if (!fromChromexPlugin(await this.codexServer(codex), codexHome)) {
      throw new Error(
        `Codex installed the plugin but its "${serverName}" MCP server does not come from it; check codex mcp list`,
      )
    }

    // Earlier installers added the install root, under either name, through the personal marketplace.
    for (const plugin of installed) {
      if (
        isObject(plugin) &&
        (plugin.name === pluginName || plugin.name === LEGACY.plugin) &&
        plugin.marketplaceName !== marketplaceName &&
        isObject(plugin.source) &&
        (plugin.source.path === this.installRoot || plugin.source.path === this.legacyInstallRoot) &&
        typeof plugin.pluginId === "string"
      ) {
        await this.command(codex, ["plugin", "remove", plugin.pluginId, "--json"])
      }
    }
    return detail
  }

  /** Codex has no project scope on `mcp add`; write its project config table directly. */
  private async codexProject(): Promise<string> {
    const path = resolve(this.projectRoot, ".codex/config.toml")
    const contents = await readFile(path, "utf8").catch((cause: unknown) => {
      if (isObject(cause) && cause.code === "ENOENT") return ""
      throw new Error(`Cannot inspect ${path}: ${asError(cause).message}. Fix the file, then rerun setup`, {
        cause,
      })
    })
    const body = [
      `[mcp_servers.${serverName}]`,
      `command = ${JSON.stringify(this.nodePath)}`,
      `args = [${JSON.stringify(this.runtime)}]`,
    ].join("\n")
    const next = upsertTomlTable(contents, body)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, next.contents)
    return `${next.updated ? "updated" : "added"}; Codex loads it only for a trusted project`
  }

  /** Read the root help command list. Probe errors propagate; absence must be proven. */
  private async codexHasPlugin(codex: string): Promise<boolean> {
    const help = (await this.command(codex, ["--help"])).stdout
    const commands: string[] = []
    let inCommands = false
    for (const line of help.split("\n")) {
      if (/^\s*Commands:\s*$/.test(line)) {
        inCommands = true
        continue
      }
      if (!inCommands) continue
      if (line.trim() === "" || /^\S/.test(line)) break
      const [name] = line.trim().split(/\s+/)
      if (name) commands.push(name)
    }
    if (commands.length === 0) {
      throw new Error("Cannot inspect `codex --help`: no Commands section")
    }
    return commands.includes("plugin")
  }

  /** Installed plugins; any failure here is an operational error, not missing capability. */
  private async codexPluginList(codex: string): Promise<unknown[]> {
    const stdout = (await this.command(codex, ["plugin", "list", "--json"])).stdout
    const list: unknown = JSON.parse(stdout)
    const installed = isObject(list) ? list.installed : undefined
    if (!Array.isArray(installed)) {
      throw new Error("Cannot inspect `codex plugin list --json`: installed is not an array")
    }
    return installed.map((entry: unknown) => entry)
  }

  /** Register through the native `codex mcp` commands when the plugin command is unavailable. */
  private async codexNative(codex: string): Promise<string> {
    const servers = await this.codexServers(codex)
    const existing = servers.find((server) => isObject(server) && server.name === serverName)
    const current = existing !== undefined && this.isCurrentCodexServer(existing)
    let detail = "already current"
    if (!current) {
      if (existing) {
        await this.command(codex, ["mcp", "remove", serverName])
        detail = "updated"
      } else {
        detail = "added"
      }
      await this.command(codex, ["mcp", "add", serverName, "--", this.nodePath, this.runtime])
    }
    const registered = (await this.codexServers(codex)).find(
      (server) => isObject(server) && server.name === serverName,
    )
    if (!registered || !this.isCurrentCodexServer(registered)) {
      throw new Error(
        `Codex did not register "${serverName}" for ${this.runtime}; check codex mcp list`,
      )
    }
    // A legacy entry is ours only when it runs this install's runtime through this Node.
    const legacy = servers.find((server) => isObject(server) && server.name === legacyServerName)
    if (legacy && this.ownsCodexServer(legacy)) {
      if (!this.isDefaultCodexServer(legacy)) {
        throw new Error(
          `registered "${serverName}"; Codex legacy "${legacyServerName}" has custom options. ` +
            `Check it, then remove it with \`codex mcp remove ${legacyServerName}\``,
        )
      }
      await this.command(codex, ["mcp", "remove", legacyServerName])
    }
    return detail
  }

  /** Only a default stdio entry may be migrated; its options must not be dropped silently. */
  private isDefaultCodexServer(server: unknown): boolean {
    if (!this.ownsCodexServer(server) || !isObject(server)) return false
    const transport = server.transport
    if (!isObject(transport)) return false
    const transportKeys = new Set(["args", "command", "cwd", "env", "env_vars", "type"])
    if (Object.keys(transport).some((key) => !transportKeys.has(key))) return false
    if (transport.type !== undefined && transport.type !== "stdio") return false
    if (transport.cwd !== undefined && transport.cwd !== null) return false
    if (
      transport.env !== undefined &&
      transport.env !== null &&
      !(isObject(transport.env) && Object.keys(transport.env).length === 0)
    ) {
      return false
    }
    if (
      transport.env_vars !== undefined &&
      (!Array.isArray(transport.env_vars) || transport.env_vars.length > 0)
    ) {
      return false
    }
    const serverKeys = new Set([
      "auth_status",
      "disabled_tools",
      "enabled",
      "enabled_tools",
      "name",
      "startup_timeout_sec",
      "tool_timeout_sec",
      "transport",
    ])
    if (Object.keys(server).some((key) => !serverKeys.has(key))) return false
    if (server.enabled !== undefined && server.enabled !== true) return false
    for (const key of ["disabled_tools", "enabled_tools", "startup_timeout_sec", "tool_timeout_sec"]) {
      if (server[key] !== undefined && server[key] !== null) return false
    }
    return true
  }

  private async codexServers(codex: string): Promise<unknown[]> {
    const servers: unknown = JSON.parse(
      (await this.command(codex, ["mcp", "list", "--json"])).stdout,
    )
    if (!Array.isArray(servers)) {
      throw new Error("Cannot inspect `codex mcp list --json`: output is not an array")
    }
    return servers.map((server: unknown) => server)
  }

  private async codexServer(codex: string): Promise<unknown> {
    return (await this.codexServers(codex)).find(
      (server) => isObject(server) && server.name === serverName,
    )
  }

  private ownsCodexServer(server: unknown): boolean {
    const transport = isObject(server) ? server.transport : undefined
    return (
      isObject(transport) &&
      transport.command === this.nodePath &&
      (isDeepStrictEqual(transport.args, [this.runtime]) ||
        isDeepStrictEqual(transport.args, [this.legacyRuntime]))
    )
  }

  private isCurrentCodexServer(server: unknown): boolean {
    const transport = isObject(server) ? server.transport : undefined
    return (
      isObject(transport) &&
      transport.command === this.nodePath &&
      isDeepStrictEqual(transport.args, [this.runtime])
    )
  }

  private async claude(claude: string): Promise<string> {
    const project = this.scope === "project"
    const configPath = project
      ? resolve(this.projectRoot, ".mcp.json")
      : resolve(
        this.environment.CLAUDE_CONFIG_DIR || this.homeDirectory,
        ".claude.json",
      )
    const servers = await readMcpServers(configPath, ["mcpServers"])
    const plan = this.planServer(servers, "claude")
    const scopeArgs = ["--scope", project ? "project" : "user"]
    let detail = "already current"
    if (plan !== "keep") {
      const add = (definition: unknown) =>
        this.command(claude, [
          "mcp",
          "add-json",
          ...scopeArgs,
          serverName,
          JSON.stringify(definition),
        ])
      // Claude refuses to overwrite, so replace by remove + add and put the old entry back on failure.
      if (plan === "replace" && servers[serverName] !== undefined) {
        await this.command(claude, ["mcp", "remove", serverName, ...scopeArgs])
      }
      try {
        await add({ args: [this.runtime], command: this.nodePath, type: "stdio" })
      } catch(cause) {
        const error = asError(cause)
        if (plan === "replace" && servers[serverName] !== undefined) {
          await add(servers[serverName]).catch((restoreError: unknown) => {
            error.message += `; restoring the previous "${serverName}" entry failed: ${asError(restoreError).message}`
          })
        }
        throw error
      }
      detail = plan === "replace" ? "updated" : "added"
    }
    if (this.ownsServer(servers[legacyServerName], "claude")) {
      await this.command(claude, ["mcp", "remove", legacyServerName, ...scopeArgs])
    }
    return detail
  }

  private async opencode(opencode: string): Promise<string> {
    const directory =
      this.scope === "global" ? resolve(this.configHome, "opencode") : this.projectRoot
    const jsoncPath = resolve(directory, "opencode.jsonc")
    const configPath = (await exists(jsoncPath))
      ? jsoncPath
      : resolve(directory, "opencode.json")
    const parse = configPath.endsWith(".jsonc") ? parseJsonc : JSON.parse
    const servers = await readMcpServers(configPath, ["mcp", "servers"], parse)
    // `mcp add` replaces the whole entry, so leave an up-to-date one alone.
    const plan = this.planServer(servers, "opencode")
    let detail = "already current"
    if (plan !== "keep") {
      const args = ["mcp", "add", serverName]
      if (this.scope === "global") args.push("--global")
      args.push("--", this.nodePath, this.runtime)
      await this.command(opencode, args, this.scope === "project" ? this.projectRoot : undefined)
      detail = plan === "replace" ? "updated" : "added"
    }
    // OpenCode v2 has no `mcp remove`; never rewrite the user's config file.
    if (this.ownsServer(servers[legacyServerName], "opencode")) {
      return `${detail}; warning: remove mcp.servers["${legacyServerName}"] from ${configPath} by hand`
    }
    return detail
  }

  private async grok(grok: string): Promise<string> {
    const servers = await this.grokServers(grok)
    const existing = servers.find((server) => server.name === serverName)
    const current =
      existing !== undefined &&
      existing.command === this.nodePath &&
      isDeepStrictEqual(existing.args, [this.runtime])
    if (current) return "already current"
    await this.command(grok, [
      "mcp",
      "add",
      "-s",
      "user",
      serverName,
      "--",
      this.nodePath,
      this.runtime,
    ])
    return existing === undefined ? "added" : "updated"
  }

  private async grokServers(grok: string): Promise<Record<string, unknown>[]> {
    const output = (await this.command(grok, ["mcp", "list", "--json"])).stdout
    const list: unknown = JSON.parse(output)
    if (!Array.isArray(list)) {
      throw new Error("Cannot inspect `grok mcp list --json`: output is not an array")
    }
    return list
      .filter(isObject)
      .filter((server) => server.scope === undefined || server.scope === "user")
  }

  private async cursor(): Promise<string> {
    return await upsertJsonServer(resolve(this.homeDirectory, ".cursor/mcp.json"), ["mcpServers"], {
      args: [this.runtime],
      command: this.nodePath,
    })
  }

  private command(command: string, args: string[], cwd?: string): Promise<CommandOutput> {
    return this.run(command, args, {
      env: this.environment,
      ...(cwd === undefined ? {} : { cwd }),
    })
  }

  // An entry is Chromex's only if it is exactly `<node> <this install's runtime>`.
  private ownsServer(definition: unknown, client: ConfigClient): boolean {
    if (!isObject(definition) || "url" in definition) return false
    if (definition.type !== undefined && definition.type !== clientShapes[client].type)
      return false
    const [command, runtime, ...rest] = serverArgv(definition)
    return (
      rest.length === 0 &&
      (runtime === this.runtime || runtime === this.legacyRuntime) &&
      typeof command === "string" &&
      (command === this.nodePath || ["node", "nodejs"].includes(basename(command)))
    )
  }

  // Decides what to do with an existing `chromex` entry: "add", "keep", or "replace".
  // DEC-11: an existing entry always becomes the current one; extra options are dropped.
  private planServer(
    servers: Record<string, unknown>,
    client: ConfigClient,
  ): "add" | "keep" | "replace" {
    if (!Object.hasOwn(servers, serverName)) return "add"
    const current = servers[serverName]
    if (!isObject(current) || !this.ownsServer(current, client)) return "replace"
    if (!isDeepStrictEqual(serverArgv(current), [this.nodePath, this.runtime])) return "replace"
    const keys: readonly string[] = clientShapes[client].keys
    return Object.keys(current).some((key) => !keys.includes(key)) ? "replace" : "keep"
  }
}

/** Merge one server entry into a JSON file and keep every other key. */
async function upsertJsonServer(
  path: string,
  keys: string[],
  definition: Record<string, unknown>,
): Promise<string> {
  let root: Record<string, unknown> = {}
  const text = await readFile(path, "utf8").catch((cause: unknown) => {
    if (isObject(cause) && cause.code === "ENOENT") return undefined
    throw new Error(`Cannot inspect ${path}: ${asError(cause).message}. Fix the file, then rerun setup`, {
      cause,
    })
  })
  if (text !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch(cause) {
      throw new Error(
        `Cannot inspect ${path}: ${asError(cause).message}. Fix the file, then rerun setup`,
        { cause },
      )
    }
    if (!isObject(parsed)) {
      throw new Error(`Cannot inspect ${path}: the root is not an object. Fix the file`)
    }
    root = parsed
  }
  let servers = root
  for (const key of keys) {
    const value = servers[key]
    if (value === undefined) {
      const created: Record<string, unknown> = {}
      servers[key] = created
      servers = created
      continue
    }
    if (!isObject(value)) {
      throw new Error(`Cannot inspect ${path}: ${keys.join(".")} is not an object. Fix the file`)
    }
    servers = value
  }
  const current = servers[serverName]
  const status =
    current === undefined
      ? "added"
      : isDeepStrictEqual(current, definition)
        ? "already current"
        : "updated"
  if (status !== "already current") {
    servers[serverName] = definition
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(root, null, 2)}\n`)
  }
  return status
}

// Reads the server map at `keys` passively; a missing file or key is empty, any other shape fails.
async function readMcpServers(
  path: string,
  keys: string[],
  parse: (text: string) => unknown = JSON.parse,
): Promise<Record<string, unknown>> {
  let value: unknown
  try {
    value = parse(await readFile(path, "utf8"))
  } catch(cause) {
    if (isObject(cause) && cause.code === "ENOENT") return {}
    throw new Error(
      `Cannot inspect ${path}: ${asError(cause).message}. Fix the file, then rerun setup`,
      { cause },
    )
  }
  for (const key of keys) {
    if (!isObject(value)) break
    value = key in value ? value[key] : {}
  }
  if (!isObject(value)) {
    throw new Error(`Cannot inspect ${path}: ${keys.join(".")} is not an object. Fix the file`)
  }
  return value
}

/** ponytail: strips comments and trailing commas only; OpenCode needs no full JSON5 parser. */
function parseJsonc(source: string): unknown {
  return JSON.parse(stripTrailingCommas(stripJsonComments(source)))
}

function stripJsonComments(source: string): string {
  let output = ""
  let inString = false
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < source.length; index++) {
    const char = source[index] ?? ""
    const next = source[index + 1]
    if (lineComment) {
      if (char === "\n") {
        lineComment = false
        output += char
      }
      continue
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false
        index++
      }
      continue
    }
    if (inString) {
      output += char
      if (char === "\\") {
        output += source[++index] ?? ""
      } else if (char === "\"") {
        inString = false
      }
      continue
    }
    if (char === "\"") {
      inString = true
      output += char
      continue
    }
    if (char === "/" && next === "/") {
      lineComment = true
      index++
      continue
    }
    if (char === "/" && next === "*") {
      blockComment = true
      index++
      continue
    }
    output += char
  }
  return output
}

function stripTrailingCommas(source: string): string {
  let output = ""
  let inString = false
  for (let index = 0; index < source.length; index++) {
    const char = source[index] ?? ""
    if (inString) {
      output += char
      if (char === "\\") {
        output += source[++index] ?? ""
      } else if (char === "\"") {
        inString = false
      }
      continue
    }
    if (char === "\"") {
      inString = true
      output += char
      continue
    }
    if (char === ",") {
      let after = index + 1
      while (after < source.length && /\s/.test(source[after] ?? "")) after++
      if (source[after] === "}" || source[after] === "]") continue
    }
    output += char
  }
  return output
}

// Replaces one TOML table, or appends it; every other line stays byte-identical.
function upsertTomlTable(source: string, body: string): { contents: string; updated: boolean } {
  const lines = source.split("\n")
  const header = /^\s*\[\s*mcp_servers\s*\.\s*(?:chromex|"chromex")\s*\]\s*(?:#.*)?$/
  const start = lines.findIndex((line) => header.test(line))
  if (start === -1) {
    const prefix = source.trimEnd()
    return {
      contents: `${prefix}${prefix ? "\n\n" : ""}${body}\n`,
      updated: false,
    }
  }
  let end = start + 1
  while (end < lines.length && !/^\s*\[/.test(lines[end] ?? "")) end++
  const replacement = body.split("\n")
  if (end < lines.length) replacement.push("")
  const contents = [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join("\n")
  return { contents: contents.replace(/\n*$/, "\n"), updated: true }
}

function serverArgv(definition: Record<string, unknown>): unknown[] {
  if (Array.isArray(definition.command)) return definition.command
  return [definition.command].concat(Array.isArray(definition.args) ? definition.args : [])
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

// The plugin's server runs `.mcp.json` (`node ./dist/mcp-server.mjs`) from its Codex cache copy.
function fromChromexPlugin(server: unknown, codexHome: string): boolean {
  const transport = isObject(server) ? server.transport : undefined
  const cacheRoots = [pluginName, LEGACY.plugin].map((name) =>
    resolve(codexHome, "plugins/cache", marketplaceName, name),
  )
  const cwd = isObject(transport) && typeof transport.cwd === "string" ? transport.cwd : undefined
  return (
    cwd !== undefined &&
    isObject(transport) &&
    cacheRoots.some((cacheRoot) => resolve(cwd).startsWith(`${cacheRoot}/`)) &&
    transport.command === "node" &&
    isDeepStrictEqual(transport.args, ["./dist/mcp-server.mjs"])
  )
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}
