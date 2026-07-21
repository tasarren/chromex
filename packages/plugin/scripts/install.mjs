import { randomBytes } from "node:crypto";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installRoot = resolve(homedir(), "plugins/chrome-browser-bridge");
const configDir = resolve(homedir(), ".config/chrome-browser-bridge");
const runtimeDir = process.env.XDG_RUNTIME_DIR || `/tmp/chrome-browser-bridge-${process.getuid()}`;
const configPath = resolve(configDir, "config.json");
await mkdir(dirname(installRoot), { recursive: true });
await rm(installRoot, { force: true, recursive: true });
await cp(resolve(root, "dist/chrome-browser-bridge"), installRoot, { recursive: true });
await mkdir(configDir, { mode: 0o700, recursive: true });
await mkdir(runtimeDir, { mode: 0o700, recursive: true });
let token = randomBytes(32).toString("hex");
try {
  const existing = JSON.parse(await readFile(configPath, "utf8"));
  if (typeof existing.token === "string" && existing.token.length >= 32) token = existing.token;
} catch {}
const config = {
  extensionOrigin: "chrome-extension://enbcklgjkjddndpkedgfhoeagcbogfdb/",
  socketPath: resolve(runtimeDir, "bridge.sock"),
  token,
};
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
await chmod(configPath, 0o600);
const hostManifestPath = resolve(
  homedir(),
  ".config/chromium/NativeMessagingHosts/io.codex.chrome_bridge.json",
);
await mkdir(dirname(hostManifestPath), { recursive: true });
await writeFile(
  hostManifestPath,
  `${JSON.stringify({ name: "io.codex.chrome_bridge", description: "Local native messaging host for the Codex Chromium bridge", path: resolve(installRoot, "dist/native-host.mjs"), type: "stdio", allowed_origins: [config.extensionOrigin] }, null, 2)}\n`,
);
await chmod(resolve(installRoot, "dist/native-host.mjs"), 0o700);
console.log(`Installed plugin: ${installRoot}`);
console.log(`Registered native host: ${hostManifestPath}`);
console.log(`Load unpacked extension: ${resolve(root, "../extension/dist")}`);
