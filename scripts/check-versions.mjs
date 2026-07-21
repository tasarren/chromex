import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifests = [
  "package.json",
  "packages/extension/package.json",
  "packages/mcp/package.json",
  "packages/plugin/package.json",
  "packages/extension/static/manifest.json",
  "packages/plugin/src/chrome-browser-bridge/.codex-plugin/plugin.json",
];
const versions = await Promise.all(
  manifests.map(async (path) => {
    const manifest = JSON.parse(await readFile(resolve(root, path), "utf8"));
    return { path, version: manifest.version };
  }),
);
const expected = versions[0]?.version;
const mismatches = versions.filter(({ version }) => version !== expected);
if (typeof expected !== "string" || mismatches.length > 0) {
  throw new Error(`Chromex version mismatch: ${JSON.stringify(versions)}`);
}
console.log(`Chromex manifests share version ${expected}`);
