import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, test } from "vitest"

const repo = resolve(import.meta.dirname, "../../../..")
const manifests = [
  "package.json",
  "packages/extension/package.json",
  "packages/mcp/package.json",
  "packages/protocol/package.json",
  "packages/plugin/package.json",
  "packages/extension/static/manifest.json",
  "packages/plugin/src/chromex/.codex-plugin/plugin.json",
]

test("every published manifest shares a stable version", async() => {
  const versions = await Promise.all(
    manifests.map(async(path) => {
      const manifest = JSON.parse(await readFile(resolve(repo, path), "utf8")) as { version?: unknown }
      return { path, version: manifest.version }
    }),
  )
  const expected = versions[0]?.version
  expect(expected).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  expect(versions.filter(({ version }) => version !== expected)).toEqual([])
})
