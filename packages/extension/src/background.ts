import { appendEvent, type BridgeEvent, type BridgeEventKind, shortUrl } from "./events.js";
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
import {
  beginSessionGeneration,
  emptySessionState,
  findBootstrapTab,
  parseSessionState,
  reconcileSessionState,
  SESSION_STATE_VERSION,
  type SessionState,
} from "./session-state.js";

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
type DebuggerTarget = { attached?: boolean; tabId?: number };
type ChromeWindow = { id?: number; tabs?: ChromeTab[]; type?: string };

const leases = new Map<number, string>();
const attachedTabs = new Set<number>();
/** Per-client window preference; windows outlive clients. */
const windows = new Map<string, number>();
/** Human-readable client names for the popup, sent by the MCP server on connect. */
const labels = new Map<string, string>();
const modes = new Map<string, "managed" | "observe">();
let nativePort: NativePort | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let lastError: string | null = null;
let managed = false;
const observeTabs = new Set<number>();
let operations: Promise<unknown> = Promise.resolve();
function serialized<T>(action: () => Promise<T>): Promise<T> {
  const result = operations.then(action);
  operations = result.catch(() => undefined);
  return result;
}

const EVENTS_KEY = "bridgeEvents";
const SESSION_KEY = "bridgeSessionState";
let generation = 0;
let stateWrite: Promise<void> = Promise.resolve();
const stateReady = restoreSessionState().catch((cause) => {
  lastError = `Session recovery failed: ${errorMessage(cause)}`;
});

/**
 * Record an event for the popup. Kept in session storage because MV3 suspends this worker after
 * ~30s idle, which would wipe an in-memory log. Fire-and-forget: logging must never delay or fail
 * a bridge operation.
 */
function logEvent(kind: BridgeEventKind, entry: Partial<BridgeEvent> = {}): void {
  const event: BridgeEvent = { ...entry, kind, ts: Date.now() };
  if (event.clientId !== undefined && event.label === undefined) {
    const label = labels.get(event.clientId);
    if (label !== undefined) event.label = label;
  }
  void chrome.storage.session
    .get(EVENTS_KEY)
    .then((stored: Record<string, unknown>) =>
      chrome.storage.session.set({
        [EVENTS_KEY]: appendEvent((stored?.[EVENTS_KEY] as BridgeEvent[]) ?? [], event),
      }),
    )
    .catch(() => {
      // A full or unavailable session store must not break browser control.
    });
}

async function readEvents(): Promise<BridgeEvent[]> {
  try {
    const stored = (await chrome.storage.session.get(EVENTS_KEY)) as Record<string, unknown>;
    return (stored?.[EVENTS_KEY] as BridgeEvent[]) ?? [];
  } catch {
    return [];
  }
}

function currentSessionState(): SessionState {
  const owners = new Set([
    ...labels.keys(),
    ...modes.keys(),
    ...windows.keys(),
    ...leases.values(),
  ]);
  return {
    clients: [...owners].map((owner) => ({
      clientId: owner,
      ...(labels.has(owner) ? { label: labels.get(owner) } : {}),
      ...(modes.has(owner) ? { mode: modes.get(owner) } : {}),
      ...(windows.has(owner) ? { windowId: windows.get(owner) } : {}),
    })),
    generation,
    leases: [...leases.entries()].map(([tabId, owner]) => ({
      clientId: owner,
      desiredAttached: attachedTabs.has(tabId),
      tabId,
    })),
    version: SESSION_STATE_VERSION,
  };
}

function persistSessionState(): Promise<void> {
  const snapshot = currentSessionState();
  stateWrite = stateWrite
    .catch(() => undefined)
    .then(() => chrome.storage.session.set({ [SESSION_KEY]: snapshot }))
    .catch(() => undefined);
  return stateWrite;
}

