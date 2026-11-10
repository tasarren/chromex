import { describe, expect, test } from "vitest"
import { FIXTURE, connect, useAgent } from "./client.ts"
import { refFor } from "./refs.ts"

const s = useAgent("scroll")
const page = `${FIXTURE}pages/scroll.html`
type Rect = { x: number; y: number; width: number; height: number }

test("a wheel scrolls the box in a tab that was never selected (1c8da8b)", async() => {
  await s.a.call("chrome_open", { url: FIXTURE })
  const b = await connect(s.workspace)
  try {
    expect((await b.json<{ active: boolean }>("chrome_open", { url: page })).active).toBe(false)
    const [box] = (await b.json<{ elements: { element: { rect: Rect } | null }[] }>("chrome_measure", { selectors: ["#inner"] })).elements
    const rect = box!.element!.rect
    await b.call("chrome_scroll", { x: Math.round(rect.x + 20), y: Math.round(rect.y + rect.height / 2), direction: "down", amount: 200 })
    await b.call("chrome_wait", { text: "inner 200", timeoutMs: 5_000 })
  } finally {
    await b.close()
  }
})

describe.each([390, 1440, 1920])("at %i px", (width) => {
  test("page wheel down and up changes scrollY", async() => {
    await s.a.call("chrome_open", { url: page })
    await s.a.call("chrome_viewport", { width, height: 900 })
    await s.a.call("chrome_scroll", { direction: "down", amount: 400 })
    expect(await s.a.call("chrome_text")).toContain("scrollY 400")
    await s.a.call("chrome_scroll", { direction: "up", amount: 400 })
    expect(await s.a.call("chrome_text")).toContain("scrollY 0")
  })

  test("a wheel at a point scrolls only the box under it", async() => {
    await s.a.call("chrome_navigate", { url: page })
    const [box] = (await s.a.json<{ elements: { element: { rect: Rect } | null }[] }>("chrome_measure", { selectors: ["#inner"] })).elements
    const rect = box!.element!.rect
    // Right edge of the box: x >= 800 at 1440 and 1920 px (ISS-16 headless window width).
    const x = Math.round(rect.x + rect.width - 20)
    const y = Math.round(rect.y + rect.height / 2)
    const result = await s.a.call("chrome_scroll", { x, y, direction: "down", amount: 200 })
    expect(result).toMatch(new RegExp(`^cursor ${x},${y} held none viewport ${width}x\\d+ scroll 0,0$`))
    await s.a.call("chrome_wait", { text: "inner 200", timeoutMs: 5_000 })
    expect(await s.a.call("chrome_text")).toContain("scrollY 0")
    await expect(s.a.call("chrome_scroll", { x: width + 50, y: 10 })).rejects.toThrow()
  })

  test("a ref scrolls an element into view", async() => {
    await s.a.call("chrome_navigate", { url: page })
    const far = refFor(await s.a.call("chrome_snapshot"), "button", "Far target")
    await s.a.call("chrome_scroll", { ref: far })
    const measured = await s.a.json<{ elements: { element: { rect: { y: number } } | null }[] }>(
      "chrome_measure",
      { selectors: ["#far"] },
    )
    expect(measured.elements[0]?.element?.rect.y).toBeLessThan(900)
  })
})
