import assert from "node:assert/strict";
import { test } from "node:test";
import { type Broker, BrowserController } from "../src/mcp/browser-controller.js";
import { PROTOCOL_VERSION } from "../src/protocol/schema.js";

type FakeTab = { active: boolean; id: number; title: string; url: string; windowId: number };

/** A broker that records calls and models the extension state the controller relies on. */
class FakeBroker implements Broker {
  readonly calls: { method: string; params: unknown }[] = [];
  url = "http://localhost:3000/";
  navigationError: string | undefined;
  unreachableUrl: string | undefined;
  private attached = new Set<number>();
  private leases = new Set<number>();
  private nextTabId = 100;
  private nextWindowId = 7;
  private notificationHandler: ((method: string, params: unknown) => void) | null = null;
  private tabs = new Map<number, FakeTab>();
  private windowId: number | null = null;

  async close(): Promise<void> {}

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  emit(method: string, params: unknown): void {
    this.notificationHandler?.(method, params);
  }

  dropLease(tabId: number): void {
    this.leases.delete(tabId);
    this.attached.delete(tabId);
  }

  async request<T>(method: string, params: unknown = {}): Promise<T> {
    this.calls.push({ method, params });
    return this.answer(method, params) as T;
  }

  methods(name: string): { method: string; params: unknown }[] {
    return this.calls.filter((call) => call.method === name);
  }

  /** CDP calls the controller makes, recorded under the CDP method name for readability. */
  cdp(name: string): unknown[] {
    return this.calls
      .filter((call) => call.method === "cdp.command")
      .map((call) => call.params as { method: string; params: unknown })
      .filter((params) => params.method === name)
      .map((params) => params.params);
  }

  private answer(method: string, params: unknown): unknown {
    const data = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "window.ensure": {
        const tabId = this.nextTabId++;
        const windowId = this.nextWindowId++;
        this.windowId = windowId;
        const tab = this.tab(tabId, windowId, "about:blank");
        this.tabs.set(tabId, tab);
        this.leases.add(tabId);
        return { tabId, windowId };
      }
      case "tabs.create": {
        const tabId = this.nextTabId++;
        const windowId = Number(data.windowId ?? 1);
        const tab = this.tab(tabId, windowId, "about:blank");
        this.tabs.set(tabId, tab);
        this.leases.add(tabId);
        return tab;
      }
      case "tabs.claim": {
        const tabId = Number(data.tabId);
        const existing = this.tabs.get(tabId) ?? this.tab(tabId, 1, this.url);
        this.tabs.set(tabId, existing);
        this.leases.add(tabId);
        return existing;
      }
      case "tabs.park":
        this.attached.delete(Number(data.tabId));
        return {};
      case "tabs.release": {
        const tabId = Number(data.tabId);
        this.leases.delete(tabId);
        this.attached.delete(tabId);
        return {};
      }
      case "tabs.close": {
        const tabId = Number(data.tabId);
        this.leases.delete(tabId);
        this.attached.delete(tabId);
        this.tabs.delete(tabId);
        return {};
      }
      case "cdp.attach":
        this.attached.add(Number(data.tabId));
        return {};
      case "cdp.detach":
        this.attached.delete(Number(data.tabId));
        return {};
      case "client.status":
        return {
          leases: [...this.leases].map((tabId) => ({
            attached: this.attached.has(tabId),
            tabId,
          })),
          windowId: this.windowId,
        };
      case "broker.status":
        return { extension: { protocolVersion: PROTOCOL_VERSION } };
      case "cdp.command":
        return this.cdpResult(data);
      default:
        return {};
    }
  }

  private cdpResult(data: Record<string, unknown>): unknown {
    const request = data.params as { url?: unknown } | undefined;
    if (data.method === "Page.navigate") {
      this.url = String(request?.url ?? this.url);
      const tabId = Number(data.tabId);
      const tab = this.tabs.get(tabId);
      if (tab) tab.url = this.url;
      if (this.navigationError) {
        this.unreachableUrl = this.url;
        this.url = "chrome-error://chromewebdata/";
        return { errorText: this.navigationError };
      }
      return {};
    }
    if (data.method === "Page.getFrameTree") {
      return { frameTree: { frame: { unreachableUrl: this.unreachableUrl } } };
    }
    if (data.method !== "Runtime.evaluate") return {};
    const expression = String((data.params as { expression?: unknown })?.expression ?? "");
    if (expression.includes("location.href")) return { result: { value: this.url } };
    if (expression.includes("readyState")) return { result: { value: true } };
    return {
      result: {
        value: { scrollHeight: 800, scrollY: 0, title: "", url: this.url, viewportHeight: 800 },
      },
    };
  }

  private tab(id: number, windowId: number, url: string): FakeTab {
    return { active: true, id, title: "", url, windowId };
  }
}

