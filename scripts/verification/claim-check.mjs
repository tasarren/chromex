// Verifies that claiming a tab the user owns never closes or moves it.
import { BrowserController } from "../../packages/mcp/src/mcp/browser-controller.ts";

const url = process.argv[2] ?? "http://127.0.0.1:8899/test-page.html";
const results = [];
const check = (name, pass, detail = "") =>
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);

// "owner" opens the tab, then releases the lease so it becomes an ordinary user tab —
// a real user tab has no lease, and the lease system rightly blocks stealing a held one.
const owner = new BrowserController();
const claimer = new BrowserController();
await owner.initialize();
await claimer.initialize();

try {
  const userTab = await owner.open(url);
  const userWindow = (await owner.status()).windowId;
  await owner.broker.request("tabs.release", { tabId: userTab.id });

  await claimer.useTab(userTab.id);
  const claimerWindow = (await claimer.status()).windowId;
  const afterClaim = (await claimer.tabs()).find((t) => t.id === userTab.id);
  check("claimed tab stays in its original window", afterClaim?.windowId === userTab.windowId);
  check("claiming does not create a window for the claimer", claimerWindow === null, `got ${claimerWindow}`);

  await claimer.release();
  await new Promise((r) => setTimeout(r, 300));
  const afterRelease = (await owner.tabs()).find((t) => t.id === userTab.id);
  check("released claimed tab is still open", afterRelease !== undefined);
  check("released claimed tab kept its url", afterRelease?.url.startsWith("http"), afterRelease?.url);

  check("owner window survived the claim cycle", (await owner.status()).windowId === userWindow);
} finally {
  console.log("\n=== RESULTS ===");
  for (const line of results) console.log(line);
  console.log(`${results.filter((r) => r.startsWith("PASS")).length}/${results.length} passed`);
  await claimer.close().catch(() => {});
  await owner.close().catch(() => {});
}
