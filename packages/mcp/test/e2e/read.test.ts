import { expect, test } from "vitest"
import { FIXTURE, useAgent } from "./client.ts"

const s = useAgent("read")
const readPage = `${FIXTURE}pages/read.html`

test("snapshot carries refs and filter all adds decorative nodes", async() => {
  await s.a.call("chrome_open", { url: readPage })
  const interactive = await s.a.call("chrome_snapshot")
  expect(interactive).toContain("[e1] button \"Action\"")
  expect(interactive).not.toContain("Decorative only")
  expect(await s.a.call("chrome_snapshot", { filter: "all" })).toContain("Decorative only")
})

test("a ref from before a navigation is refused", async() => {
  await s.a.call("chrome_navigate", { url: readPage })
  const snapshot = await s.a.call("chrome_snapshot")
  const ref = snapshot.match(/\[(e\d+)\] button "Action"/)?.[1]
  expect(ref).toBeDefined()
  await s.a.call("chrome_navigate", { url: `${FIXTURE}pages/second.html` })
  await expect(s.a.call("chrome_click", { ref })).rejects.toThrow(/snapshot|ref|latest|changed/i)
})

test("text truncates at maxChars and says so", async() => {
  await s.a.call("chrome_navigate", { url: readPage })
  const text = await s.a.call("chrome_text", { maxChars: 500 })
  expect(text).toContain("[truncated at 500 characters of ")
})

test("measure reads refs, selectors and styles", async() => {
  await s.a.call("chrome_navigate", { url: readPage })
  const snapshot = await s.a.call("chrome_snapshot")
  const ref = snapshot.match(/\[(e\d+)\] button "Action"/)?.[1]
  expect(ref).toBeDefined()
  const measured = await s.a.json<{
    refs: { ref: string; element: { id: string } | null }[]
    elements: { selector: string; element: { id: string } | null }[]
  }>("chrome_measure", {
    refs: [ref],
    selectors: ["#action", "#missing"],
    styles: ["display"],
  })
  expect(measured.refs[0]?.element?.id).toBe("action")
  expect(measured.elements[1]?.element).toBeNull()
})

test("viewport sets 390, 1440 and 1920", async() => {
  for (const width of [390, 1440, 1920]) {
    const result = await s.a.json<{ matchesRequested: boolean; viewport: { width: number } }>("chrome_viewport", { width, height: 800 })
    expect(result.matchesRequested).toBe(true)
    expect(result.viewport.width).toBe(width)
  }
})

test("wait finds delayed text and fails at its timeout", async() => {
  await s.a.call("chrome_navigate", { url: `${FIXTURE}pages/wait.html` })
  await s.a.call("chrome_wait", { text: "delayed ready", timeoutMs: 5_000 })
  expect(await s.a.call("chrome_text")).toContain("delayed ready")
  await expect(s.a.call("chrome_wait", { text: "never appears", timeoutMs: 300 })).rejects.toThrow()
})

test("console and network show the fixture error and requests", async() => {
  await s.a.call("chrome_navigate", { url: `${FIXTURE}pages/errors.html` })
  await s.a.call("chrome_wait", { text: "network 404 200", timeoutMs: 5_000 })
  const consoleEntries = await s.a.json<{ text?: string }[]>("chrome_console", { level: "error" })
  expect(JSON.stringify(consoleEntries)).toContain("fixture console error")
  const requests = await s.a.json<{ status?: number; url: string }[]>("chrome_network", { status: "all" })
  expect(requests.some((request) => request.url.endsWith("/missing.png") && request.status === 404)).toBe(true)
  expect(requests.some((request) => request.url.endsWith("/index.html") && request.status === 200)).toBe(true)
})