function controller(): { broker: FakeBroker; controller: BrowserController } {
  const broker = new FakeBroker();
  return { broker, controller: new BrowserController(broker) };
}

test("the first open adopts the window's own tab instead of adding one", async () => {
  const { broker, controller: browser } = controller();
  await browser.initialize();
  await browser.open("http://localhost:3000/a");
  assert.ok(broker.methods("window.ensure")[0], "window.ensure was not called");
  assert.equal(broker.methods("tabs.create").length, 0);
  assert.deepEqual(
    broker.cdp("Page.navigate").map((params) => (params as { url: string }).url),
    ["http://localhost:3000/a"],
  );
});

test("failed navigation reports Chromium's error and gates diagnostics by the failed target", async () => {
  const { broker, controller: browser } = controller();
  await browser.initialize();
  broker.navigationError = "net::ERR_CONNECTION_REFUSED";
  await assert.rejects(
    browser.open("http://127.0.0.1:47833/consumer"),
    /net::ERR_CONNECTION_REFUSED/,
  );
  await assert.rejects(
    browser.snapshot(),
    /Navigation failed for http:\/\/127.0.0.1:47833\/consumer/,
  );
  await assert.rejects(browser.text(2000), /Navigation failed/);
  await assert.rejects(browser.wait({ text: "secret", timeoutMs: 100 }), /Navigation failed/);
  assert.deepEqual(await browser.console("all"), []);
  assert.deepEqual(await browser.network("all"), []);
  broker.unreachableUrl = "https://unapproved.example/private";
  await assert.rejects(
    browser.network("all"),
    /Origin https:\/\/unapproved.example is not allowed/,
  );
  await assert.rejects(browser.console("all"), /is not allowed/);
  broker.navigationError = undefined;
  await browser.open("http://localhost:3000/recovered");
  assert.equal(broker.url, "http://localhost:3000/recovered");
});

test("a second open reuses the selected tab", async () => {
  const { broker, controller: browser } = controller();
  await browser.initialize();
  await browser.open("http://localhost:3000/a");
  await browser.open("http://localhost:3000/b");
  assert.equal(broker.methods("tabs.create").length, 0);
  assert.equal(broker.methods("window.ensure").length, 1);
  assert.deepEqual(
    broker.cdp("Page.navigate").map((params) => (params as { url: string }).url),
    ["http://localhost:3000/a", "http://localhost:3000/b"],
  );
});

test("a client drives exactly the tab its window was created with", async () => {
  const { broker, controller: browser } = controller();
  await browser.initialize();
  const tab = await browser.open("http://localhost:3000/a");
  const adopted = broker.methods("tabs.claim").at(0)?.params as { tabId: number };
  assert.equal(broker.methods("window.ensure").length, 1);
  assert.equal(tab.id, adopted.tabId);
  assert.equal(broker.methods("tabs.create").length, 0);
});

test("releasing an owned tab relinquishes its lease without closing it", async () => {
  const { broker, controller: browser } = controller();
  await browser.initialize();
  const tab = await browser.open("http://localhost:3000/a");
  await browser.release();
  assert.equal(broker.methods("tabs.close").length, 0);
  assert.deepEqual(broker.methods("tabs.release").at(-1)?.params, { tabId: tab.id });
  assert.equal(((await browser.status()) as { parkedTabId: number | null }).parkedTabId, null);
});

test("opening after a release leaves the released tab available for handoff", async () => {
  const { broker, controller: browser } = controller();
  await browser.initialize();
  const first = await browser.open("http://localhost:3000/a");
  await browser.release();
  const second = await browser.open("http://localhost:3000/b");
  assert.notEqual(second.id, first.id);
  assert.equal(broker.methods("window.ensure").length, 2);
});