async function restoreSessionState(): Promise<void> {
  let stored = emptySessionState();
  try {
    const value = (await chrome.storage.session.get([
      SESSION_KEY,
      "observeTabs",
      "managed",
    ])) as Record<string, unknown>;
    stored = parseSessionState(value?.[SESSION_KEY]);
    managed = value.managed === true;
    for (const id of Array.isArray(value.observeTabs) ? value.observeTabs : []) {
      if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) observeTabs.add(id);
    }
  } catch {
    // An unavailable session store starts clean; browser control still works.
  }
  const [tabs, browserWindows] = await Promise.all([
    chrome.tabs.query({}) as Promise<ChromeTab[]>,
    chrome.windows.getAll() as Promise<ChromeWindow[]>,
  ]);
  const reconciled = beginSessionGeneration(
    reconcileSessionState(stored, {
      tabIds: tabs.flatMap((tab) => (typeof tab.id === "number" ? [tab.id] : [])),
      windowIds: browserWindows.flatMap((window) =>
        typeof window.id === "number" ? [window.id] : [],
      ),
    }),
  );
  generation = reconciled.generation;
  for (const client of reconciled.clients) {
    if (client.label !== undefined) labels.set(client.clientId, client.label);
    if (client.mode !== undefined) modes.set(client.clientId, client.mode);
    if (client.windowId !== undefined) windows.set(client.clientId, client.windowId);
  }
  for (const lease of reconciled.leases) {
    if (managed || observeTabs.has(lease.tabId)) leases.set(lease.tabId, lease.clientId);
  }

  const targets = (await chrome.debugger.getTargets()) as DebuggerTarget[];
  for (const lease of reconciled.leases) {
    if (!leases.has(lease.tabId)) continue;
    if (!lease.desiredAttached) continue;
    const target = targets.find((candidate) => candidate.tabId === lease.tabId);
    try {
      if (target?.attached === true) {
        await chrome.debugger.sendCommand({ tabId: lease.tabId }, "Runtime.enable", {});
      } else {
        await chrome.debugger.attach({ tabId: lease.tabId }, "1.3");
      }
      attachedTabs.add(lease.tabId);
    } catch {
      // DevTools or another debugger may own it; status exposes the detached lease for recovery.
    }
  }
  await persistSessionState().catch(() => undefined);
  if (stored.generation > 0) logEvent("worker.restarted", { detail: `generation ${generation}` });
}

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
  assertTabAccess(tabId);
  const owner = leases.get(tabId);
  if (owner !== client) throw new Error(`Tab ${tabId} is not leased by this Codex client`);
  return { client, tabId };
}

function assertTabAccess(tabId: number): void {
  if (!managed && !observeTabs.has(tabId))
    throw new Error(
      "Observe access disabled. Enable 'Allow agents on this tab' in the extension popup.",
    );
}

async function attach(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabs.add(tabId);
  logEvent("debugger.attached", { clientId: leases.get(tabId), tabId });
  await persistSessionState();
}

async function detach(tabId: number): Promise<void> {
  if (!attachedTabs.delete(tabId)) return;
  logEvent("debugger.detached", { clientId: leases.get(tabId), tabId });
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // The browser may already have detached because the tab closed or DevTools took over.
  }
  await persistSessionState();
}

async function releaseTab(tabId: number, owner?: string): Promise<void> {
  if (owner !== undefined && leases.get(tabId) !== owner) return;
  leases.delete(tabId);
  await detach(tabId);
  await persistSessionState();
}

/**
 * Return the client's window, creating one if it has none or the user closed it. A newly created
 * window already contains one blank tab, which is returned so the caller can adopt it rather than
 * opening a second tab and stranding this one.
 */
