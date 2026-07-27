import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type BridgeConfig = {
  managed?: boolean;
  extensionOrigin: string;
  socketPath: string;
  token: string;
};

export function configHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
}

export function bridgeConfigDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(configHome(env), "chrome-browser-bridge");
}

export function bridgeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CHROME_BROWSER_BRIDGE_CONFIG || join(bridgeConfigDirectory(env), "config.json");
}

export function bridgePolicyPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CHROME_BROWSER_BRIDGE_POLICY || join(bridgeConfigDirectory(env), "policy.json");
}

export function defaultSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  uid = typeof process.getuid === "function" ? process.getuid() : 0,
): string {
  const runtime = env.XDG_RUNTIME_DIR || tmpdir();
  return join(runtime, `chrome-browser-bridge-${uid}.sock`);
}
