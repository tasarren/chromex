import {
  EXTENSION_ID,
  errorMessage,
  NATIVE_HOST_NAME,
  PROTOCOL_VERSION,
  parseRpcRequest,
  type RpcRequest,
  rpcError,
  rpcResult,
  type TabInfo,
} from "./protocol.js";

// biome-ignore lint/suspicious/noExplicitAny: Chromium injects this untyped extension API global.
declare const chrome: any;

type NativePort = {
  disconnect(): void;
  onDisconnect: { addListener(callback: () => void): void };
  onMessage: { addListener(callback: (message: unknown) => void): void };
  postMessage(message: unknown): void;
};

type ChromeTab = {
  active?: boolean;
  id?: number;
  title?: string;
  url?: string;
  windowId: number;
};

type Debuggee = { tabId?: number };

const leases = new Map<number, string>();
const attachedTabs = new Set<number>();
let nativePort: NativePort | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let lastError: string | null = null;

function tabInfo(tab: ChromeTab): TabInfo {
  if (typeof tab.id !== "number") throw new Error("Chromium returned a tab without an ID");
  return {
    active: tab.active === true,
    id: tab.id,
    title: tab.title ?? "",
    url: tab.url ?? "",
    windowId: tab.windowId,
  };
}

function clientId(params: unknown): string {
  if (!params || typeof params !== "object" || !("clientId" in params)) {
    throw new Error("Missing broker client ID");
  }
  const value = (params as { clientId?: unknown }).clientId;
  if (typeof value !== "string" || value.length === 0) throw new Error("Invalid broker client ID");
  return value;
}

