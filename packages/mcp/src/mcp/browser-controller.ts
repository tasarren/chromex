import { z } from "zod";
import { type TabInfo, TabInfoSchema } from "../protocol/schema.js";
import { BrokerClient } from "./broker-client.js";
import { type ConsoleEntry, type NetworkEntry, PageActivity } from "./buffers.js";
import { parseChord } from "./keys.js";
import { OriginPolicy } from "./origin-policy.js";
import { type PageContext, renderSnapshot } from "./snapshot.js";

/** The part of BrokerClient the controller needs, so tests can supply a fake. */
export type Broker = {
  close(): Promise<void>;
  onNotification(handler: (method: string, params: unknown) => void): void;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
};

const WindowSchema = z.object({
  tabId: z.number().int().optional(),
  windowId: z.number().int(),
});

const ClientStatusSchema = z.object({
  leases: z.array(z.object({ attached: z.boolean(), tabId: z.number().int() })),
  windowId: z.number().int().nullable(),
});

const HistorySchema = z.object({
  currentIndex: z.number().int(),
  entries: z.array(z.object({ id: z.number().int(), url: z.string() })),
});

const PageContextSchema = z.object({
  scrollHeight: z.number(),
  scrollY: z.number(),
  title: z.string(),
  url: z.string(),
  viewportHeight: z.number(),
});

const AxTreeSchema = z.object({
  nodes: z.array(
    z.object({
      backendDOMNodeId: z.number().optional(),
      childIds: z.array(z.string()).optional(),
      ignored: z.boolean().optional(),
      name: z.object({ value: z.unknown() }).optional(),
      nodeId: z.string(),
      role: z.object({ value: z.unknown() }).optional(),
      value: z.object({ value: z.unknown() }).optional(),
    }),
  ),
});

export class BrowserController {
  readonly activity = new PageActivity();
  readonly broker: Broker;
  readonly policy: OriginPolicy;
  /** Retain detached owned tabs for debugger recovery until explicitly released. */
  private ownsTab = false;
  private parkedTabId: number | null = null;
  private refs = new Map<string, number>();
  private selectedTabId: number | null = null;
  private windowId: number | null = null;

  constructor(
    broker: Broker = new BrokerClient(),
    policy: OriginPolicy = new OriginPolicy(),
    private readonly adoptExistingWindow = false,
  ) {
    this.broker = broker;
    this.policy = policy;
  }

  async initialize(): Promise<void> {
    this.broker.onNotification((method, params) => this.onNotification(method, params));
    await this.policy.load();
  }

  async status(): Promise<unknown> {
    const [broker, client] = await Promise.all([
      this.broker.request<Record<string, unknown>>("broker.status"),
      this.broker.request("client.status").then((value) => ClientStatusSchema.parse(value)),
    ]);
    this.reconcileStatus(client);
    return {
      ...broker,
      allowedOrigins: this.policy.list(),
      parkedTabId: this.parkedTabId,
      selectedTabId: this.selectedTabId,
      windowId: client.windowId,
    };
  }

  async tabs(): Promise<TabInfo[]> {
    const tabs = z.array(TabInfoSchema).parse(await this.broker.request("tabs.list"));
    return tabs.map((tab) =>
      this.policy.isAllowed(tab.url)
        ? tab
        : { ...tab, title: "[redacted]", url: safeOrigin(tab.url) },
    );
  }

  async useTab(tabId: number): Promise<TabInfo> {
    await this.release();
    const tab = TabInfoSchema.parse(await this.broker.request("tabs.claim", { tabId }));
    try {
      this.policy.assertAllowed(tab.url);
    } catch (cause) {
      await this.broker.request("tabs.release", { tabId });
      throw cause;
    }
    try {
      await this.attach(tabId);
    } catch (cause) {
      await this.broker.request("tabs.release", { tabId });
      throw cause;
    }
    // The user owned this tab first, so releasing it must leave it open.
    this.ownsTab = false;
    return tab;
  }

