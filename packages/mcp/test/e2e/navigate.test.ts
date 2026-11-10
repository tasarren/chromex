import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, test } from "vitest"
import { FIXTURE, useAgent } from "./client.ts"

const s = useAgent("navigate")

test("navigate, back, forward and reload land on the expected pages", async() => {
  await s.a.call("chrome_open", { url: `${FIXTURE}pages/form.html` })
  expect(await s.a.call("chrome_text")).toContain("Fixture form")
  await s.a.call("chrome_navigate", { url: `${FIXTURE}pages/second.html` })
  expect(await s.a.call("chrome_text")).toContain("second page")
  await s.a.call("chrome_navigate", { action: "back" })
  expect(await s.a.call("chrome_text")).toContain("Fixture form")
  await s.a.call("chrome_navigate", { action: "forward" })
  expect(await s.a.call("chrome_text")).toContain("second page")
  await s.a.call("chrome_navigate", { action: "reload" })
  expect(await s.a.call("chrome_text")).toContain("second page")
})

test("navigate from chrome://version back to a web URL on the same tab", async() => {
  await s.a.call("chrome_open", { url: `${FIXTURE}pages/form.html` })
  await s.a.call("chrome_navigate", { url: "chrome://version" })
  await s.a.call("chrome_navigate", { url: `${FIXTURE}pages/second.html` })
  expect(await s.a.call("chrome_text")).toContain("second page")
})

test("an unreachable URL fails and appears in the network buffer", async() => {
  await s.a.call("chrome_open", { url: FIXTURE })
  await expect(s.a.call("chrome_navigate", { url: "http://127.0.0.1:1/" })).rejects.toThrow(/ERR|Navigation failed/)
  const requests = await s.a.json<{ url: string }[]>("chrome_network", { status: "all" })
  expect(requests.some((request) => request.url.includes("127.0.0.1:1"))).toBe(true)
})

test("a data URL opens and shows its content", async() => {
  await s.a.call("chrome_open", { url: "data:text/html,%3Ch1%3Echromex-agent%3C%2Fh1%3E" })
  expect(await s.a.call("chrome_text")).toContain("chromex-agent")
})

test("a file URL opens", async() => {
  const file = join(s.workspace, "page.html")
  await writeFile(file, "<!doctype html><title>Local</title><p>local file page</p>")
  await s.a.call("chrome_navigate", { url: pathToFileURL(file).href })
  expect(await s.a.call("chrome_text")).toContain("local file page")
})