test("releasing a claimed tab leaves the user's tab open", async () => {
  const { broker, controller: browser } = controller();
  await browser.initialize();
  await browser.useTab(42);
  await browser.release();
  assert.equal(broker.methods("tabs.close").length, 0);
  assert.deepEqual(broker.methods("tabs.release").at(-1)?.params, { tabId: 42 });
});

test("open recovers a lost parked lease without requiring a status call first", async () => {
  const { broker, controller: browser } = controller();
  await browser.initialize();
  const first = await browser.open("http://localhost:3000/a");
  broker.emit("cdp.detached", { tabId: first.id });
  broker.dropLease(first.id);
  const second = await browser.open("http://localhost:3000/b");
  assert.notEqual(second.id, first.id);
  assert.equal(broker.methods("window.ensure").length, 2);
});

test("opening the same URL does not wait for a URL change", { timeout: 1_000 }, async () => {
  const { controller: browser } = controller();
  await browser.initialize();
  await browser.open("http://localhost:3000/a");
  await browser.release();
  await browser.open("http://localhost:3000/a");
});

test("controller close disconnects even when releasing a tab fails", async () => {
  const { broker, controller: browser } = controller();
  await browser.initialize();
  await browser.open("http://localhost:3000/a");
  let disconnected = false;
  broker.request = async () => {
    throw new Error("bridge unavailable");
  };
  broker.close = async () => {
    disconnected = true;
  };
  await assert.rejects(browser.close(), /bridge unavailable/);
  assert.equal(disconnected, true);
});

test("a claimed tab is not adopted as an owned parked tab", async () => {
  const { controller: browser } = controller();
  await browser.initialize();
  await browser.useTab(42);
  await browser.release();
  const status = (await browser.status()) as { parkedTabId: number | null };
  assert.equal(status.parkedTabId, null);
});

test("status reports authoritative selected and parked state", async () => {
  const { broker, controller: browser } = controller();
  await browser.initialize();
  assert.equal(((await browser.status()) as { windowId: number | null }).windowId, null);
  const tab = await browser.open("http://localhost:3000/a");
  assert.equal(((await browser.status()) as { selectedTabId: number }).selectedTabId, tab.id);
  broker.dropLease(tab.id);
  assert.equal(((await browser.status()) as { selectedTabId: number | null }).selectedTabId, null);
});

test("tab.closed clears the selected tab", async () => {
  const { broker, controller: browser } = controller();
  await browser.initialize();
  const tab = await browser.open("http://localhost:3000/a");
  broker.emit("tab.closed", { tabId: tab.id });
  const status = (await browser.status()) as {
    parkedTabId: number | null;
    selectedTabId: number | null;
  };
  assert.equal(status.selectedTabId, null);
  assert.equal(status.parkedTabId, null);
});

test("cdp.detached parks an owned tab for later recovery", async () => {
  const { broker, controller: browser } = controller();
  await browser.initialize();
  const tab = await browser.open("http://localhost:3000/a");
  broker.emit("cdp.detached", { reason: "replaced_with_devtools", tabId: tab.id });
  const status = (await browser.status()) as {
    parkedTabId: number | null;
    selectedTabId: number | null;
  };
  assert.equal(status.selectedTabId, null);
  assert.equal(status.parkedTabId, tab.id);
});

test("a stale notification for another tab does not clear the selection", async () => {
  const { broker, controller: browser } = controller();
  await browser.initialize();
  const tab = await browser.open("http://localhost:3000/a");
  broker.emit("tab.closed", { tabId: tab.id + 1 });
  assert.equal(((await browser.status()) as { selectedTabId: number }).selectedTabId, tab.id);
});

test("two clients get separate windows", async () => {
  const shared = new FakeBroker();
  const first = new BrowserController(shared);
  const second = new BrowserController(shared);
  await first.initialize();
  await second.initialize();
  const firstTab = await first.open("http://localhost:3000/a");
  const secondTab = await second.open("http://localhost:3000/b");
  assert.notEqual(firstTab.windowId, secondTab.windowId, "clients shared a window");
});