  /** Open a URL, reusing this client's tab when it already has one. */
  async open(url: string): Promise<TabInfo> {
    this.policy.assertAllowed(url);
    if (this.selectedTabId !== null || this.parkedTabId !== null) {
      this.reconcileStatus(ClientStatusSchema.parse(await this.broker.request("client.status")));
    }
    if (this.selectedTabId !== null) {
      await this.navigate(url);
      // Claiming a tab this client already leases is idempotent and returns its current info.
      return TabInfoSchema.parse(
        await this.broker.request("tabs.claim", { tabId: this.selectedTabId }),
      );
    }
    if (this.parkedTabId !== null) {
      const tabId = this.parkedTabId;
      await this.broker.request("tabs.claim", { tabId });
      await this.attach(tabId);
      this.parkedTabId = null;
      this.ownsTab = true;
      await this.navigate(url);
      return TabInfoSchema.parse(await this.broker.request("tabs.claim", { tabId }));
    }
    const { tabId, windowId } = WindowSchema.parse(
      await this.broker.request("window.ensure", { adoptExisting: this.adoptExistingWindow }),
    );
    this.windowId = windowId;
    // A new window already contains a blank tab; adopt it rather than stranding it.
    const tab =
      tabId === undefined
        ? TabInfoSchema.parse(await this.broker.request("tabs.create", { windowId }))
        : TabInfoSchema.parse(await this.broker.request("tabs.claim", { tabId }));
    await this.attach(tab.id);
    this.ownsTab = true;
    await this.navigate(url);
    return TabInfoSchema.parse(await this.broker.request("tabs.claim", { tabId: tab.id }));
  }

  async navigate(url: string): Promise<{ url: string }> {
    this.requireTab();
    this.policy.assertAllowed(url);
    const previous = await this.currentUrl().catch(() => "");
    this.activity.clear();
    this.refs.clear();
    const result = z
      .object({ errorText: z.string().optional() })
      .parse(await this.cdp("Page.navigate", { url }));
    if (result.errorText) throw new Error(`Navigation failed for ${url}: ${result.errorText}`);
    // The old document can still report readyState 'complete', so wait for the URL to turn over
    // before trusting the load state.
    if (url !== previous) await this.waitForUrlChange(previous, 30_000);
    await this.wait({ state: "load", timeoutMs: 30_000 });
    const current = await this.currentUrl();
    this.policy.assertAllowed(current);
    this.refs.clear();
    return { url: current };
  }

  /** Move through session history or reload, then re-check the resulting origin. */
  async history(action: "back" | "forward" | "reload"): Promise<{ url: string }> {
    this.requireTab();
    this.policy.assertAllowed(await this.currentUrl());
    const previous = await this.currentUrl();
    this.activity.clear();
    this.refs.clear();
    if (action === "reload") await this.cdp("Page.reload");
    else {
      const history = HistorySchema.parse(await this.cdp("Page.getNavigationHistory"));
      const target = history.entries[history.currentIndex + (action === "back" ? -1 : 1)];
      if (!target) throw new Error(`No ${action} entry in this tab's history`);
      await this.cdp("Page.navigateToHistoryEntry", { entryId: target.id });
      await this.waitForUrlChange(previous, 30_000);
    }
    await this.wait({ state: "load", timeoutMs: 30_000 });
    const current = await this.currentUrl();
    this.policy.assertAllowed(current);
    return { url: current };
  }

  async scroll(options: {
    amount: number;
    direction: "up" | "down";
    ref?: string | undefined;
  }): Promise<void> {
    this.policy.assertAllowed(await this.currentUrl());
    if (options.ref !== undefined) {
      await this.centerOf(this.requireRef(options.ref), options.ref);
      return;
    }
    await this.cdp("Input.dispatchMouseEvent", {
      deltaX: 0,
      deltaY: options.direction === "down" ? options.amount : -options.amount,
      type: "mouseWheel",
      x: 10,
      y: 10,
    });
  }

  /** Set a `<select>` value. Native dropdowns cannot be driven by synthetic input events. */
  async select(ref: string, value: string): Promise<void> {
    this.policy.assertAllowed(await this.currentUrl());
    const result = await this.callOn(
      this.requireRef(ref),
      `function(value){
        if (this.tagName !== 'SELECT') return 'Element ' + this.tagName + ' is not a <select>';
        const option = [...this.options].find((o) => o.value === value || o.label === value || o.text.trim() === value);
        if (!option) return 'No option matching ' + JSON.stringify(value);
        this.value = option.value;
        this.dispatchEvent(new Event('input', {bubbles: true}));
        this.dispatchEvent(new Event('change', {bubbles: true}));
        return null;
      }`,
      [{ value }],
    );
    if (typeof result === "string") throw new Error(result);
  }

