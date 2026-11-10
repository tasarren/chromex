import { expect, test } from "vitest"
import { CURSOR_SCRIPT } from "../../src/cursor.ts"

type CursorWindow = Window & {
  chromexCursor?: { host: HTMLElement }
  run?: (args: { x: number; y: number; held: boolean } | null) => { x: number; y: number } | null
}

async function page(): Promise<CursorWindow> {
  const frame = document.createElement("iframe")
  frame.srcdoc = `<!doctype html><body><p>page text</p><script>window.run = (${CURSOR_SCRIPT})</script>`
  document.body.append(frame)
  await new Promise<void>((resolve) => { frame.addEventListener("load", () => { resolve() }, { once: true }) })
  const win = frame.contentWindow
  if (!win) throw new Error("frame has no window")
  return win
}

test("draws a held point outside body text", async() => {
  const win = await page()
  const before = win.document.body.innerText
  expect(win.run?.({ x: 10, y: 20, held: false })).toEqual({ x: 10, y: 20 })
  expect(win.run?.({ x: 30, y: 40, held: true })).toEqual({ x: 30, y: 40 })
  const host = win.document.querySelector<HTMLElement>("chromex-cursor")
  expect(host?.getAttribute("aria-hidden")).toBe("true")
  expect(host?.style.transform).toBe("translate(30px, 40px)")
  expect(win.document.body.innerText).toBe(before)
  expect(win.run?.(null)).toEqual({ x: 30, y: 40 })
})

test("a new document starts without a point", async() => {
  const win = await page()
  expect(win.run?.(null)).toBeNull()
})