async function ensureWindow(
  owner: string,
  adoptExisting: boolean,
): Promise<{ tabId?: number; windowId: number }> {
  const existing = windows.get(owner);
  if (existing !== undefined) {
    try {
      await chrome.windows.get(existing);
      return { windowId: existing };
    } catch {
      windows.delete(owner);
      await persistSessionState();
    }
  }
  if (adoptExisting) {
    const browserWindows = (await chrome.windows.getAll({
      populate: true,
      windowTypes: ["normal"],
    })) as ChromeWindow[];
    const bootstrap = findBootstrapTab(browserWindows, leases.keys());
    if (bootstrap) {
      windows.set(owner, bootstrap.windowId);
      leases.set(bootstrap.tabId, owner);
      logEvent("tab.claimed", {
        clientId: owner,
        tabId: bootstrap.tabId,
        windowId: bootstrap.windowId,
      });
      await persistSessionState();
      return bootstrap;
    }
  }
  // Not focused: an agent working in the background must not steal the user's focus.
  const created = (await chrome.windows.create({ focused: false, url: "about:blank" })) as {
    id?: number;
    tabs?: ChromeTab[];
  };
  if (typeof created.id !== "number") throw new Error("Chromium returned a window without an ID");
  windows.set(owner, created.id);
  logEvent("window.created", { clientId: owner, windowId: created.id });
  await persistSessionState();
  const blankTabId = created.tabs?.find((tab) => typeof tab.id === "number")?.id;
  if (blankTabId === undefined) return { windowId: created.id };
  leases.set(blankTabId, owner);
  logEvent("tab.opened", { clientId: owner, tabId: blankTabId, windowId: created.id });
  await persistSessionState();
  return { tabId: blankTabId, windowId: created.id };
}

async function releaseClient(owner: string): Promise<void> {
  const tabIds = [...leases.entries()]
    .filter(([, currentOwner]) => currentOwner === owner)
    .map(([tabId]) => tabId);
  await Promise.allSettled(tabIds.map((tabId) => releaseTab(tabId, owner)));
  const windowId = windows.get(owner);
  logEvent("client.disconnected", {
    clientId: owner,
    ...(windowId === undefined ? {} : { windowId }),
  });
  windows.delete(owner);
  labels.delete(owner);
  modes.delete(owner);
  await persistSessionState();
}

async function releaseAll(): Promise<void> {
  await Promise.allSettled([...leases.keys()].map((tabId) => releaseTab(tabId)));
}

