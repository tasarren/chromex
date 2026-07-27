import { type BridgeEvent, formatEvent, formatTime } from "./events.js";

// biome-ignore lint/suspicious/noExplicitAny: Chromium injects this untyped extension API global.
declare const chrome: any;

type ClientInfo = {
  attached: number;
  clientId: string;
  label: string | null;
  tabs: { id: number; title: string; url: string }[];
  windowId: number | null;
};

type PopupStatus = {
  managed: boolean;
  observeEnabled: boolean;
  activeTabId: number | null;
  clients: ClientInfo[];
  connected: boolean;
  events: BridgeEvent[];
  host: string;
  lastError: string | null;
  leases: number;
};

const REFRESH_MS = 1_000;

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing popup element: ${id}`);
  return found;
}

/** Build a list item from plain text parts. Never innerHTML: titles and URLs are page-controlled. */
function row(parts: { className: string; text: string }[]): HTMLLIElement {
  const item = document.createElement("li");
  for (const part of parts) {
    const span = document.createElement("span");
    span.className = part.className;
    span.textContent = part.text;
    item.append(span);
  }
  return item;
}

function describeClient(client: ClientInfo): string {
  const name = client.label ?? `${client.clientId.slice(0, 8)}…`;
  const where = client.windowId === null ? "no window" : `window ${client.windowId}`;
  return `${name} — ${where}`;
}

function renderClients(clients: ClientInfo[]): void {
  const list = element("clients");
  list.replaceChildren();
  if (clients.length === 0) {
    list.append(row([{ className: "empty", text: "No agents connected." }]));
    return;
  }
  for (const client of clients) {
    const tab = client.tabs[0];
    const detail =
      tab === undefined
        ? "idle"
        : `${tab.title || tab.url || `tab ${tab.id}`}${client.attached > 0 ? " · driving" : ""}`;
    list.append(
      row([
        { className: "client-name", text: describeClient(client) },
        { className: "client-tab", text: detail },
      ]),
    );
  }
}

function renderEvents(events: BridgeEvent[]): void {
  const list = element("events");
  list.replaceChildren();
  if (events.length === 0) {
    list.append(row([{ className: "empty", text: "Nothing yet." }]));
    return;
  }
  for (const event of events.slice(0, 40)) {
    list.append(
      row([
        { className: "event-time", text: formatTime(event.ts) },
        { className: "event-who", text: event.label ?? event.clientId?.slice(0, 8) ?? "bridge" },
        { className: "event-what", text: formatEvent(event) },
      ]),
    );
  }
}

async function refresh(): Promise<void> {
  const status = (await chrome.runtime.sendMessage({ type: "popup.status" })) as PopupStatus;
  const statusNode = element("status");
  statusNode.textContent = status.connected ? "Connected" : "Disconnected";
  statusNode.className = `status ${status.connected ? "connected" : "disconnected"}`;
  element("native-host").textContent = status.connected
    ? status.host
    : status.lastError || status.host;
  element("lease-count").textContent = String(status.leases);
  element("observe-control").hidden = status.managed;
  const toggle = element("observe") as HTMLInputElement;
  toggle.checked = status.observeEnabled;
  toggle.disabled = status.activeTabId === null;
  element("browser-mode").textContent = status.managed
    ? "Shared Managed browser"
    : "Observe access applies only to this tab, until revoked or browser closes.";
  renderClients(status.clients ?? []);
  renderEvents(status.events ?? []);
}

element("disconnect").addEventListener("click", async () => {
  const message = element("message");
  message.textContent = "Releasing…";
  const result = (await chrome.runtime.sendMessage({ type: "popup.releaseAll" })) as {
    error?: string;
    ok: boolean;
  };
  message.textContent = result.ok ? "All tabs released." : result.error || "Release failed.";
  await refresh();
});

element("observe").addEventListener("change", async () => {
  const result = await chrome.runtime.sendMessage({
    type: "popup.observe",
    enabled: (element("observe") as HTMLInputElement).checked,
  });
  element("message").textContent = result.ok
    ? "Observe access updated."
    : result.error || "Update failed.";
  await refresh();
});

// A static view of a live system is misleading, and a popup only runs while it is open.
const timer = setInterval(() => void refresh(), REFRESH_MS);
addEventListener("pagehide", () => clearInterval(timer));

void refresh();
