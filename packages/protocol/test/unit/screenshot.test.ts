import { expect, test } from "vitest"
import { formatScreenshotLine } from "../../src/cursor.ts"
import { parseInspection } from "../../src/inspection.ts"
import type { PointerState } from "../../src/cursor.ts"

const state: PointerState = {
  cursor: { x: 512, y: 300 },
  held: null,
  viewport: { width: 1440, height: 901 },
  scroll: { x: 0, y: 320 },
}

test("formatScreenshotLine renders the metadata line and an optional path", () => {
  expect(formatScreenshotLine({ width: 1440, height: 901 }, state))
    .toBe("png 1440x901 css 1440x901 scale 1 scroll 0,320 cursor 512,300 held none")
  expect(formatScreenshotLine({ width: 390, height: 844 }, { ...state, viewport: { width: 391, height: 844 } }))
    .toBe("png 390x844 css 391x844 scale 1 scroll 0,320 cursor 512,300 held none")
  expect(formatScreenshotLine({ width: 390, height: 900 }, { ...state, viewport: { width: 391, height: 901 } }))
    .toBe("png 390x900 css 391x901 scale 1 scroll 0,320 cursor 512,300 held none")
  expect(formatScreenshotLine({ width: 1440, height: 901 }, state, { file: "/abs/file.png", bytes: 48_211 }))
    .toBe("png 1440x901 css 1440x901 scale 1 scroll 0,320 cursor 512,300 held none path /abs/file.png bytes 48211")
})

test("an aspect mismatch omits scale and ends with mapping none", () => {
  expect(formatScreenshotLine({ width: 1440, height: 800 }, state))
    .toBe("png 1440x800 css 1440x901 scroll 0,320 cursor 512,300 held none mapping none")
})

test("parseInspection defaults clean to false and rejects a non-boolean", () => {
  expect(parseInspection({ kind: "screenshot" })).toEqual({ kind: "screenshot", clean: false })
  expect(parseInspection({ kind: "screenshot", clean: true })).toEqual({ kind: "screenshot", clean: true })
  expect(() => parseInspection({ kind: "screenshot", clean: "yes" })).toThrow("Invalid inspection request")
})
