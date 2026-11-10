import { type BridgeEvent, formatEvent, formatTime } from "./events.ts"
import {
  type PopupClient,
  type PopupCommand,
  type PopupStatus,
  parsePopupResult,
} from "./popup-contract.ts"

const REFRESH_MS = 1_000
// Vite removes this branch and its module from production extension output.
const preview = import.meta.env.DEV && location.protocol !== "chrome-extension:"
  ? import("./popup-preview.ts").then(({ mountPreview }) => mountPreview())
  : null

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id)
  if (!(found instanceof type)) throw new Error(`Missing popup element: ${id}`)
  return found
}

const statusNode = element("status", HTMLParagraphElement)
const toggle = element("observe", HTMLInputElement)
const releaseButton = element("disconnect", HTMLButtonElement)
const messageNode = element("message", HTMLParagraphElement)

/** Build a list item from plain text parts. Never innerHTML: titles and URLs are page-controlled. */
function row(parts: { className: string; text: string }[]): HTMLLIElement {
  const item = document.createElement("li")
  for (const part of parts) {
    const span = document.createElement("span")
    span.className = part.className
    span.textContent = part.text
    item.append(span)
  }
  return item
}

function describeClient(client: PopupClient): string {
  const name = client.label ?? `${client.clientId.slice(0, 8)}…`
  const where = client.windowId === null ? "no window" : `window ${client.windowId}`
  return `${name} — ${where}`
}

function renderClients(clients: PopupClient[]): void {
  const list = element("clients", HTMLUListElement)
  list.replaceChildren()
  if (clients.length === 0) {
    list.append(row([{ className: "empty", text: "No agents connected." }]))
    return
  }
  for (const client of clients) {
    const tab = client.tabs[0]
    const detail =
      tab === undefined
        ? "idle"
        : `${tab.title || tab.url || `tab ${tab.id}`}${client.attached > 0 ? " · driving" : ""}`
    list.append(
      row([
        { className: "client-name", text: describeClient(client) },
        { className: "client-tab", text: detail },
      ]),
    )
  }
}

function renderEvents(events: BridgeEvent[]): void {
  const list = element("events", HTMLUListElement)
  list.replaceChildren()
  if (events.length === 0) {
    list.append(row([{ className: "empty", text: "Nothing yet." }]))
    return
  }
  for (const event of events.slice(0, 40)) {
    list.append(
      row([
        { className: "event-time", text: formatTime(event.ts) },
        { className: "event-who", text: event.label ?? event.clientId?.slice(0, 8) ?? "bridge" },
        { className: "event-what", text: formatEvent(event) },
      ]),
    )
  }
}

/** The toggle always shows the grant the worker confirmed, never the user's unconfirmed click. */
function render(status: PopupStatus): void {
  statusNode.textContent = status.connected ? "Connected" : "Disconnected"
  statusNode.className = `status ${status.connected ? "connected" : "disconnected"}`
  element("native-host", HTMLElement).textContent = status.connected
    ? status.host
    : status.lastError || status.host
  element("lease-count", HTMLElement).textContent = String(status.leases)
  element("observe-control", HTMLLabelElement).hidden = status.managed
  confirmedGrant = status.observeEnabled
  toggle.checked = confirmedGrant
  toggle.disabled = busy || status.activeTabId === null
  element("browser-mode", HTMLParagraphElement).textContent = status.managed
    ? "Shared Managed browser"
    : "Observe access applies only to this tab, until revoked or browser closes."
  renderClients(status.clients)
  renderEvents(status.events)
}

function renderUnavailable(error: string): void {
  statusNode.textContent = "Unavailable"
  statusNode.className = "status disconnected"
  toggle.checked = confirmedGrant
  toggle.disabled = true
  messageNode.textContent = error
}

async function send(command: PopupCommand): Promise<PopupStatus> {
  let reply: unknown
  try {
    reply = preview ? (await preview)(command) : await chrome.runtime.sendMessage(command)
  } catch(cause) {
    throw new Error(`The extension did not answer: ${errorText(cause)}`, { cause })
  }
  const result = parsePopupResult(reply)
  if (!result.ok) throw new Error(result.error)
  return result.status
}

let busy = false
let refreshing = false
/** The Observe grant the worker last confirmed for the active tab. */
let confirmedGrant = false
/** Bumped by every user action, so a status poll that started earlier cannot overwrite it. */
let actions = 0

async function refresh(): Promise<void> {
  // A slow worker must not stack status requests; skip a tick instead.
  if (refreshing || busy) return
  refreshing = true
  const started = actions
  try {
    const status = await send({ type: "popup.status" })
    if (started === actions) render(status)
  } catch(cause) {
    if (started === actions) renderUnavailable(errorText(cause))
  } finally {
    refreshing = false
  }
}

/** Run one user action with its controls disabled, then show the confirmed state or the error. */
async function act(command: PopupCommand, pending: string, done: string): Promise<void> {
  actions += 1
  busy = true
  // The browser already flipped the checkbox on click; show the confirmed grant until the worker answers.
  toggle.checked = confirmedGrant
  toggle.disabled = true
  releaseButton.disabled = true
  messageNode.textContent = pending
  let status: PopupStatus | null = null
  let error: string | null = null
  try {
    status = await send(command)
  } catch(cause) {
    error = errorText(cause)
  }
  busy = false
  releaseButton.disabled = false
  if (status) {
    render(status)
    messageNode.textContent = done
    return
  }
  // The action failed; keep the confirmed grant, ask the worker for its state, then show the reason.
  toggle.checked = confirmedGrant
  await refresh()
  messageNode.textContent = error
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

releaseButton.addEventListener("click", () => {
  void act({ type: "popup.releaseAll" }, "Releasing…", "All tabs released.")
})

toggle.addEventListener("change", () => {
  const enabled = toggle.checked
  void act(
    { type: "popup.observe", enabled },
    "Updating Observe access…",
    enabled ? "Agents may use this tab." : "Agent access to this tab revoked.",
  )
})

// A static view of a live system is misleading, and a popup only runs while it is open.
const timer = setInterval(() => void refresh(), REFRESH_MS)
addEventListener("pagehide", () => { clearInterval(timer) })

void refresh()
