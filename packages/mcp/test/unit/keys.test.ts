import { expect, test } from "vitest"
import { parseChord } from "../../src/server/keys.ts"

test("named keys carry a code and virtual key code", () => {
  // Chromium will not submit a form on Enter without the carriage return.
  expect(parseChord("Enter")).toEqual({
    code: "Enter",
    key: "Enter",
    modifiers: 0,
    text: "\r",
    windowsVirtualKeyCode: 13,
  })
  expect(parseChord("escape").code).toBe("Escape")
  expect(parseChord("ArrowDown").windowsVirtualKeyCode).toBe(40)
})

test("only character-producing named keys send text", () => {
  expect(parseChord("Tab").text).toBeUndefined()
  expect(parseChord("Backspace").text).toBeUndefined()
  expect(parseChord("Escape").text).toBeUndefined()
  expect(parseChord("Space").text).toBe(" ")
  expect(parseChord("Ctrl+Enter").text).toBeUndefined()
})

test("modifiers combine into the CDP bitmask", () => {
  expect(parseChord("Ctrl+A")).toEqual({
    code: "KeyA",
    key: "a",
    modifiers: 2,
    windowsVirtualKeyCode: 65,
  })
  expect(parseChord("Shift+Tab")).toEqual({
    code: "Tab",
    key: "Tab",
    modifiers: 8,
    windowsVirtualKeyCode: 9,
  })
  expect(parseChord("Ctrl+Shift+P").modifiers).toBe(10)
  expect(parseChord("Meta+A").modifiers).toBe(4)
})

test("plain and shifted characters keep text", () => {
  expect(parseChord("a").text).toBe("a")
  expect(parseChord("Shift+a").key).toBe("A")
  expect(parseChord("Shift+a").text).toBe("A")
  expect(parseChord("A").key).toBe("A")
  expect(parseChord("A").modifiers).toBe(8)
  expect(parseChord("?").text).toBe("?")
  expect(parseChord("?").code).toBe("")
})

test("unknown keys and modifiers are rejected", () => {
  expect(() => parseChord("Ctrl+Unknown")).toThrow(/Unknown key/)
  expect(() => parseChord("Hyper+A")).toThrow(/Unknown modifier/)
  expect(() => parseChord("")).toThrow(/Invalid key/)
})
