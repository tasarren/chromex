import { resolve } from "node:path"
import { expect, test } from "vitest"
import { FIXTURE, useAgent } from "./client.ts"

const s = useAgent("extensions")
const path = resolve(import.meta.dirname, "../../../extension/dev/extension")

test("an installed extension runs on the fixture page", async() => {
  await s.a.call("chrome_open", { url: FIXTURE })
  await s.a.call("chrome_extension_install", { path })
  await s.a.call("chrome_navigate", { action: "reload" })
  await s.a.call("chrome_wait", { text: "test extension loaded", timeoutMs: 5_000 })
  expect(await s.a.call("chrome_text")).toContain("test extension loaded")
})

test("extension list shows the loaded and listed directory", async() => {
  const list = await s.a.json<{ extensions: { id?: string }[]; listed: string[] }>("chrome_extension_list")
  expect(list.listed).toContain(path)
  expect(list.extensions.length).toBeGreaterThan(0)
})

test("process output names the browser process", async() => {
  const output = await s.a.json<{ process: { pid: number; state: string } }>("chrome_process_output")
  expect(output.process.pid).toBeGreaterThan(0)
})

test.todo("TASK-03: browser restart keeps the extension loaded")
