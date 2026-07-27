import assert from "node:assert/strict";
import { test } from "node:test";
import {
  beginSessionGeneration,
  emptySessionState,
  findBootstrapTab,
  parseSessionState,
  reconcileSessionState,
} from "../../extension/src/session-state.js";

test("invalid stored state falls back to an empty versioned state", () => {
  assert.deepEqual(parseSessionState({ version: 99, clients: "bad" }), emptySessionState());
});

test("stored state validates rows and deduplicates browser IDs", () => {
  assert.deepEqual(
    parseSessionState({
      version: 1,
      generation: 4,
      clients: [
        { clientId: "agent", label: "first", windowId: 7 },
        { clientId: "agent", label: "latest", mode: "managed", windowId: 8 },
        { clientId: "" },
      ],
      leases: [
        { clientId: "agent", desiredAttached: true, tabId: 10 },
        { clientId: "agent", desiredAttached: false, tabId: 10 },
        { clientId: "agent", desiredAttached: "yes", tabId: 11 },
      ],
    }),
    {
      version: 1,
      generation: 4,
      clients: [{ clientId: "agent", label: "latest", mode: "managed", windowId: 8 }],
      leases: [{ clientId: "agent", desiredAttached: false, tabId: 10 }],
    },
  );
});

test("reconciliation prunes missing tabs and stale window IDs", () => {
  const reconciled = reconcileSessionState(
    {
      version: 1,
      generation: 2,
      clients: [
        { clientId: "agent", label: "Agent", windowId: 7 },
        { clientId: "idle", label: "Idle" },
      ],
      leases: [
        { clientId: "agent", desiredAttached: true, tabId: 10 },
        { clientId: "agent", desiredAttached: false, tabId: 11 },
      ],
    },
    { tabIds: [11], windowIds: [] },
  );
  assert.deepEqual(reconciled, {
    version: 1,
    generation: 2,
    clients: [
      { clientId: "agent", label: "Agent" },
      { clientId: "idle", label: "Idle" },
    ],
    leases: [{ clientId: "agent", desiredAttached: false, tabId: 11 }],
  });
});

test("a worker start advances the reconciliation generation", () => {
  assert.equal(beginSessionGeneration({ ...emptySessionState(), generation: 8 }).generation, 9);
});

test("managed bootstrap adoption selects only an unleased blank tab", () => {
  assert.deepEqual(
    findBootstrapTab(
      [
        { id: 1, tabs: [{ id: 10, url: "chrome://newtab/" }] },
        { id: 2, tabs: [{ id: 20, url: "about:blank" }] },
        { id: 3, tabs: [{ id: 30, url: "about:blank" }] },
      ],
      [20],
    ),
    { tabId: 30, windowId: 3 },
  );
  assert.equal(
    findBootstrapTab([{ id: 1, tabs: [{ id: 10, url: "chrome://newtab/" }] }], []),
    null,
  );
});
