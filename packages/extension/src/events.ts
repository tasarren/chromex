import { isRecord } from "./session-state.ts"

export type BridgeEventKind =
  | "client.connected"
  | "client.disconnected"
  | "debugger.attached"
  | "debugger.detached"
  | "navigated"
  | "tab.claimed"
  | "tab.closed"
  | "tab.opened"
  | "window.closed"
  | "window.created"
  | "worker.restarted"

export type BridgeEvent = {
  clientId?: string | undefined;
  detail?: string | undefined;
  kind: BridgeEventKind;
  label?: string | undefined;
  tabId?: number | undefined;
  ts: number;
  windowId?: number | undefined;
}

/** Prepend an event, newest first, dropping the oldest past capacity. */
export function appendEvent(
  events: BridgeEvent[],
  entry: BridgeEvent,
  capacity = 100,
): BridgeEvent[] {
  return [entry, ...events].slice(0, capacity)
}

/** Keep only well-formed events from storage or a message; anything else is dropped. */
export function parseEvents(value: unknown): BridgeEvent[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown): BridgeEvent[] => {
    if (!isRecord(item)) return []
    const { clientId, detail, kind, label, tabId, ts, windowId } = item
    if (!isEventKind(kind) || typeof ts !== "number") return []
    return [
      {
        kind,
        ts,
        ...(typeof clientId === "string" ? { clientId } : {}),
        ...(typeof detail === "string" ? { detail } : {}),
        ...(typeof label === "string" ? { label } : {}),
        ...(typeof tabId === "number" ? { tabId } : {}),
        ...(typeof windowId === "number" ? { windowId } : {}),
      },
    ]
  })
}

const VERBS: Record<BridgeEventKind, string> = {
  "client.connected": "connected",
  "client.disconnected": "disconnected",
  "debugger.attached": "attached debugger",
  "debugger.detached": "detached debugger",
  navigated: "navigated",
  "tab.claimed": "claimed tab",
  "tab.closed": "closed tab",
  "tab.opened": "opened tab",
  "window.closed": "closed window",
  "window.created": "created window",
  "worker.restarted": "service worker restarted",
}

function isEventKind(value: unknown): value is BridgeEventKind {
  return typeof value === "string" && Object.hasOwn(VERBS, value)
}

/** One line describing an event, for the popup feed. */
export function formatEvent(entry: BridgeEvent): string {
  const parts = [VERBS[entry.kind]]
  if (entry.tabId !== undefined && entry.kind !== "navigated") parts.push(`#${entry.tabId}`)
  // Window events already name the window in their verb; others place it as context.
  if (entry.windowId !== undefined && !entry.kind.startsWith("window."))
    parts.push(`in window ${entry.windowId}`)
  else if (entry.windowId !== undefined) parts.push(String(entry.windowId))
  if (entry.detail) parts.push(entry.detail)
  return parts.join(" ")
}

/** Local wall-clock time, the only form that is useful when scanning a live feed. */
export function formatTime(ts: number): string {
  const time = new Date(ts)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`
}

/** Shorten a URL to origin + path, so a feed line stays readable. */
export function shortUrl(value: string): string {
  try {
    const url = new URL(value)
    // Non-web schemes (about:, chrome:) have no host, so shortening would mangle them.
    if (url.protocol !== "http:" && url.protocol !== "https:") return value
    const path = url.pathname === "/" ? "" : url.pathname
    return `${url.host}${path}`
  } catch {
    return value
  }
}
