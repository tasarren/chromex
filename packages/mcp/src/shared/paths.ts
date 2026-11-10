import { homedir } from "node:os"
import { join } from "node:path"
import { CONFIG_DIRECTORY, CONFIG_FILE, configHome } from "@chromex/protocol"
import { CONFIG_PATH_ENV } from "./env.ts"

export function bridgeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env[CONFIG_PATH_ENV] || join(configHome(env, env.HOME || homedir()), CONFIG_DIRECTORY, CONFIG_FILE)
}
