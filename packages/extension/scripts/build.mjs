import { cp, mkdir, rm } from "node:fs/promises";
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
  platform: "browser",
  sourcemap: true,
  target: "chrome116",
};
await Promise.all([
  build({
    ...common,
    entryPoints: [resolve(root, "src/background.ts")],
    outfile: resolve(out, "background.js"),
  }),
  build({
    ...common,
    entryPoints: [resolve(root, "src/popup.ts")],
    outfile: resolve(out, "popup.js"),
  }),
]);
await cp(resolve(root, "static"), out, { recursive: true });
console.log(`Built Chromium extension: ${out}`);
