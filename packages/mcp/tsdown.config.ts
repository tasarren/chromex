import { chmod, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { defineConfig } from "tsdown"
import { z } from "zod"

const ManifestSchema = z.object({ license: z.string(), name: z.string(), version: z.string() })

// Notices cover exactly the npm packages bundled into the emitted chunks.
async function writeNotices(moduleIds: string[], outDir: string) {
  const directories = new Set<string>()
  for (const id of moduleIds) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(id)
    if (match?.[1]) directories.add(match[1])
  }
  const notices = await Promise.all(
    [...directories].map(async(directory) => {
      const manifest = ManifestSchema.parse(
        JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
      )
      const licenseFile = (await readdir(directory)).find((name) => /^licen[cs]e/i.test(name))
      if (!licenseFile) throw new Error(`No license file for bundled package ${manifest.name}`)
      const text = (await readFile(join(directory, licenseFile), "utf8")).trim()
      return `## ${manifest.name} ${manifest.version} (${manifest.license})\n\n\`\`\`text\n${text}\n\`\`\``
    }),
  )
  await writeFile(
    join(outDir, "THIRD_PARTY_NOTICES.md"),
    `# Third-party notices\n\nThe Chromex runtime bundles these packages.\n\n${notices.sort().join("\n\n")}\n`,
  )
}

export default defineConfig({
  entry: {
    "managed-service": "src/service/managed-service.ts",
    "mcp-server": "src/server/server.ts",
    "native-host": "src/native-host/index.ts",
  },
  banner: ({ fileName }) => (fileName === "native-host.mjs" ? "#!/usr/bin/env node" : undefined),
  deps: {
    alwaysBundle: [/^@modelcontextprotocol\/sdk(\/|$)/, /^zod(\/|$)/],
    // Exact closure observed in the build: SDK, Zod and their bundled transitives.
    onlyBundle: [
      "@modelcontextprotocol/sdk",
      "ajv",
      "ajv-formats",
      "fast-deep-equal",
      "fast-uri",
      "json-schema-traverse",
      "zod",
      "zod-to-json-schema",
    ],
    // Only Node built-ins may remain as runtime imports. tsdown does not inspect require().
    onlyImport: [],
  },
  dts: false,
  fixedExtension: true,
  format: "esm",
  hash: false,
  hooks: {
    "build:done": async({ chunks, options }) => {
      const moduleIds = chunks.flatMap((chunk) => (chunk.type === "chunk" ? chunk.moduleIds : []))
      await writeNotices(moduleIds, options.outDir)
      // The native host holds the bridge token path; keep it owner-only like the installed copy.
      await chmod(join(options.outDir, "native-host.mjs"), 0o700)
    },
  },
  outDir: "dist",
  platform: "node",
  sourcemap: false,
  target: "node24",
})
