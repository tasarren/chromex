// Verifies per-agent window isolation against a real Chromium.
// Usage (from packages/mcp): node --import tsx ../../.orchestrator/scripts/verification/window-check.mjs <url>
import { BrowserController } from "../../packages/mcp/src/mcp/browser-controller.ts";

const url = process.argv[2];
if (!url) throw new Error("Pass the test page URL");

const results = [];
const check = (name, pass, detail = "") =>
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);

const first = new BrowserController();
const second = new BrowserController();
await first.initialize();
await second.initialize();

const windowOf = async (c) => (await c.status()).windowId;
const tabIds = async (c) => (await c.tabs()).map((t) => t.id);

try {
  const before = await tabIds(first);

  // 1. Two clients get two different windows.
  const tabA = await first.open(url);
  const tabB = await second.open(url);
  const winA = await windowOf(first);
  const winB = await windowOf(second);
  check("each client gets its own window", winA !== winB, `${winA} vs ${winB}`);
  check("tabs land in their client's window", tabA.windowId === winA && tabB.windowId === winB);

  // 2. A second open reuses the tab rather than stranding one.
  const reused = await first.open(`${url}?second=1`);
  check("open reuses the existing tab", reused.id === tabA.id, `${tabA.id} -> ${reused.id}`);
  check("reused tab stayed in its window", (await windowOf(first)) === winA);

  // 3. Releasing closes the agent's own tab.
  await first.release();
  await new Promise((r) => setTimeout(r, 300));
  check("release closed the agent's tab", !(await tabIds(second)).includes(tabA.id));
  check("the other client is unaffected", (await tabIds(second)).includes(tabB.id));

  // 4. A claimed tab is never closed. Only http(s) tabs are claimable at all.
  const userTab = (await second.tabs()).find(
    (t) => before.includes(t.id) && /^https?:/.test(t.url),
  );
  if (userTab) {
    await first.useTab(userTab.id);
    await first.release();
    await new Promise((r) => setTimeout(r, 300));
    check("a claimed user tab stays open", (await tabIds(second)).includes(userTab.id));
  } else {
    check("a claimed user tab stays open", false, "no pre-existing tab to claim");
  }

  // 5. Closing the client removes its window.
  const windowsBefore = new Set((await second.tabs()).map((t) => t.windowId));
  await second.close();
  await new Promise((r) => setTimeout(r, 500));
  const windowsAfter = new Set((await first.tabs()).map((t) => t.windowId));
  check("closing the client removed its window", windowsBefore.has(winB) && !windowsAfter.has(winB));
} finally {
  console.log("\n=== RESULTS ===");
  for (const line of results) console.log(line);
  console.log(`${results.filter((r) => r.startsWith("PASS")).length}/${results.length} passed`);
  await first.close().catch(() => {});
  await second.close().catch(() => {});
}
