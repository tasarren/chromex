export type KeyChord = {
  code: string;
  key: string;
  modifiers: number;
  text?: string;
  windowsVirtualKeyCode: number;
};

/** CDP `Input.dispatchKeyEvent` modifier bitmask. */
const MODIFIERS: Record<string, number> = {
  alt: 1,
  cmd: 4,
  command: 4,
  control: 2,
  ctrl: 2,
  meta: 4,
  option: 1,
  shift: 8,
  super: 4,
};

/**
 * Named keys agents actually use. Letters and digits are derived below. `text` is set only for keys
 * that produce a character: Chromium will not submit a form on Enter without its carriage return.
 */
const NAMED: Record<string, { code: string; key: string; text?: string; vk: number }> = {
  arrowdown: { code: "ArrowDown", key: "ArrowDown", vk: 40 },
  arrowleft: { code: "ArrowLeft", key: "ArrowLeft", vk: 37 },
  arrowright: { code: "ArrowRight", key: "ArrowRight", vk: 39 },
  arrowup: { code: "ArrowUp", key: "ArrowUp", vk: 38 },
  backspace: { code: "Backspace", key: "Backspace", vk: 8 },
  delete: { code: "Delete", key: "Delete", vk: 46 },
  end: { code: "End", key: "End", vk: 35 },
  enter: { code: "Enter", key: "Enter", text: "\r", vk: 13 },
  escape: { code: "Escape", key: "Escape", vk: 27 },
  home: { code: "Home", key: "Home", vk: 36 },
  pagedown: { code: "PageDown", key: "PageDown", vk: 34 },
  pageup: { code: "PageUp", key: "PageUp", vk: 33 },
  space: { code: "Space", key: " ", text: " ", vk: 32 },
  tab: { code: "Tab", key: "Tab", vk: 9 },
};

/**
 * Parse a key or chord such as `Enter`, `Ctrl+A`, or `Shift+Tab` into CDP key-event fields.
 * Chromium ignores `key` alone for most keys, so `code` and `windowsVirtualKeyCode` matter.
 */
export function parseChord(input: string): KeyChord {
  const parts = input.split("+").filter((part) => part.length > 0);
  const raw = parts.pop();
  if (!raw) throw new Error(`Invalid key: ${JSON.stringify(input)}`);

  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIERS[part.toLowerCase()];
    if (bit === undefined) throw new Error(`Unknown modifier ${JSON.stringify(part)} in ${input}`);
    modifiers |= bit;
  }

  const name = raw.toLowerCase();
  const named = NAMED[name];
  if (named) {
    const chord: KeyChord = {
      code: named.code,
      key: named.key,
      modifiers,
      windowsVirtualKeyCode: named.vk,
    };
    // A modifier other than Shift makes it a shortcut, where the character must not be inserted.
    return named.text !== undefined && (modifiers & ~8) === 0
      ? { ...chord, text: named.text }
      : chord;
  }

  if (raw.length !== 1) throw new Error(`Unknown key ${JSON.stringify(raw)} in ${input}`);

  // A bare uppercase letter implies Shift, as if typed. With another modifier it is a shortcut
  // (Ctrl+A), where the browser reports the unshifted key.
  if (modifiers === 0 && raw !== raw.toLowerCase()) modifiers = 8;
  const shifted = (modifiers & 8) !== 0;
  const key = shifted ? raw.toUpperCase() : raw.toLowerCase();
  const chord: KeyChord = {
    code: codeFor(raw),
    key,
    modifiers,
    windowsVirtualKeyCode: raw.toUpperCase().charCodeAt(0),
  };
  // A non-shift modifier means a shortcut, not typed input, so suppress `text`.
  return (modifiers & ~8) === 0 ? { ...chord, text: key } : chord;
}

function codeFor(character: string): string {
  if (/[a-z]/i.test(character)) return `Key${character.toUpperCase()}`;
  if (/[0-9]/.test(character)) return `Digit${character}`;
  return "";
}
