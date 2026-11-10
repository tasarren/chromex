import { type BridgeEvent, parseEvents } from "./events.ts"
import { isRecord, nonnegativeInteger } from "./session-state.ts"

/** Messages the popup sends to the service worker. */
export type PopupCommand =
  | { type: "popup.status" }
  | { type: "popup.observe"; enabled: boolean }
  | { type: "popup.releaseAll" }

export type PopupClient = {
  attached: number;
  clientId: string;
  label: string | null;
  mode: "managed" | "observe" | null;
  tabs: { id: number; title: string; url: string }[];
  windowId: number | null;
}

/** Everything the popup renders: who is connected, what they own, and what has happened. */
export type PopupStatus = {
  activeTabId: number | null;
  clients: PopupClient[];
  connected: boolean;
  events: BridgeEvent[];
  host: string;
  lastError: string | null;
  leases: number;
  managed: boolean;
  observeEnabled: boolean;
}

/** Every command answers with the confirmed state after it ran, or an explicit error. */
export type PopupResult = { ok: true; status: PopupStatus } | { ok: false; error: string }

export function parsePopupCommand(value: unknown): PopupCommand | null {
  if (!isRecord(value)) return null
  switch (value.type) {
    case "popup.status":
    case "popup.releaseAll":
      return { type: value.type }
    case "popup.observe":
      return typeof value.enabled === "boolean"
        ? { type: value.type, enabled: value.enabled }
        : null
    default:
      return null
  }
}

export function parsePopupResult(value: unknown): PopupResult {
  if (isRecord(value) && value.ok === false && typeof value.error === "string") {
    return { ok: false, error: value.error }
  }
  const status = isRecord(value) && value.ok === true ? parseStatus(value.status) : null
  return status ? { ok: true, status } : { ok: false, error: "Invalid reply from the extension" }
}

function parseStatus(value: unknown): PopupStatus | null {
  if (!isRecord(value) || !Array.isArray(value.clients)) return null
  const clients = value.clients.map(parseClient)
  const leases = nonnegativeInteger(value.leases)
  const activeTabId = value.activeTabId === null ? null : nonnegativeInteger(value.activeTabId)
  if (
    clients.some((client) => client === null) ||
    leases === undefined ||
    activeTabId === undefined ||
    typeof value.connected !== "boolean" ||
    typeof value.host !== "string" ||
    !nullableString(value.lastError) ||
    typeof value.managed !== "boolean" ||
    typeof value.observeEnabled !== "boolean"
  ) {
    return null
  }
  return {
    activeTabId,
    clients: clients as PopupClient[],
    connected: value.connected,
    events: parseEvents(value.events),
    host: value.host,
    lastError: value.lastError,
    leases,
    managed: value.managed,
    observeEnabled: value.observeEnabled,
  }
}

function parseClient(value: unknown): PopupClient | null {
  if (!isRecord(value) || typeof value.clientId !== "string" || !Array.isArray(value.tabs)) {
    return null
  }
  const attached = nonnegativeInteger(value.attached)
  const windowId = value.windowId === null ? null : nonnegativeInteger(value.windowId)
  const mode = value.mode === "managed" || value.mode === "observe" ? value.mode : null
  const tabs = value.tabs.flatMap((tab) => {
    const id = isRecord(tab) ? nonnegativeInteger(tab.id) : undefined
    return isRecord(tab) &&
      id !== undefined &&
      typeof tab.title === "string" &&
      typeof tab.url === "string"
      ? [{ id, title: tab.title, url: tab.url }]
      : []
  })
  if (attached === undefined || windowId === undefined || !nullableString(value.label)) return null
  return { attached, clientId: value.clientId, label: value.label, mode, tabs, windowId }
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}
