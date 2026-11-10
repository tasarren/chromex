import { describe, expect, test } from "vitest"
import { FIXTURE, useAgent, type Agent } from "./client.ts"
import { refFor } from "./refs.ts"

const s = useAgent("mouse")
type Rect = { x: number; y: number; width: number; height: number }

/** Viewport center of one selector; `near` is a button whose ref scrolls the selector into view. */
async function center(a: Agent, selector: string, near?: string): Promise<{ x: number; y: number }> {
  if (near) await a.call("chrome_scroll", { ref: refFor(await a.call("chrome_snapshot"), "button", near) })
  const [box] = (await a.json<{ elements: { element: { rect: Rect } | null }[] }>("chrome_measure", { selectors: [selector] })).elements
  const rect = box!.element!.rect
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
}

/** The pointer state line for a point at this width, with any scroll. */
const line = (x: number, y: number, held: string, width: number) =>
  new RegExp(`^cursor ${x},${y} held ${held} viewport ${width}x\\d+ scroll \\d+,\\d+$`)

describe.each([390, 1440, 1920])("at %i px", (width) => {
  test("click left, right and double at a ref and at a point land as trusted events", async() => {
    await s.a.call("chrome_open", { url: FIXTURE })
    await s.a.call("chrome_viewport", { width, height: 900 })
    const ref = refFor(await s.a.call("chrome_snapshot"), "button", "Button target")
    await s.a.call("chrome_click", { ref })
    await s.a.call("chrome_click", { ref, button: "right" })
    const point = await center(s.a, "#button-target")
    expect(await s.a.call("chrome_click", { ...point, count: 2 })).toMatch(line(point.x, point.y, "none", width))
    const page = await s.a.call("chrome_text")
    expect(page).toMatch(/click x=\d+ y=\d+ button=0 buttons=0 trusted=true/)
    expect(page).toMatch(/contextmenu x=\d+ y=\d+ button=2 buttons=2 trusted=true/)
    expect(page).toMatch(/dblclick x=\d+ y=\d+ button=0 buttons=0 trusted=true/)
  })

  test("hover shows the hover-only element", async() => {
    await s.a.call("chrome_navigate", { url: `${FIXTURE}pages/hover.html` })
    const hovered = await s.a.call("chrome_hover", { ref: refFor(await s.a.call("chrome_snapshot"), "button", "Hover target") })
    expect(hovered).toMatch(new RegExp(`^cursor \\d+,\\d+ held none viewport ${width}x\\d+ scroll \\d+,\\d+$`))
    const page = await s.a.call("chrome_text")
    expect(page).toContain("hover pointerover")
    expect(page).toContain("Hover-only content")
  })

  test("drag holds the button over a path, each step answers the state line", async() => {
    await s.a.call("chrome_navigate", { url: FIXTURE })
    const { x, y } = await center(s.a, "#canvas", "Reset canvas")
    expect(await s.a.call("chrome_mouse_down", { x: x - 60, y })).toMatch(line(x - 60, y, "left", width))
    expect(await s.a.call("chrome_mouse_move", { x, y: y + 20 })).toMatch(line(x, y + 20, "left", width))
    expect(await s.a.call("chrome_mouse_move", { x: x + 60, y })).toMatch(line(x + 60, y, "left", width))
    expect(await s.a.call("chrome_mouse_up")).toMatch(line(x + 60, y, "none", width))
    const page = await s.a.call("chrome_text")
    expect(page).toMatch(/canvas down x=\d+ y=\d+ button=0 buttons=1 trusted=true/)
    expect(page).toMatch(/canvas up x=\d+ y=\d+ button=0 buttons=0 trusted=true/)
    expect(page).toMatch(/strokes=1 points=([3-9]|\d\d+) held=false/)
    expect(JSON.parse(await s.a.call("chrome_status")).pointer).toMatch(line(x + 60, y, "none", width))
  })

  test("cancel releases the held button and a new down succeeds", async() => {
    await s.a.call("chrome_navigate", { url: FIXTURE })
    const point = await center(s.a, "#canvas", "Reset canvas")
    await s.a.call("chrome_mouse_down", point)
    expect(await s.a.call("chrome_mouse_down", point).catch(String)).toMatch(/already/)
    expect(await s.a.call("chrome_mouse_cancel")).toMatch(line(point.x, point.y, "none", width))
    expect(await s.a.call("chrome_text")).toMatch(/canvas up .*held=false|held=false[\s\S]*canvas up/)
    expect(await s.a.call("chrome_mouse_down", point)).toMatch(/ held left /)
    await s.a.call("chrome_mouse_cancel")
    expect(await s.a.call("chrome_mouse_cancel")).toMatch(/ held none /)
  })

  test("a point outside the viewport and the middle button are refused", async() => {
    await expect(s.a.call("chrome_click", { x: width + 50, y: 10 })).rejects.toThrow(/outside/)
    await expect(s.a.call("chrome_click", { x: 10, y: 10, button: "middle" })).rejects.toThrow()
    await expect(s.a.call("chrome_mouse_move", { x: 10, y: 10, contextId: "c", sequence: 1 })).rejects.toThrow()
  })

  test("a document change during a hold refuses the next move and reports held none", async() => {
    await s.a.call("chrome_navigate", { url: FIXTURE })
    const point = await center(s.a, "#canvas", "Reset canvas")
    await s.a.call("chrome_mouse_down", point)
    await s.a.call("chrome_navigate", { url: `${FIXTURE}pages/second.html` })
    const refused = await s.a.call("chrome_mouse_move", { x: point.x + 10, y: point.y }).catch(String)
    expect(refused).toMatch(/held none/)
    expect(refused).toMatch(/^Error: /)
  })
})
