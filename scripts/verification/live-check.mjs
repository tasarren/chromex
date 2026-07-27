// End-to-end check of the new controller behaviour against a real Chromium tab.
// Usage: node --import tsx .orchestrator/scripts/verification/live-check.mjs <url>
import { BrowserController } from "../../packages/mcp/src/mcp/browser-controller.ts";

const url = process.argv[2];
if (!url) throw new Error("Pass the test page URL");

const results = [];
const check = (name, pass, detail = "") =>
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);

const controller = new BrowserController();
await controller.initialize();

try {
  await controller.open(url);

  // 1. Snapshot is hierarchical, filtered, and has a context header.
  const snap = await controller.snapshot();
  console.log("--- snapshot (interactive) ---\n" + snap.text + "\n");
  const all = await controller.snapshot("all");
  check(
    "snapshot header reports url and scroll",
    /below\)|fully visible\)/.test(snap.text.split("\n")[0]),
  );
  check("snapshot below-fold hint present", snap.text.includes("px below"));
  check(
    "interactive filter is smaller than all",
    snap.text.length < all.text.length,
    `${snap.text.split("\n").length} vs ${all.text.split("\n").length} lines`,
  );

  const refIn = (snapshotText, needle) =>
    snapshotText
      .split("\n")
      .find((line) => line.includes(needle))
      ?.match(/\[(e\d+)\]/)?.[1];

  // 2. chrome_text returns prose.
  const text = await controller.text(20_000);
  check("text returns page prose", text.includes("Chromex verification"));

  // 3. Ctrl+A then type replaces rather than appends.
  const field = refIn(snap.text, "Email");
  await controller.type(field, "", false);
  await controller.press("Ctrl+A");
  await controller.type(field, "replaced@example.com", false);
  const fieldValue = (await controller.snapshot()).text.match(/Email" value="([^"]*)"/)?.[1];
  check(
    "Ctrl+A replaces field contents",
    fieldValue === "replaced@example.com",
    `value=${fieldValue}`,
  );

  // 4. Enter submits the form (needs real code/vkey).
  await controller.press("Enter");
  await new Promise((r) => setTimeout(r, 300));
  const afterEnter = await controller.text(20_000);
  check("Enter submits the form", afterEnter.includes("submitted:replaced@example.com"));

  // 5. select drives a native dropdown.
  const snap2 = await controller.snapshot();
  const picker = snap2.text
    .split("\n")
    .find((l) => l.includes("Pick one"))
    ?.match(/\[(e\d+)\]/)?.[1];
  await controller.select(picker, "Beta");
  check("select fires change", (await controller.text(20_000)).includes("picked: b"));

  // 6. Click below the fold scrolls into view and hits.
  const snap3 = await controller.snapshot();
  const deep = snap3.text
    .split("\n")
    .find((l) => l.includes("Below the fold"))
    ?.match(/\[(e\d+)\]/)?.[1];
  await controller.click(deep);
  await new Promise((r) => setTimeout(r, 200));
  check("click below fold works", (await controller.text(20_000)).includes("CLICKED BELOW FOLD"));

  // 7. Console buffer captured logs, warnings, and the exception.
  const logs = await controller.console("all");
  const errors = await controller.console("error");
  console.log("--- console ---\n" + JSON.stringify(logs, null, 2) + "\n");
  check(
    "console captured page log",
    logs.some((e) => e.text.includes("hello from the page")),
  );
  check(
    "console captured warning",
    logs.some((e) => e.level.includes("warn")),
  );
  check(
    "console captured exception",
    errors.some((e) => e.text.includes("deliberate test exception")),
  );
  check(
    "console entry has source line",
    logs.some((e) => e.source !== undefined),
  );

  // 8. Network buffer shows the 404 and hides 200s by default.
  const failed = await controller.network("failed");
  const every = await controller.network("all");
  console.log("--- network (failed) ---\n" + JSON.stringify(failed, null, 2) + "\n");
  check(
    "network captured the 404",
    failed.some((e) => e.url.includes("missing-endpoint")),
  );
  check(
    "failed filter hides successes",
    failed.length < every.length,
    `${failed.length} of ${every.length}`,
  );

  // 9. History navigation.
  await controller.history("reload");
  check("reload works", (await controller.text(20_000)).includes("not submitted"));

  // 10. Stale ref fails loudly rather than mis-clicking.
  try {
    await controller.click(deep);
    check("stale ref rejected", false, "no error thrown");
  } catch (cause) {
    check(
      "stale ref rejected",
      /no longer on the page|take a new snapshot/.test(cause.message),
      cause.message,
    );
  }
} finally {
  console.log("\n=== RESULTS ===");
  for (const line of results) console.log(line);
  console.log(`${results.filter((r) => r.startsWith("PASS")).length}/${results.length} passed`);
  await controller.close();
}
