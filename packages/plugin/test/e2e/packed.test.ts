import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { expect, test } from "vitest"

const run = promisify(execFile)
const repo = resolve(import.meta.dirname, "../../../..")
const tempBase = process.env.CHROMEX_TMP ?? tmpdir()

// A Codex CLI without the `plugin` command: setup must fall back to `codex mcp add` (d0cf0a9).
const codexStub = `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require("node:fs")
const state = process.env.HOME + "/codex-servers.json"
const servers = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : []
const [command, action, name, , node, runtime] = process.argv.slice(2)
if (command === "--help") console.log("Commands:\\n  exec  Run\\n  mcp   Manage MCP servers")
else if (action === "list") console.log(JSON.stringify(servers))
else if (action === "add") writeFileSync(state, JSON.stringify([...servers, { name, transport: { type: "stdio", command: node, args: [runtime] } }]))
else if (action === "remove") writeFileSync(state, JSON.stringify(servers.filter((server) => server.name !== name)))
else process.exit(1)
`

test("the packed plugin installs, registers Codex without its plugin command, replaces an old install, and its MCP server starts", async() => {
  await mkdir(tempBase, { recursive: true })
  const root = await mkdtemp(join(tempBase, "packed-"))
  const prefix = join(root, "prefix")
  const home = join(root, "home")
  const bin = join(root, "bin")
  const config = join(root, "config")
  const env = {
    ...process.env,
    CHROMEX_BROWSER: "",
    HOME: home,
    PATH: `${bin}:${dirname(process.execPath)}`,
    XDG_CONFIG_HOME: config,
    XDG_RUNTIME_DIR: join(root, "run"),
  }
  let client: Client | undefined
  try {
    await mkdir(bin)
    await writeFile(join(bin, "codex"), codexStub, { mode: 0o755 })
    await writeFile(join(bin, "claude"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HOME/claude.log\"\n", { mode: 0o755 })
    await writeFile(
      join(bin, "opencode"),
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HOME/opencode.log\"\ncase \"$*\" in *--help*) echo '  --global' ;; esac\n",
      { mode: 0o755 },
    )
    await writeFile(
      join(bin, "grok"),
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HOME/grok.log\"\ncase \"$*\" in 'mcp list --json') echo '[]' ;; esac\n",
      { mode: 0o755 },
    )
    await writeFile(join(bin, "cursor"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    await writeFile(join(bin, "chromium"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    await writeFile(join(bin, "brave-browser"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    await writeFile(join(bin, "npx"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HOME/skills.log\"\n", { mode: 0o755 })
    await writeFile(join(bin, "package.json"), "{\"type\":\"commonjs\"}")
    await mkdir(join(config, "opencode"), { recursive: true })
    const opencodeConfig = join(config, "opencode/opencode.jsonc")
    await writeFile(opencodeConfig, "{\n  // keep this comment\n  /* and this one */\n  \"mcp\": {\n    \"servers\": {\n      // { \"disabled\": true },\n    }, // trailing comma before a comment\n  },\n}\n")
    const { stdout } = await run("npm", ["pack", "--pack-destination", root, "--json"], { cwd: join(repo, "packages/plugin") })
    const packed = Object.values(JSON.parse(stdout) as Record<string, { filename: string }>)[0]
    if (!packed) throw new Error("npm pack produced no tarball")
    await run("npm", ["install", "--no-save", "--prefix", prefix, join(root, packed.filename)], { cwd: root })
    const cli = join(prefix, "node_modules/.bin/chromex")
    const first = await run(cli, ["setup", "--no-open"], { cwd: root, env })
    const server = join(home, "plugins/chromex/dist/mcp-server.mjs")
    expect(first.stdout).toMatch(/\[1\/\d+\] Copy the Chromex runtime\.\.\./)
    expect(first.stdout).toMatch(/\] Register Codex\.\.\./)
    expect(first.stdout).toMatch(/\] Install the Chromex skill\.\.\./)
    expect(first.stdout).toContain("  done")
    const codex = JSON.parse(await readFile(join(home, "codex-servers.json"), "utf8")) as { name: string; transport: { args: string[] } }[]
    expect(codex).toEqual([expect.objectContaining({ name: "chromex", transport: expect.objectContaining({ args: [server] }) })])
    expect((await readFile(join(home, "opencode.log"), "utf8")).trim().split("\n").at(-1)).toBe(
      `mcp add chromex --global -- ${process.execPath} ${server}`,
    )
    expect((await readFile(join(home, "grok.log"), "utf8")).trim().split("\n").at(-1)).toBe(
      `mcp add -s user chromex -- ${process.execPath} ${server}`,
    )
    expect(JSON.parse(await readFile(join(home, ".cursor/mcp.json"), "utf8")).mcpServers.chromex)
      .toEqual({ args: [server], command: process.execPath })
    expect(await readFile(opencodeConfig, "utf8")).toContain("// keep this comment")
    const chromiumHost = join(config, "chromium/NativeMessagingHosts/io.tasarren.chromex.json")
    const braveHost = join(config, "BraveSoftware/Brave-Browser/NativeMessagingHosts/io.tasarren.chromex.json")
    const chromeHost = join(config, "google-chrome/NativeMessagingHosts/io.tasarren.chromex.json")
    expect(await exists(chromiumHost)).toBe(true)
    expect(await exists(braveHost)).toBe(true)
    expect(await exists(chromeHost)).toBe(false)
    expect(JSON.parse(await readFile(chromiumHost, "utf8"))).toMatchObject({
      allowed_origins: ["chrome-extension://enbcklgjkjddndpkedgfhoeagcbogfdb/"],
      name: "io.tasarren.chromex",
    })
    const skillsLog = join(home, "skills.log")
    const skillArgs = `--yes skills@1.7.6 add ${join(home, "plugins/chromex")} --skill chromex -y`
    expect((await readFile(skillsLog, "utf8")).trim()).toBe(`${skillArgs} -g`)

    // A second setup over entries an earlier release wrote leaves only the new names.
    const legacyRoot = join(home, "plugins/chrome-browser-bridge")
    const legacySkill = join(legacyRoot, "skills/chrome-browser")
    await mkdir(legacySkill, { recursive: true })
    await mkdir(join(home, ".agents/skills"), { recursive: true })
    await symlink(legacySkill, join(home, ".agents/skills/chrome-browser"))
    const legacyHost = join(config, "chromium/NativeMessagingHosts/io.codex.chrome_bridge.json")
    const foreignHost = join(config, "google-chrome/NativeMessagingHosts/io.codex.chrome_bridge.json")
    await mkdir(dirname(legacyHost), { recursive: true })
    await mkdir(dirname(foreignHost), { recursive: true })
    await writeFile(legacyHost, JSON.stringify({ name: "io.codex.chrome_bridge" }))
    const foreignManifest = JSON.stringify({ name: "not-chromex" })
    await writeFile(foreignHost, foreignManifest)
    await writeFile(join(home, "codex-servers.json"), JSON.stringify([
      ...codex,
      { name: "chrome-browser-bridge", transport: { type: "stdio", command: process.execPath, args: [join(legacyRoot, "dist/mcp-server.mjs")] } },
    ]))
    await run(cli, ["setup", "--no-open", "--browsers", "chromium"], { cwd: root, env })
    expect(await exists(legacyRoot)).toBe(false)
    expect(await readdir(join(home, ".agents/skills"))).toEqual([])
    expect(await exists(legacyHost)).toBe(false)
    expect(await readFile(foreignHost, "utf8")).toBe(foreignManifest)
    expect(await exists(chromiumHost)).toBe(true)
    expect(await exists(chromeHost)).toBe(false)
    expect(JSON.parse(await readFile(join(home, "codex-servers.json"), "utf8"))).toEqual([
      expect.objectContaining({ name: "chromex", transport: expect.objectContaining({ args: [server] }) }),
    ])
    expect((await readFile(skillsLog, "utf8")).trim().split("\n")).toEqual([`${skillArgs} -g`, `${skillArgs} -g`])

    // Project scope: .mcp.json once, Codex TOML, OpenCode project config.
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "echo" } } }))
    await writeFile(join(root, "opencode.jsonc"), "{\n  // project comment\n  \"mcp\": { \"servers\": {} }\n}\n")
    const project = await run(cli, ["setup", "--no-open", "--browsers", "none", "--scope", "project", "--skills", "none"], { cwd: root, env })
    expect(project.stdout).toContain("] Write the project .mcp.json...")
    expect(project.stdout).toMatch(/\] Register Codex\.\.\./)
    const projectMcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> }
    expect(projectMcp.mcpServers.chromex).toEqual({
      args: [server],
      command: process.execPath,
      type: "stdio",
    })
    expect(projectMcp.mcpServers.other).toEqual({ command: "echo" })
    const codexProject = await readFile(join(root, ".codex/config.toml"), "utf8")
    expect(codexProject).toContain("[mcp_servers.chromex]")
    expect(codexProject).toContain(`command = ${JSON.stringify(process.execPath)}`)
    expect(codexProject).toContain(`args = [${JSON.stringify(server)}]`)
    expect((await readFile(join(home, "opencode.log"), "utf8")).trim().split("\n").at(-1)).toBe(
      `mcp add chromex -- ${process.execPath} ${server}`,
    )
    expect((await readFile(join(home, "grok.log"), "utf8")).trim().split("\n").at(-1)).toBe(
      `mcp add -s user chromex -- ${process.execPath} ${server}`,
    )
    expect(await readFile(join(root, "opencode.jsonc"), "utf8")).toContain("// project comment")
    expect((await readFile(skillsLog, "utf8")).trim().split("\n")).toHaveLength(2)
    expect(await exists(chromeHost)).toBe(false)

    // DEC-11: a second project setup replaces its own entry instead of adding a twin.
    const again = await run(cli, ["setup", "--no-open", "--browsers", "none", "--scope", "project", "--skills", "none"], { cwd: root, env })
    expect(again.stdout).toContain("updated; Codex loads it only for a trusted project")
    expect(again.stdout).toContain("] Write the project .mcp.json...\n  already current")
    expect(((await readFile(join(root, ".codex/config.toml"), "utf8")).match(/\[mcp_servers\.chromex\]/g) ?? [])).toHaveLength(1)

    client = new Client({ name: "packed-e2e", version: "0" })
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [server],
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: join(root, "run") },
    }))
    const tools = await client.listTools()
    expect(tools.tools).toHaveLength(30)
    expect(tools.tools.map((tool) => tool.name)).toContain("chrome_help")
    const help = await client.callTool({ name: "chrome_help", arguments: {} })
    expect(help.isError).not.toBe(true)
  } finally {
    await client?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)
