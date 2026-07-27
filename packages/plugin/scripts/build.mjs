import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "dist/chrome-browser-bridge");
const extensionOut = resolve(root, "../extension/dist");
const mcpOut = resolve(root, "../mcp/dist");
await rm(resolve(root, "dist"), { force: true, recursive: true });
await mkdir(resolve(out, "dist"), { recursive: true });
await cp(resolve(root, "src/chrome-browser-bridge"), out, { recursive: true });
await cp(resolve(root, "../../skills/chrome-browser"), resolve(out, "skills/chrome-browser"), {
  recursive: true,
});
await Promise.all([
  cp(resolve(mcpOut, "managed-service.mjs"), resolve(out, "dist/managed-service.mjs")),
  cp(resolve(mcpOut, "managed-service.mjs.map"), resolve(out, "dist/managed-service.mjs.map")),
  cp(resolve(mcpOut, "mcp-server.mjs"), resolve(out, "dist/mcp-server.mjs")),
  cp(resolve(mcpOut, "mcp-server.mjs.map"), resolve(out, "dist/mcp-server.mjs.map")),
  cp(resolve(mcpOut, "native-host.mjs"), resolve(out, "dist/native-host.mjs")),
  cp(resolve(mcpOut, "native-host.mjs.map"), resolve(out, "dist/native-host.mjs.map")),
  cp(extensionOut, resolve(out, "dist/extension"), { recursive: true }),
]);
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
await writeFile(
  resolve(out, "package.json"),
  `${JSON.stringify({ name: "chrome-browser-bridge-runtime", private: true, type: "module", version: packageJson.version }, null, 2)}\n`,
);
await chmod(resolve(out, "dist/native-host.mjs"), 0o700);
console.log(`Assembled Codex plugin: ${out}`);
