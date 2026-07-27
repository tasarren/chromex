import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

// biome-ignore lint/suspicious/noExplicitAny: VM fixture models Chromium's untyped callback API.
type ChromeValue = any;

test("Observe grants require popup; revoke detaches; concurrent claims stay exclusive", async () => {
  const listeners = new Map<string, (...args: ChromeValue[]) => ChromeValue>();
  const event = (name: string) => ({
    addListener: (fn: (...args: ChromeValue[]) => ChromeValue) => listeners.set(name, fn),
  });
  const stored: Record<string, unknown> = {};
  const attached = new Set<number>();
  const replies = new Map<number, (value: ChromeValue) => void>();
  const tab = { id: 1, windowId: 1, active: true, url: "http://localhost/", title: "Local" };
  const popupUrl = "chrome-extension://test/popup.html";
  let connected!: () => void;
  const ready = new Promise<void>((resolve) => {
    connected = resolve;
  });
  let commands = 0;
  let closedWindows = 0;
  const chrome = {
    storage: {
      session: {
        get: async () => stored,
        set: async (value: Record<string, unknown>) => Object.assign(stored, value),
      },
    },
    tabs: { query: async () => [tab], get: async () => tab, onRemoved: event("tab.removed") },
    windows: {
      getAll: async () => [{ id: 1 }],
      remove: async () => {
        closedWindows++;
      },
      onRemoved: event("window.removed"),
    },
    debugger: {
      getTargets: async () => [],
      attach: async ({ tabId }: { tabId: number }) => attached.add(tabId),
      detach: async ({ tabId }: { tabId: number }) => attached.delete(tabId),
      sendCommand: async () => {
        commands++;
        return {};
      },
      onEvent: event("debugger.event"),
      onDetach: event("debugger.detach"),
    },
    alarms: { create: async () => {}, onAlarm: event("alarm") },
    runtime: {
      id: "test",
      getManifest: () => ({ version: "test" }),
      getURL: () => popupUrl,
      onMessage: event("popup"),
      connectNative: () => ({
        onMessage: event("native"),
        onDisconnect: event("disconnect"),
        postMessage: (message: ChromeValue) => {
          if (message.method === "bridge.hello") connected();
          else if (message.id) replies.get(message.id)?.(message);
        },
      }),
    },
  };
  const bundle = await build({
    entryPoints: ["../extension/src/background.ts"],
    bundle: true,
    write: false,
    format: "iife",
  });
  runInNewContext(bundle.outputFiles[0]?.text ?? "", { chrome, setTimeout, clearTimeout });
  await ready;
  let nextId = 0;
  const rpc = (method: string, params: unknown = {}) =>
    new Promise<ChromeValue>((resolve) => {
      const id = ++nextId;
      replies.set(id, resolve);
      listeners.get("native")?.({ jsonrpc: "2.0", id, method, params });
    });
  const popup = (enabled: boolean) =>
    new Promise<ChromeValue>((resolve) => {
      listeners.get("popup")?.({ type: "popup.observe", enabled }, { url: popupUrl }, resolve);
    });
  assert.equal(
    listeners.get("popup")?.(
      { type: "popup.observe", enabled: true },
      { url: "http://localhost/" },
      () => assert.fail("untrusted sender"),
    ),
    false,
  );
  assert.equal((await rpc("tabs.list", { clientId: "A" })).result.length, 0);
  assert.match(
    (await rpc("tabs.claim", { clientId: "A", tabId: 1 })).error.message,
    /Observe access disabled/,
  );
  assert.match(
    (await rpc("window.ensure", { clientId: "A" })).error.message,
    /cannot create windows/,
  );
  assert.equal((await popup(true)).ok, true);
  const claims = await Promise.all([
    rpc("tabs.claim", { clientId: "A", tabId: 1 }),
    rpc("tabs.claim", { clientId: "B", tabId: 1 }),
  ]);
  assert.equal(claims[0].result.id, 1);
  assert.match(claims[1].error.message, /another client/);
  await rpc("cdp.attach", { clientId: "A", tabId: 1 });
  assert.ok(attached.has(1));
  await popup(false);
  assert.equal(attached.size, 0);
  const denied = await rpc("cdp.command", { clientId: "A", tabId: 1, method: "Runtime.evaluate" });
  assert.match(denied.error.message, /Observe access disabled/);
  assert.equal(commands, 0);
  await rpc("bridge.configure", { managed: true });
  assert.equal((await rpc("tabs.claim", { clientId: "A", tabId: 1 })).result.id, 1);
  await rpc("client.release", { clientId: "A" });
  assert.equal((await rpc("tabs.claim", { clientId: "B", tabId: 1 })).result.id, 1);
  assert.equal(closedWindows, 0);
});
