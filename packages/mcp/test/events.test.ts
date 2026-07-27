import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendEvent,
  type BridgeEvent,
  formatEvent,
  formatTime,
  shortUrl,
} from "../../extension/src/events.js";

function event(kind: BridgeEvent["kind"], extra: Partial<BridgeEvent> = {}): BridgeEvent {
  return { kind, ts: 0, ...extra };
}

test("events are newest first", () => {
  const first = event("client.connected", { ts: 1 });
  const second = event("window.created", { ts: 2 });
  const list = appendEvent(appendEvent([], first), second);
  assert.deepEqual(
    list.map((entry) => entry.ts),
    [2, 1],
  );
});

test("the ring evicts the oldest past capacity", () => {
  let list: BridgeEvent[] = [];
  for (let index = 0; index < 10; index++)
    list = appendEvent(list, event("navigated", { ts: index }), 4);
  assert.equal(list.length, 4);
  assert.deepEqual(
    list.map((entry) => entry.ts),
    [9, 8, 7, 6],
  );
});

test("a navigation line carries its URL", () => {
  assert.equal(
    formatEvent(event("navigated", { detail: "example.com/docs", tabId: 5 })),
    "navigated example.com/docs",
  );
});

test("tab and window events name what they touched", () => {
  assert.equal(
    formatEvent(event("tab.opened", { tabId: 7, windowId: 2 })),
    "opened tab #7 in window 2",
  );
  assert.equal(formatEvent(event("window.closed", { windowId: 3 })), "closed window 3");
  assert.equal(formatEvent(event("window.created", { windowId: 4 })), "created window 4");
  assert.equal(formatEvent(event("debugger.attached", { tabId: 9 })), "attached debugger #9");
  assert.equal(formatEvent(event("client.disconnected")), "disconnected");
});

test("urls shorten to host and path", () => {
  assert.equal(shortUrl("https://example.com/a/b?c=1#d"), "example.com/a/b");
  assert.equal(shortUrl("https://example.com/"), "example.com");
  assert.equal(shortUrl("http://127.0.0.1:8899/page.html"), "127.0.0.1:8899/page.html");
  assert.equal(shortUrl("about:blank"), "about:blank");
});

test("timestamps render as zero-padded local time", () => {
  const at = new Date(2026, 0, 2, 9, 5, 3).getTime();
  assert.equal(formatTime(at), "09:05:03");
});
