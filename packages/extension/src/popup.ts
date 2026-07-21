// biome-ignore lint/suspicious/noExplicitAny: Chromium injects this untyped extension API global.
declare const chrome: any;

type PopupStatus = {
  connected: boolean;
  host: string;
  lastError: string | null;
  leases: number;
};

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing popup element: ${id}`);
  return found;
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

void refresh();
