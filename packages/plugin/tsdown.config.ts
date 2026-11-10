import { defineConfig } from "tsdown"

const plugin = "dist/chromex"

// Bundles the CLI and assembles the Codex plugin from the MCP and extension builds.
// tsdown runs copies concurrently, so no entry may copy a directory another entry also creates.
export default defineConfig({
  entry: { cli: "src/cli.ts" },
  copy: [
    ...[".agents", ".codex-plugin", ".mcp.json"].map((name) => ({
      from: `src/chromex/${name}`,
      to: plugin,
    })),
    { from: "../../skills/chromex", to: `${plugin}/skills` },
    { from: "../../LICENSE", to: plugin },
    { from: "../mcp/dist/THIRD_PARTY_NOTICES.md", to: plugin },
    { from: "../mcp/dist/*.mjs", to: `${plugin}/dist` },
    { from: "../extension/dist", rename: "extension", to: `${plugin}/dist` },
  ],
  deps: { onlyBundle: [], onlyImport: [] },
  dts: false,
  fixedExtension: true,
  format: "esm",
  outDir: "dist",
  platform: "node",
  sourcemap: false,
  target: "node24",
})
