#!/usr/bin/env node
/* eslint-disable no-console -- CLI output goes to stdout for workflow steps. */
// Builds the Chrome Web Store zip from a built extension directory. The bundled `dist/` keeps the
// manifest `key` for Managed mode; the store rejects `key`, so the zip uses a manifest without it.
import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

type StorePackage = { zip: string; sums: string; version: string }

type ZipEntry = { name: string; bytes: Uint8Array }

/** The manifest the store accepts: everything except the local development `key`. */
function storeManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const { key: _key, ...store } = manifest
  return store
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let value = n
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) value = (crcTable[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0)
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

// ponytail: stored entries and a fixed 1980-01-01 timestamp make a tag rebuild byte-for-byte
// reproducible without a zip dependency; switch to deflate if the upload size ever matters.
function createStoreZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const sum = crc32(entry.bytes)
    const local = new Uint8Array(30 + name.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, 0, true)
    localView.setUint16(8, 0, true)
    localView.setUint16(10, 0, true)
    localView.setUint16(12, 33, true)
    localView.setUint32(14, sum, true)
    localView.setUint32(18, entry.bytes.length, true)
    localView.setUint32(22, entry.bytes.length, true)
    localView.setUint16(26, name.length, true)
    localView.setUint16(28, 0, true)
    local.set(name, 30)
    parts.push(local, entry.bytes)

    const record = new Uint8Array(46 + name.length)
    const recordView = new DataView(record.buffer)
    recordView.setUint32(0, 0x02014b50, true)
    recordView.setUint16(4, 20, true)
    recordView.setUint16(6, 20, true)
    recordView.setUint16(8, 0, true)
    recordView.setUint16(10, 0, true)
    recordView.setUint16(12, 0, true)
    recordView.setUint16(14, 33, true)
    recordView.setUint32(16, sum, true)
    recordView.setUint32(20, entry.bytes.length, true)
    recordView.setUint32(24, entry.bytes.length, true)
    recordView.setUint16(28, name.length, true)
    recordView.setUint16(30, 0, true)
    recordView.setUint16(32, 0, true)
    recordView.setUint16(34, 0, true)
    recordView.setUint16(36, 0, true)
    recordView.setUint32(38, 0, true)
    recordView.setUint32(42, offset, true)
    record.set(name, 46)
    central.push(record)
    offset += local.length + entry.bytes.length
  }
  const directory = concat(central)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(4, 0, true)
  endView.setUint16(6, 0, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, directory.length, true)
  endView.setUint32(16, offset, true)
  endView.setUint16(20, 0, true)
  return concat([...parts, directory, end])
}

export async function packageStoreExtension(options: { source: string; out: string }): Promise<StorePackage> {
  const source = resolve(options.source)
  const out = resolve(options.out)
  const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8")) as Record<string, unknown>
  const version = manifest.version
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Unexpected extension version: ${String(version)}`)
  }
  if (!("key" in manifest)) {
    throw new Error("The bundled manifest has no key; refusing to build a store zip from it")
  }
  const storeBytes = new TextEncoder().encode(`${JSON.stringify(storeManifest(manifest), null, 2)}\n`)
  const entries: ZipEntry[] = []
  for (const entry of await readdir(source, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    const name = relative(source, path).split(sep).join("/")
    entries.push({ name, bytes: name === "manifest.json" ? storeBytes : new Uint8Array(await readFile(path)) })
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : 1))

  await mkdir(out, { recursive: true })
  const zipName = `chromex-${version}-chromium.zip`
  const zip = join(out, zipName)
  await writeFile(zip, createStoreZip(entries))
  const digest = createHash("sha256").update(await readFile(zip)).digest("hex")
  const sums = join(out, "SHA256SUMS.txt")
  await writeFile(sums, `${digest}  ${zipName}\n`)
  return { zip, sums, version }
}

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name)
  const value = index >= 0 ? args[index + 1] : undefined
  return value === undefined || value === "" ? fallback : value
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2)
  const result = await packageStoreExtension({
    source: option(args, "--source", "dist"),
    out: option(args, "--out", "dist-store"),
  })
  console.log(result.zip)
}