async function handleRpc(request: RpcRequest): Promise<unknown> {
  await stateReady;
  const params = request.params;
  switch (request.method) {
    case "bridge.configure":
      managed = (params as { managed?: unknown })?.managed === true;
      await chrome.storage.session.set({ managed });
      return {};
    case "bridge.status":
      return {
        extensionId: chrome.runtime.id,
        extensionVersion: chrome.runtime.getManifest().version,
        generation,
        leases: [...leases.entries()].map(([tabId, owner]) => ({
          attached: attachedTabs.has(tabId),
          owner,
          tabId,
        })),
        name: "Codex Chromium Bridge",
        managed,
        protocolVersion: PROTOCOL_VERSION,
        windows: [...windows.entries()].map(([owner, windowId]) => ({ owner, windowId })),
      };

    case "client.status": {
      const owner = clientId(params);
      return {
        generation,
        leases: [...leases.entries()]
          .filter(([, currentOwner]) => currentOwner === owner)
          .map(([tabId]) => ({ attached: attachedTabs.has(tabId), tabId })),
        mode: modes.get(owner) ?? null,
        windowId: windows.get(owner) ?? null,
      };
    }

    case "tabs.list": {
      clientId(params);
      const tabs = (await chrome.tabs.query({})) as ChromeTab[];
      return tabs
        .filter((tab) => typeof tab.id === "number" && (managed || observeTabs.has(tab.id)))
        .map((tab) => ({ ...tabInfo(tab), controlled: leases.has(tab.id as number) }));
    }

    case "window.ensure": {
      if (!managed) throw new Error("Observe mode cannot create windows");
      const owner = clientId(params);
      const adoptExisting =
        params !== null &&
        typeof params === "object" &&
        (params as { adoptExisting?: unknown }).adoptExisting === true;
      return await ensureWindow(owner, adoptExisting);
    }

    case "tabs.create": {
      if (!managed) throw new Error("Observe mode cannot create tabs");
      const owner = clientId(params);
      const active =
        params && typeof params === "object" && "active" in params
          ? (params as { active?: unknown }).active !== false
          : true;
      const windowId =
        params && typeof params === "object" && "windowId" in params
          ? numberParam(params, "windowId")
          : undefined;
      const tab = tabInfo(
        (await chrome.tabs.create({
          active,
          url: "about:blank",
          ...(windowId === undefined ? {} : { windowId }),
        })) as ChromeTab,
      );
      leases.set(tab.id, owner);
      logEvent("tab.opened", { clientId: owner, tabId: tab.id, windowId: tab.windowId });
      await persistSessionState();
      return tab;
    }

    case "tabs.claim": {
      const owner = clientId(params);
      const tabId = numberParam(params, "tabId");
      assertTabAccess(tabId);
      const existing = leases.get(tabId);
      if (existing && existing !== owner)
        throw new Error(`Tab ${tabId} is controlled by another client`);
      const tab = tabInfo((await chrome.tabs.get(tabId)) as ChromeTab);
      // Re-claiming a tab this client already holds is a no-op refresh, not worth a feed line.
      if (existing !== owner)
        logEvent("tab.claimed", { clientId: owner, tabId, windowId: tab.windowId });
      leases.set(tabId, owner);
      await persistSessionState();
      return tab;
    }

    case "tabs.park": {
      const { tabId } = requireLease(params);
      await detach(tabId);
      return {};
    }

    case "tabs.release": {
      const { client, tabId } = requireLease(params);
      await releaseTab(tabId, client);
      return {};
    }

    case "tabs.close": {
      const { client, tabId } = requireLease(params);
      await releaseTab(tabId, client);
      logEvent("tab.closed", { clientId: client, tabId });
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // The tab may already be gone.
      }
      return {};
    }

    case "client.hello": {
      const owner = clientId(params);
      const hello = params as { label?: unknown; mode?: unknown };
      if (typeof hello.label === "string" && hello.label.length > 0) {
        labels.set(owner, hello.label.slice(0, 120));
      }
      if (hello.mode === "managed" || hello.mode === "observe") modes.set(owner, hello.mode);
      logEvent("client.connected", { clientId: owner });
      await persistSessionState();
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
    const result = await serialized(() => handleRpc(parsed));
    nativePort?.postMessage(rpcResult(parsed.id, result));
  } catch (cause) {
    nativePort?.postMessage(rpcError(parsed.id, errorMessage(cause)));
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
  if (!owner) return;
  notify("cdp.event", { clientId: owner, method, params, tabId: source.tabId });
  // Only top-level navigations are worth a feed line; subframes fire constantly.
  if (method !== "Page.frameNavigated") return;
  const frame = (params as { frame?: { parentId?: unknown; url?: unknown } } | undefined)?.frame;
  if (!frame || frame.parentId !== undefined || typeof frame.url !== "string") return;
  logEvent("navigated", { clientId: owner, detail: shortUrl(frame.url), tabId: source.tabId });
});

chrome.debugger.onDetach.addListener((source: Debuggee, reason: string) => {
  if (typeof source.tabId !== "number") return;
  attachedTabs.delete(source.tabId);
  const owner = leases.get(source.tabId);
  if (owner) notify("cdp.detached", { clientId: owner, reason, tabId: source.tabId });
  void persistSessionState();
});

chrome.windows.onRemoved.addListener((windowId: number) => {
  for (const [owner, id] of windows) {
    if (id !== windowId) continue;
    windows.delete(owner);
    logEvent("window.closed", { clientId: owner, windowId });
  }
  void persistSessionState();
});

