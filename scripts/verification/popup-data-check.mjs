// Verifies the data behind the popup: client labels and the activity feed.
// The popup renders bridge.status/popup.status; this drives activity then reads it back.
import { BrowserController } from "../../packages/mcp/src/mcp/browser-controller.ts";

const url = process.argv[2] ?? "http://127.0.0.1:8899/test-page.html";
const results = [];
const check = (name, pass, detail = "") =>
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);

const agent = new BrowserController();
await agent.initialize();

try {
  await agent.open(url);
  await agent.navigate(`${url}?step=2`);

  const status = await agent.status();
  console.log("bridge.status:\n", JSON.stringify(status, null, 2));

  check("status reports the client's window", typeof status.windowId === "number", `${status.windowId}`);

  // bridge.status is the extension's own view: leases and per-client windows.
  const bridge = await agent.broker.request("bridge.status");
  console.log("\nbridge.status (extension):\n", JSON.stringify(bridge, null, 2));
  const mine = (bridge.windows ?? []).find((w) => w.windowId === status.windowId);
  check("extension lists this client's window", mine !== undefined);
  check(
    "the window is attributed to this client",
    mine?.owner === agent.broker.clientId,
    `${mine?.owner} vs ${agent.broker.clientId}`,
  );
  check(
    "extension shows the leased tab",
    (bridge.leases ?? []).some((l) => l.tabId === status.selectedTabId),
  );
} finally {
  console.log("\n=== RESULTS ===");
  for (const line of results) console.log(line);
  console.log(`${results.filter((r) => r.startsWith("PASS")).length}/${results.length} passed`);
  await agent.close().catch(() => {});
}