  async hover(ref: string): Promise<void> {
    this.policy.assertAllowed(await this.currentUrl());
    const { x, y } = await this.centerOf(this.requireRef(ref), ref);
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  async snapshot(filter: "interactive" | "all" = "interactive"): Promise<{
    text: string;
    url: string;
  }> {
    const url = await this.currentUrl();
    this.policy.assertAllowed(url);
    const tree = AxTreeSchema.parse(await this.cdp("Accessibility.getFullAXTree"));
    const rendered = renderSnapshot(tree.nodes, { context: await this.pageContext(), filter });
    this.refs = rendered.refs;
    return { text: rendered.text, url };
  }

  async text(maxChars: number): Promise<string> {
    this.policy.assertAllowed(await this.currentUrl());
    const result = z.object({ result: z.object({ value: z.string().optional() }) }).parse(
      await this.cdp("Runtime.evaluate", {
        expression: "document.body?.innerText ?? ''",
        returnByValue: true,
      }),
    );
    const value = result.result.value ?? "";
    return value.length > maxChars
      ? `${value.slice(0, maxChars)}\n\n[truncated at ${maxChars} characters of ${value.length}]`
      : value;
  }

  async screenshot(): Promise<{ data: string; mimeType: string }> {
    this.policy.assertAllowed(await this.currentUrl());
    const result = z
      .object({ data: z.string() })
      .parse(await this.cdp("Page.captureScreenshot", { format: "png" }));
    return { data: result.data, mimeType: "image/png" };
  }

  async click(ref: string): Promise<void> {
    this.policy.assertAllowed(await this.currentUrl());
    const { x, y } = await this.centerOf(this.requireRef(ref), ref);
    await this.cdp("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await this.cdp("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  async type(ref: string, text: string, clear: boolean): Promise<void> {
    this.policy.assertAllowed(await this.currentUrl());
    await this.callOn(
      this.requireRef(ref),
      clear
        ? "function(){this.focus(); if ('value' in this) this.value='';}"
        : "function(){this.focus();}",
    );
    await this.cdp("Input.insertText", { text });
  }

  async press(key: string): Promise<void> {
    this.policy.assertAllowed(await this.currentUrl());
    const chord = parseChord(key);
    await this.cdp("Input.dispatchKeyEvent", {
      ...chord,
      type: chord.text === undefined ? "rawKeyDown" : "keyDown",
    });
    await this.cdp("Input.dispatchKeyEvent", { ...chord, text: undefined, type: "keyUp" });
  }

  async wait(options: { state?: "load"; text?: string; timeoutMs: number }): Promise<void> {
    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() < deadline) {
      this.policy.assertAllowed(await this.currentUrl());
      const expression = options.text
        ? `document.body?.innerText.includes(${JSON.stringify(options.text)}) === true`
        : "document.readyState === 'complete'";
      const result = z
        .object({ result: z.object({ value: z.unknown().optional() }) })
        .parse(await this.cdp("Runtime.evaluate", { expression, returnByValue: true }));
      if (result.result.value === true) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out after ${options.timeoutMs} ms`);
  }

  async console(level: "error" | "warn" | "all"): Promise<ConsoleEntry[]> {
    this.policy.assertAllowed(await this.currentUrl(true));
    return this.activity.console(level);
  }

  async network(status: "failed" | "all"): Promise<NetworkEntry[]> {
    this.policy.assertAllowed(await this.currentUrl(true));
    return this.activity.network(status);
  }

  async release(): Promise<void> {
    const tabId = this.selectedTabId ?? this.parkedTabId;
    if (tabId === null) return;
    this.clearSelected(false);
    this.parkedTabId = null;
    await this.broker.request("tabs.release", { tabId });
  }

  async close(): Promise<void> {
    try {
      await this.release();
    } finally {
      await this.broker.close();
    }
  }

  /** Attach the debugger and enable the domains that feed the activity buffers. */
  private async attach(tabId: number): Promise<void> {
    await this.broker.request("cdp.attach", { tabId });
    this.selectedTabId = tabId;
    this.activity.clear();
    for (const domain of ["Runtime", "Log", "Network", "Page"]) {
      // A page that refuses one domain should not block control of the tab.
      await this.cdp(`${domain}.enable`).catch(() => undefined);
    }
  }
  private onNotification(method: string, params: unknown): void {
    const event = (params ?? {}) as { method?: unknown; params?: unknown; tabId?: unknown };
    if (method === "cdp.event") {
      if (event.tabId !== this.selectedTabId || typeof event.method !== "string") return;
      this.activity.record(event.method, event.params, Date.now());
      return;
    }
    if (typeof event.tabId !== "number") return;
    if (method === "tab.closed") {
      if (event.tabId === this.selectedTabId) this.clearSelected(false);
      if (event.tabId === this.parkedTabId) this.parkedTabId = null;
      return;
    }
    if (method !== "cdp.detached" || event.tabId !== this.selectedTabId) return;
    const owned = this.ownsTab;
    this.clearSelected(owned);
    // The browser already detached the debugger; only relinquish a user-owned tab's lease.
    if (!owned)
      void this.broker.request("tabs.release", { tabId: event.tabId }).catch(() => undefined);
  }
  private clearSelected(parkOwned: boolean): void {
    if (parkOwned && this.ownsTab && this.selectedTabId !== null) {
      this.parkedTabId = this.selectedTabId;
    }
    this.selectedTabId = null;
    this.ownsTab = false;
    this.refs.clear();
    this.activity.clear();
  }
  private reconcileStatus(status: z.infer<typeof ClientStatusSchema>): void {
    const leases = new Map(status.leases.map((lease) => [lease.tabId, lease.attached]));
    if (this.selectedTabId !== null && leases.get(this.selectedTabId) !== true) {
      this.clearSelected(this.ownsTab);
    }
    if (this.parkedTabId !== null && !leases.has(this.parkedTabId)) this.parkedTabId = null;
    this.windowId = status.windowId;
  }
  private requireTab(): number {
    if (this.selectedTabId === null)
      throw new Error("No tab selected. Use chrome_use_tab or chrome_open first.");
    return this.selectedTabId;
  }
  private requireRef(ref: string): number {
    const id = this.refs.get(ref);
    if (!id) throw new Error(`Unknown element ref ${ref}; take a new snapshot.`);
    return id;
  }
  /** Run a function with `this` bound to the element, returning its value. */
  private async callOn(
    backendNodeId: number,
    functionDeclaration: string,
    args: { value: unknown }[] = [],
  ): Promise<unknown> {
    const resolved = z
      .object({ object: z.object({ objectId: z.string() }) })
      .parse(await this.cdp("DOM.resolveNode", { backendNodeId }));
    const result = z.object({ result: z.object({ value: z.unknown().optional() }) }).parse(
      await this.cdp("Runtime.callFunctionOn", {
        arguments: args,
        functionDeclaration,
        objectId: resolved.object.objectId,
        returnByValue: true,
      }),
    );
    return result.result.value;
  }
  /** Scroll the node into view, then return its viewport center. */
  private async centerOf(backendNodeId: number, ref: string): Promise<{ x: number; y: number }> {
    try {
      await this.cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId });
      const model = z
        .object({ model: z.object({ content: z.array(z.number()) }) })
        .parse(await this.cdp("DOM.getBoxModel", { backendNodeId }));
      const xs = model.model.content.filter((_, i) => i % 2 === 0);
      const ys = model.model.content.filter((_, i) => i % 2 === 1);
      return {
        x: xs.reduce((a, b) => a + b, 0) / xs.length,
        y: ys.reduce((a, b) => a + b, 0) / ys.length,
      };
    } catch {
      throw new Error(`Element ${ref} is no longer on the page; take a new snapshot.`);
    }
  }
  private async waitForUrlChange(previous: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.currentUrl().catch(() => previous)) !== previous) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  private async cdp(method: string, params: unknown = {}): Promise<unknown> {
    return await this.broker.request("cdp.command", { tabId: this.requireTab(), method, params });
  }
  private async pageContext(): Promise<PageContext> {
    const result = z.object({ result: z.object({ value: z.unknown() }) }).parse(
      await this.cdp("Runtime.evaluate", {
        expression:
          "({scrollHeight: document.documentElement.scrollHeight, scrollY: window.scrollY, title: document.title, url: location.href, viewportHeight: window.innerHeight})",
        returnByValue: true,
      }),
    );
    return PageContextSchema.parse(result.result.value);
  }
  private async currentUrl(diagnostics = false): Promise<string> {
    const result = z
      .object({ result: z.object({ value: z.string() }) })
      .parse(
        await this.cdp("Runtime.evaluate", { expression: "location.href", returnByValue: true }),
      );
    const url = result.result.value;
    if (url !== "chrome-error://chromewebdata/") return url;
    const { frameTree } = z
      .object({
        frameTree: z.object({ frame: z.object({ unreachableUrl: z.string().optional() }) }),
      })
      .parse(await this.cdp("Page.getFrameTree"));
    const target = frameTree.frame.unreachableUrl;
    if (target) {
      this.policy.assertAllowed(target);
      if (diagnostics) return target;
    }
    throw new Error(
      `Navigation failed${target ? ` for ${target}` : ""}: Chromium is showing an error page. Check chrome_network; verify the server is reachable, then call chrome_open again.`,
    );
  }
}

function safeOrigin(value: string): string {
  try {
    if (value === "about:blank") return value;
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "[restricted]";
  } catch {
    return "[restricted]";
  }
}
