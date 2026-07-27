import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "dist");
await rm(out, { force: true, recursive: true });
await mkdir(out, { recursive: true });

const common = {
  bundle: true,
  format: "esm",
  legalComments: "none",
  logLevel: "info",
  platform: "node",
  sourcemap: true,
  target: "node22",
};
await Promise.all([
  build({
    ...common,
    entryPoints: [resolve(root, "src/mcp/managed-service.ts")],
    outfile: resolve(out, "managed-service.mjs"),
  }),
  build({
    ...common,
    banner: { js: "#!/usr/bin/env node" },
    entryPoints: [resolve(root, "src/native-host/index.ts")],
    outfile: resolve(out, "native-host.mjs"),
  }),
  build({
    ...common,
    entryPoints: [resolve(root, "src/mcp/server.ts")],
    outfile: resolve(out, "mcp-server.mjs"),
  }),
]);
await chmod(resolve(out, "native-host.mjs"), 0o700);
console.log(`Built MCP runtime: ${out}`);
