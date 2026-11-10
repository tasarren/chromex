import { expect, test } from "vitest"
import { FIXTURE, useAgent } from "./client.ts"

const s = useAgent("cursor")
type Measured = { elements: { element: { rect: { x: number; y: number } } | null }[] }
const cursorBox = async() => (await s.a.json<Measured>("chrome_measure", { selectors: ["chromex-cursor"] })).elements[0]!.element

test("after a move the cursor host sits at the point and stays out of text and snapshot", async() => {
  await s.a.call("chrome_open", { url: FIXTURE })
  await s.a.call("chrome_mouse_move", { x: 200, y: 150 })
  expect(await cursorBox()).toMatchObject({ rect: { x: 200, y: 150 } })
  const snapshot = (await s.a.call("chrome_snapshot", { filter: "all" })).split("\n")
  expect(snapshot.slice(1).join("\n")).not.toMatch(/chromex-cursor|img ""|graphics/i)
  expect(await s.a.call("chrome_text")).not.toContain("chromex-cursor")
})

test("release removes the cursor from a web tab", async() => {
  const { selectedTabId } = await s.a.json<{ selectedTabId: number }>("chrome_status")
  await s.a.call("chrome_release")
  await s.a.call("chrome_use_tab", { tabId: selectedTabId })
  expect(await cursorBox()).toBeNull()
})

test("release removes the cursor on chrome://version (ISS-07)", async() => {
  await s.a.call("chrome_navigate", { url: "chrome://version" })
  await s.a.call("chrome_mouse_move", { x: 120, y: 90 })
  expect(await cursorBox()).toMatchObject({ rect: { x: 120, y: 90 } })
  const { selectedTabId } = await s.a.json<{ selectedTabId: number }>("chrome_status")
  await s.a.call("chrome_release")
  await s.a.call("chrome_use_tab", { tabId: selectedTabId })
  expect(await cursorBox()).toBeNull()
})
