import { expect, test } from "vitest"
import { EASED_EVENTS, easedPath, formatPointerState } from "../../src/cursor.ts"

test("a move ends exactly at its target and stays on the segment", () => {
  const path = easedPath({ x: 0, y: 0 }, { x: 100, y: 200 })
  expect(path).toHaveLength(EASED_EVENTS)
  expect(path.at(-1)).toEqual({ x: 100, y: 200 })
  for (const point of path) {
    expect(point.x).toBeGreaterThanOrEqual(0)
    expect(point.x).toBeLessThanOrEqual(100)
    expect(point.y).toBeGreaterThanOrEqual(0)
    expect(point.y).toBeLessThanOrEqual(200)
  }
})

test("no previous point yields one step at the target", () => {
  expect(easedPath(null, { x: 7, y: 9 })).toEqual([{ x: 7, y: 9 }])
  expect(easedPath({ x: 7, y: 9 }, { x: 7, y: 9 })).toEqual([{ x: 7, y: 9 }])
})

test("formatPointerState renders the one-line pointer state", () => {
  const viewport = { width: 1440, height: 901 }
  expect(formatPointerState({ cursor: { x: 511.6, y: 300.2 }, held: "left", viewport, scroll: { x: 0, y: 320 } }))
    .toBe("cursor 512,300 held left viewport 1440x901 scroll 0,320")
  expect(formatPointerState({ cursor: null, held: null, viewport, scroll: { x: 0, y: 0 } }))
    .toBe("cursor none held none viewport 1440x901 scroll 0,0")
})
