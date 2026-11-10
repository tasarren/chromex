#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import manifest from "../package.json" with { type: "json" }
import { asError, pluginName, type Scope } from "./clients.ts"
import { installChromex } from "./setup.ts"

const usage = `Usage: chromex <command>

Commands:
  setup [--no-open] [--browsers all|none|<name,...>] [--scope project|global] [--skills none]
                     Install the Chromex runtime under ~/plugins/${pluginName}, write the bridge
                     token, register the native host and skill, and configure detected Codex,
                     Claude Code, and OpenCode CLIs. --no-open skips opening the store page.
  --help, -h         Show this help.
  --version, -v      Show the Chromex version.

Installing the package does not configure any application until you run \`chromex setup\`.`

type Logger = Pick<Console, "error" | "log" | "warn">
type SetupArguments = {
  browsers?: string;
  installSkill: boolean;
  noOpen: boolean;
  scope?: Scope;
}

function parseSetupArguments(args: string[]): { error: string } | { options: SetupArguments } {
  const options: SetupArguments = { installSkill: true, noOpen: false }
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === "--no-open") {
      options.noOpen = true
      continue
    }
    if (argument !== "--browsers" && argument !== "--scope" && argument !== "--skills") {
      return { error: `Unknown argument: ${argument}` }
    }
    const value = args[++index]
    if (value === undefined) return { error: `Missing value for ${argument}` }
    if (argument === "--browsers") {
      options.browsers = value
    } else if (argument === "--scope") {
      if (value !== "project" && value !== "global") {
        return { error: "--scope must be project or global" }
      }
      options.scope = value
    } else if (value === "none") {
      options.installSkill = false
    } else {
      return { error: "--skills accepts only none" }
    }
  }
  return { options }
}

/** Parse the command line and return the exit status. Only `setup` writes anything. */
export async function main(
  argumentsList: string[] = process.argv.slice(2),
  logger: Logger = console,
): Promise<number> {
  const [command, ...rest] = argumentsList.filter((argument) => argument !== "--")
  switch (command) {
    case undefined:
    case "--help":
    case "-h":
      logger.log(usage)
      return 0
    case "--version":
    case "-v":
      logger.log(manifest.version)
      return 0
    case "setup":
      break
    default:
      logger.error(`Unknown argument: ${command}\n\n${usage}`)
      return 2
  }
  const parsed = parseSetupArguments(rest)
  if ("error" in parsed) {
    logger.error(`${parsed.error}\n\n${usage}`)
    return 2
  }
  try {
    const result = await installChromex({ logger, ...parsed.options })
    return result.clientResults.some((client) => client.status === "failed") ? 1 : 0
  } catch(cause) {
    logger.error(`Chromex setup failed: ${asError(cause).message}`)
    return 1
  }
}

// npm runs bins through a symlink; compare real paths so the entry point still starts.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
