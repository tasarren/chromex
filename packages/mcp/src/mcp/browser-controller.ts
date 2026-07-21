import { z } from "zod";
import { type TabInfo, TabInfoSchema } from "../protocol/schema.js";
import { BrokerClient } from "./broker-client.js";
import { OriginPolicy } from "./origin-policy.js";

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
  readonly broker = new BrokerClient();
  readonly policy = new OriginPolicy();
  private refs = new Map<string, number>();
  private selectedTabId: number | null = null;

  async initialize(): Promise<void> {
    await this.policy.load();
  }

  async status(): Promise<unknown> {
    return {
      ...(await this.broker.request<Record<string, unknown>>("broker.status")),
      allowedOrigins: this.policy.list(),
      selectedTabId: this.selectedTabId,
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
    await this.broker.request("cdp.attach", { tabId });
    this.selectedTabId = tabId;
    return tab;
  }

  async open(url: string): Promise<TabInfo> {
    this.policy.assertAllowed(url);
    await this.release();
    const tab = TabInfoSchema.parse(await this.broker.request("tabs.create"));
    this.selectedTabId = tab.id;
    await this.broker.request("cdp.attach", { tabId: tab.id });
    await this.navigate(url);
    return tab;
  }

  async navigate(url: string): Promise<{ url: string }> {
    this.requireTab();
    this.policy.assertAllowed(url);
    await this.cdp("Page.enable");
    await this.cdp("Page.navigate", { url });
    await this.wait({ state: "load", timeoutMs: 30_000 });
    const current = await this.currentUrl();
    this.policy.assertAllowed(current);
    this.refs.clear();
    return { url: current };
  }

  async snapshot(): Promise<{ text: string; url: string }> {
    this.policy.assertAllowed(await this.currentUrl());
    const tree = AxTreeSchema.parse(await this.cdp("Accessibility.getFullAXTree"));
    this.refs.clear();
    const lines: string[] = [];
    let index = 1;
    for (const node of tree.nodes) {
      if (node.ignored || !node.backendDOMNodeId) continue;
      const role = String(node.role?.value ?? "").trim();
      const name = String(node.name?.value ?? "").trim();
      const value = String(node.value?.value ?? "").trim();
      if (!role && !name && !value) continue;
      const ref = `e${index++}`;
      this.refs.set(ref, node.backendDOMNodeId);
      lines.push(
        `[${ref}] ${role || "node"}${name ? ` ${JSON.stringify(name)}` : ""}${value ? ` value=${JSON.stringify(value)}` : ""}`,
      );
    }
    return { text: lines.join("\n") || "(no accessible nodes)", url: await this.currentUrl() };
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
    const backendNodeId = this.requireRef(ref);
    const model = z
      .object({ model: z.object({ content: z.array(z.number()) }) })
      .parse(await this.cdp("DOM.getBoxModel", { backendNodeId }));
    const xs = model.model.content.filter((_, i) => i % 2 === 0);
    const ys = model.model.content.filter((_, i) => i % 2 === 1);
    const x = xs.reduce((a, b) => a + b, 0) / xs.length;
    const y = ys.reduce((a, b) => a + b, 0) / ys.length;
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
    const backendNodeId = this.requireRef(ref);
    const resolved = z
      .object({ object: z.object({ objectId: z.string() }) })
      .parse(await this.cdp("DOM.resolveNode", { backendNodeId }));
    await this.cdp("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration: clear
        ? "function(){this.focus(); if ('value' in this) this.value='';}"
        : "function(){this.focus();}",
    });
    await this.cdp("Input.insertText", { text });
  }

  async press(key: string): Promise<void> {
    this.policy.assertAllowed(await this.currentUrl());
    await this.cdp("Input.dispatchKeyEvent", { type: "keyDown", key });
    await this.cdp("Input.dispatchKeyEvent", { type: "keyUp", key });
  }

  async wait(options: { state?: "load"; text?: string; timeoutMs: number }): Promise<void> {
    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() < deadline) {
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

  async release(): Promise<void> {
    if (this.selectedTabId === null) return;
    const tabId = this.selectedTabId;
    this.selectedTabId = null;
    this.refs.clear();
    await this.broker.request("tabs.release", { tabId });
  }

  async close(): Promise<void> {
    await this.release();
    await this.broker.close();
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
  private async cdp(method: string, params: unknown = {}): Promise<unknown> {
    return await this.broker.request("cdp.command", { tabId: this.requireTab(), method, params });
  }
  private async currentUrl(): Promise<string> {
    const result = z
      .object({ result: z.object({ value: z.string() }) })
      .parse(
        await this.cdp("Runtime.evaluate", { expression: "location.href", returnByValue: true }),
      );
    return result.result.value;
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