function numberParam(params: unknown, key: string): number {
  if (!params || typeof params !== "object") throw new Error(`Missing ${key}`);
  const value = (params as Record<string, unknown>)[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${key}`);
  }
  return value;
}

function requireLease(params: unknown): { client: string; tabId: number } {
  const client = clientId(params);
  const tabId = numberParam(params, "tabId");
  const owner = leases.get(tabId);
  if (owner !== client) throw new Error(`Tab ${tabId} is not leased by this Codex client`);
  return { client, tabId };
}

async function attach(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabs.add(tabId);
}

async function detach(tabId: number): Promise<void> {
  if (!attachedTabs.delete(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // The browser may already have detached because the tab closed or DevTools took over.
  }
}

async function releaseTab(tabId: number, owner?: string): Promise<void> {
  if (owner !== undefined && leases.get(tabId) !== owner) return;
  leases.delete(tabId);
  await detach(tabId);
}

async function releaseClient(owner: string): Promise<void> {
  const tabIds = [...leases.entries()]
    .filter(([, currentOwner]) => currentOwner === owner)
    .map(([tabId]) => tabId);
  await Promise.allSettled(tabIds.map((tabId) => releaseTab(tabId, owner)));
}

async function releaseAll(): Promise<void> {
  await Promise.allSettled([...leases.keys()].map((tabId) => releaseTab(tabId)));
}

async function handleRpc(request: RpcRequest): Promise<unknown> {
  const params = request.params;
  switch (request.method) {
    case "bridge.status":
      return {
        extensionId: chrome.runtime.id,
        extensionVersion: chrome.runtime.getManifest().version,
        leases: [...leases.entries()].map(([tabId, owner]) => ({ owner, tabId })),
        name: "Codex Chromium Bridge",
        protocolVersion: PROTOCOL_VERSION,
      };

    case "tabs.list": {
      clientId(params);
      const tabs = (await chrome.tabs.query({})) as ChromeTab[];
      return tabs.filter((tab) => typeof tab.id === "number").map(tabInfo);
    }

    case "tabs.create": {
      const owner = clientId(params);
      const active =
        params && typeof params === "object" && "active" in params
          ? (params as { active?: unknown }).active !== false
          : true;
      const tab = tabInfo((await chrome.tabs.create({ active, url: "about:blank" })) as ChromeTab);
      leases.set(tab.id, owner);
      return tab;
    }

    case "tabs.claim": {
      const owner = clientId(params);
      const tabId = numberParam(params, "tabId");
      const existing = leases.get(tabId);
      if (existing && existing !== owner)
        throw new Error(`Tab ${tabId} is controlled by another client`);
      const tab = tabInfo((await chrome.tabs.get(tabId)) as ChromeTab);
      leases.set(tabId, owner);
      return tab;
    }

    case "tabs.release": {
      const { client, tabId } = requireLease(params);
      await releaseTab(tabId, client);
      return {};
    }

    case "client.release": {
      const owner = clientId(params);
      await releaseClient(owner);
      return {};
    }

    case "cdp.attach": {
      const { tabId } = requireLease(params);
      await attach(tabId);
      return {};
    }

    case "cdp.detach": {
      const { tabId } = requireLease(params);
      await detach(tabId);
      return {};
    }

    case "cdp.command": {
      const { tabId } = requireLease(params);
      if (!attachedTabs.has(tabId)) throw new Error(`Debugger is not attached to tab ${tabId}`);
      if (!params || typeof params !== "object") throw new Error("Missing CDP command");
      const method = (params as { method?: unknown }).method;
      const commandParams = (params as { params?: unknown }).params;
      if (typeof method !== "string" || method.length === 0) throw new Error("Invalid CDP method");
      return await chrome.debugger.sendCommand({ tabId }, method, commandParams ?? {});
    }

    default:
      throw new Error(`Unsupported extension method: ${request.method}`);
  }
}

async function onNativeMessage(message: unknown): Promise<void> {
  const parsed = parseRpcRequest(message);
  if (!parsed || parsed.id === undefined || !nativePort) return;
  try {
    nativePort.postMessage(rpcResult(parsed.id, await handleRpc(parsed)));
  } catch (cause) {
    nativePort.postMessage(rpcError(parsed.id, errorMessage(cause)));
  }
}

function notify(method: string, params: unknown): void {
  nativePort?.postMessage({ jsonrpc: "2.0", method, params });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(30_000, 500 * 2 ** Math.min(reconnectAttempt, 6));
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNative();
  }, delay);
}

function connectNative(): void {
  if (nativePort) return;
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME) as NativePort;
    nativePort = port;
    lastError = null;
    port.onMessage.addListener((message) => void onNativeMessage(message));
    port.onDisconnect.addListener(() => {
      if (nativePort !== port) return;
      nativePort = null;
      lastError = chrome.runtime.lastError?.message ?? "Native host disconnected";
      void releaseAll();
      scheduleReconnect();
    });
    port.postMessage({
      jsonrpc: "2.0",
      method: "bridge.hello",
      params: {
        extensionId: chrome.runtime.id || EXTENSION_ID,
        extensionVersion: chrome.runtime.getManifest().version,
        name: "Codex Chromium Bridge",
        protocolVersion: PROTOCOL_VERSION,
      },
    });
    reconnectAttempt = 0;
  } catch (cause) {
    nativePort = null;
    lastError = errorMessage(cause);
    scheduleReconnect();
  }
}

chrome.debugger.onEvent.addListener((source: Debuggee, method: string, params?: unknown) => {
  if (typeof source.tabId !== "number") return;
  const owner = leases.get(source.tabId);
  if (owner) notify("cdp.event", { clientId: owner, method, params, tabId: source.tabId });
});

chrome.debugger.onDetach.addListener((source: Debuggee, reason: string) => {
  if (typeof source.tabId !== "number") return;
  attachedTabs.delete(source.tabId);
  const owner = leases.get(source.tabId);
  if (owner) notify("cdp.detached", { clientId: owner, reason, tabId: source.tabId });
});

chrome.tabs.onRemoved.addListener((tabId: number) => {
  const owner = leases.get(tabId);
  leases.delete(tabId);
  attachedTabs.delete(tabId);
  if (owner) notify("tab.closed", { clientId: owner, tabId });
});

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender: unknown, sendResponse: (value: unknown) => void) => {
    if (!message || typeof message !== "object" || !("type" in message)) return false;
    const type = (message as { type?: unknown }).type;
    if (type === "popup.status") {
      sendResponse({
        connected: nativePort !== null,
        host: NATIVE_HOST_NAME,
        lastError,
        leases: leases.size,
      });
      return false;
    }
    if (type === "popup.releaseAll") {
      void releaseAll().then(
        () => sendResponse({ ok: true }),
        (cause) => sendResponse({ error: errorMessage(cause), ok: false }),
      );
      return true;
    }
    return false;
  },
);

chrome.alarms.onAlarm.addListener((alarm: { name?: string }) => {
  if (alarm.name === "bridge-reconnect" && !nativePort) connectNative();
});
void chrome.alarms.create("bridge-reconnect", { periodInMinutes: 0.5 });

connectNative();
