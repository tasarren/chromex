import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChord } from "../src/mcp/keys.js";

test("named keys carry a code and virtual key code", () => {
  assert.deepEqual(parseChord("Enter"), {
    code: "Enter",
    key: "Enter",
    modifiers: 0,
    text: "\r",
    windowsVirtualKeyCode: 13,
  });
  assert.equal(parseChord("escape").code, "Escape");
  assert.equal(parseChord("ArrowDown").windowsVirtualKeyCode, 40);
});

test("only character-producing named keys send text", () => {
  assert.equal(parseChord("Tab").text, undefined);
  assert.equal(parseChord("Backspace").text, undefined);
  assert.equal(parseChord("Escape").text, undefined);
  assert.equal(parseChord("Space").text, " ");
  // Chromium will not submit a form on Enter without the carriage return.
  assert.equal(parseChord("Enter").text, "\r");
  assert.equal(parseChord("Ctrl+Enter").text, undefined);
});

test("modifiers combine into the CDP bitmask", () => {
  assert.deepEqual(parseChord("Ctrl+A"), {
    code: "KeyA",
    key: "a",
    modifiers: 2,
    windowsVirtualKeyCode: 65,
  });
  assert.deepEqual(parseChord("Shift+Tab"), {
    code: "Tab",
    key: "Tab",
    modifiers: 8,
    windowsVirtualKeyCode: 9,
  });
  assert.equal(parseChord("Ctrl+Shift+P").modifiers, 10);
  assert.equal(parseChord("Meta+A").modifiers, 4);
});

test("shortcuts suppress text but plain and shifted characters keep it", () => {
  assert.equal(parseChord("Ctrl+A").text, undefined);
  assert.equal(parseChord("a").text, "a");
  assert.equal(parseChord("Shift+a").key, "A");
  assert.equal(parseChord("Shift+a").text, "A");
  // A bare capital implies Shift, as if typed.
  assert.equal(parseChord("A").key, "A");
  assert.equal(parseChord("A").modifiers, 8);
  assert.equal(parseChord("?").text, "?");
  assert.equal(parseChord("?").code, "");
});

test("unknown keys and modifiers are rejected", () => {
  assert.throws(() => parseChord("Ctrl+Unknown"), /Unknown key/);
  assert.throws(() => parseChord("Hyper+A"), /Unknown modifier/);
  assert.throws(() => parseChord(""), /Invalid key/);
});
