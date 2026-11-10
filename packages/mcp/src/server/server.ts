import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { parseArgs } from "node:util"
import manifest from "../../package.json" with { type: "json" }
import { configuredExtensions, prepareConfiguredExtensions, resolveExtensionDirectory } from "../shared/extension-list.ts"
import { validateProfileName } from "../service/managed-browser.ts"
import { SessionBrowser } from "./session-browser.ts"
import { registerTools } from "./tools.ts"
import { resolveWorkspace } from "../shared/workspace.ts"

const { values: args } = parseArgs({
  options: {
    extension: { type: "string", multiple: true },
    profile: { type: "string" },
    workspace: { type: "string" },
  },
})
const defaultProfile = args.profile ?? process.env.CHROMEX_PROFILE
// An invalid entry must not stop the server; report it and keep the rest. A transient filesystem
// error keeps the path for the service to retry. Installation happens on first use of the profile,
// through its service, so a browser that is already running receives the extensions too.
const extensions = configuredExtensions(args.extension, process.env.CHROMEX_EXTENSIONS)
const resolvedExtensions = await prepareConfiguredExtensions(
  extensions,
  resolveExtensionDirectory,
  (message) => process.stderr.write(`${message}\n`),
)
const server = new McpServer(
  { name: "chromex", version: manifest.version },
  {
    instructions:
      "Use the chromex skill and chrome_help. Managed Chromium is default; chrome_status returns browserId for reuse. Open a URL, snapshot, then interact through refs. Navigation failures require chrome_network and a reachable server. Observe requires user popup consent.",
  },
)
const session = new SessionBrowser(
  async() => await resolveWorkspace({
    claudeProjectDir: process.env.CLAUDE_PROJECT_DIR,
    cwd: process.cwd(),
    env: process.env,
    explicit: args.workspace,
    home: await realpath(homedir()).catch(() => homedir()),
  }),
  defaultProfile ? validateProfileName(defaultProfile) : undefined,
  resolvedExtensions,
)
registerTools(server, session)

const transport = new StdioServerTransport()
let shuttingDown: Promise<void> | null = null
function shutdown(): Promise<void> {
  shuttingDown ??= Promise.allSettled([session.close(), server.close()]).then(() => undefined)
  return shuttingDown
}
process.stdin.once("end", () => void shutdown())
process.stdin.once("close", () => void shutdown())
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown().finally(() => process.exit(0)))
}
await server.connect(transport)
