import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { packageStoreExtension } from "../../scripts/package.ts"

/** Reads the stored, uncompressed entries of a zip this package builds. */
function entries(zip: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const found = new Map<string, Uint8Array>()
  let offset = 0
  while (view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const name = new TextDecoder().decode(zip.subarray(offset + 30, offset + 30 + nameLength))
    const start = offset + 30 + nameLength + extraLength
    found.set(name, zip.subarray(start, start + size))
    offset = start + size
  }
  return found
}

test("the store zip drops the manifest key and keeps the version", async() => {
  const dir = await mkdtemp(join(process.env.CHROMEX_TMP ?? tmpdir(), "chromex-store-"))
  const source = join(dir, "dist")
  await mkdir(source)
  await writeFile(join(source, "manifest.json"), JSON.stringify({
    manifest_version: 3,
    name: "Chromex",
    version: "0.1.3",
    key: "local-development-key",
  }))
  await writeFile(join(source, "background.js"), "export {}\n")

  const { zip } = await packageStoreExtension({ source, out: join(dir, "dist-store") })

  const stored = entries(new Uint8Array(await readFile(zip)))
  const manifest = stored.get("manifest.json")
  if (!manifest) throw new Error("manifest.json is missing from the store zip")
  const parsed = JSON.parse(new TextDecoder().decode(manifest)) as Record<string, unknown>
  expect(parsed).not.toHaveProperty("key")
  expect(parsed.version).toBe("0.1.3")
  expect(stored.has("background.js")).toBe(true)
})