chrome.tabs.onRemoved.addListener((tabId: number) => {
  observeTabs.delete(tabId);
  void chrome.storage.session.set({ observeTabs: [...observeTabs] });
  const owner = leases.get(tabId);
  leases.delete(tabId);
  attachedTabs.delete(tabId);
  if (owner) notify("tab.closed", { clientId: owner, tabId });
  void persistSessionState();
});

/** Everything the popup renders: who is connected, what they own, and what has happened. */
async function popupStatus(): Promise<unknown> {
  await stateReady;
  const owners = new Set([
    ...leases.values(),
    ...windows.keys(),
    ...labels.keys(),
    ...modes.keys(),
  ]);
  const tabsByOwner = new Map<string, number[]>();
  for (const [tabId, owner] of leases)
    tabsByOwner.set(owner, [...(tabsByOwner.get(owner) ?? []), tabId]);
  const clients = await Promise.all(
    [...owners].map(async (owner) => {
      const tabIds = tabsByOwner.get(owner) ?? [];
      return {
        attached: tabIds.filter((tabId) => attachedTabs.has(tabId)).length,
        clientId: owner,
        label: labels.get(owner) ?? null,
        mode: modes.get(owner) ?? null,
        tabs: await Promise.all(tabIds.map(describeTab)),
        windowId: windows.get(owner) ?? null,
      };
    }),
  );
  const [active] = (await chrome.tabs.query({ active: true, currentWindow: true })) as ChromeTab[];
  return {
    managed,
    observeEnabled: active?.id !== undefined && observeTabs.has(active.id),
    activeTabId: active?.id ?? null,
    clients,
    connected: nativePort !== null,
    events: await readEvents(),
    host: NATIVE_HOST_NAME,
    lastError,
    leases: leases.size,
  };
}

async function describeTab(tabId: number): Promise<{ id: number; title: string; url: string }> {
  try {
    const tab = (await chrome.tabs.get(tabId)) as ChromeTab;
    return { id: tabId, title: tab.title ?? "", url: tab.url ?? "" };
  } catch {
    return { id: tabId, title: "", url: "" };
  }
}

chrome.runtime.onMessage.addListener(
  (message: unknown, sender: { url?: string }, sendResponse: (value: unknown) => void) => {
    if (sender.url !== chrome.runtime.getURL("popup.html")) return false;
    if (!message || typeof message !== "object" || !("type" in message)) return false;
    const type = (message as { type?: unknown }).type;
    if (type === "popup.observe") {
      void serialized(async () => {
        await stateReady;
        if (managed) throw new Error("Managed browser already permits agent tabs");
        const enabled = (message as { enabled?: unknown }).enabled;
        if (typeof enabled !== "boolean") throw new Error("Invalid Observe toggle");
        const [tab] = (await chrome.tabs.query({
          active: true,
          currentWindow: true,
        })) as ChromeTab[];
        if (tab?.id === undefined) throw new Error("No active tab");
        if (enabled) observeTabs.add(tab.id);
        else {
          observeTabs.delete(tab.id);
          const owner = leases.get(tab.id);
          if (owner) notify("tab.closed", { clientId: owner, tabId: tab.id });
          await releaseTab(tab.id);
        }
        await chrome.storage.session.set({ observeTabs: [...observeTabs] });
        return { ok: true };
      }).then(sendResponse, (cause) => sendResponse({ ok: false, error: errorMessage(cause) }));
      return true;
    }
    if (type === "popup.status") {
      void popupStatus().then(sendResponse, () =>
        sendResponse({
          clients: [],
          connected: nativePort !== null,
          events: [],
          host: NATIVE_HOST_NAME,
          lastError,
          leases: leases.size,
        }),
      );
      // Reading the event log is asynchronous, so the channel must stay open.
      return true;
    }
    if (type === "popup.releaseAll") {
      void serialized(releaseAll).then(
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

void stateReady.then(connectNative);
