import { NATIVE_HOST_NAME } from "@chromex/protocol"
import type { PopupCommand, PopupResult, PopupStatus } from "./popup-contract.ts"

/** Local samples only; no Chrome APIs, storage or backend. Reload resets the sample. */
export function createPreview(mode: string | null): (command: PopupCommand) => PopupResult {
  const empty = mode === "empty"
  const managed = mode === "managed"
  // ponytail: one sample tab; extend fixtures only when another layout needs it.
  let status: PopupStatus = {
    activeTabId: empty ? null : 11,
    clients: empty ? [] : [{
      attached: 1,
      clientId: "sample-agent",
      label: "Sample agent",
      mode: managed ? "managed" : "observe",
      tabs: [{ id: 11, title: "Example page", url: "https://example.com/" }],
      windowId: 1,
    }],
    connected: !empty,
    events: empty ? [] : [{
      kind: "navigated",
      label: "Sample agent",
      detail: "example.com",
      tabId: 11,
      ts: Date.UTC(2026, 0, 1, 12),
    }],
    host: NATIVE_HOST_NAME,
    lastError: empty ? "Sample bridge is offline." : null,
    leases: empty ? 0 : 1,
    managed,
    observeEnabled: !empty && !managed,
  }
  return (command) => {
    switch (command.type) {
      case "popup.status":
        break
      case "popup.observe":
        if (status.managed) return { ok: false, error: "Managed browser already permits agent tabs" }
        if (status.activeTabId === null) return { ok: false, error: "No active tab" }
        status = { ...status, observeEnabled: command.enabled }
        break
      case "popup.releaseAll":
        break
    }
    if (command.type === "popup.releaseAll" || (command.type === "popup.observe" && !command.enabled)) {
      status = {
        ...status,
        leases: 0,
        clients: status.clients.map((client) => ({ ...client, attached: 0, tabs: [] })),
      }
    }
    return { ok: true, status }
  }
}

export function mountPreview(): (command: PopupCommand) => PopupResult {
  const mode = new URLSearchParams(location.search).get("sample")
  const banner = document.createElement("p")
  banner.textContent = "Popup preview — sample data only. Actions affect this page only. "
  const label = document.createElement("label")
  label.textContent = "Sample state: "
  const select = document.createElement("select")
  for (const [value, text] of [["observe", "Observe"], ["managed", "Managed"], ["empty", "Empty / disconnected"]] as const) {
    const option = document.createElement("option")
    option.value = value
    option.textContent = text
    select.append(option)
  }
  select.value = mode === "managed" || mode === "empty" ? mode : "observe"
  select.addEventListener("change", () => { location.search = `?sample=${select.value}` })
  label.append(select)
  banner.append(label)
  document.querySelector("main")?.prepend(banner)
  return createPreview(mode)
}
