// Run after pnpm build: node .orchestrator/scripts/verification/reopen-check.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const directory = await mkdtemp("/tmp/opencode/cx-");
const runtime = resolve(process.env.CHROMEX_TEST_RUNTIME ?? "packages/plugin/dist/chrome-browser-bridge/dist/mcp-server.mjs");
const server = createServer((_request, response) => response.end("<!doctype html><title>Reopen check</title><h1>Reopen works</h1><button>Test button</button>"));
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const client = new Client({ name: "chromex-reopen-check", version: "1" }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath, args: [runtime],
  env: { ...process.env, XDG_RUNTIME_DIR: directory, XDG_DATA_HOME: directory },
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", chunk => { stderr += chunk; });
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.filter(item => item.type === "text").map(item => item.text).join("\n");
  assert.equal(result.isError, undefined, `${name}: ${text}\n${stderr}`);
  return text;
}
async function json(name, args) { return JSON.parse(await call(name, args)); }
try {
  await client.connect(transport);
  const first = await json("chrome_open", { url, project: directory, profile: "reopen" });
  assert.match(await call("chrome_snapshot"), /Reopen works/);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await call("chrome_release");
    const started = Date.now();
    const reopened = await json("chrome_open", { url });
    assert.equal(reopened.id, first.id);
    assert.ok(Date.now() - started < 5_000, "same-URL reopen stalled");
  }
  await call("chrome_release");
  const before = await json("chrome_status");
  const diagnostics = await json("chrome_process_output", { maxChars: 500 });
  // Only terminate this verifier's own dedicated browser to model external browser closure.
  process.kill(diagnostics.process.pid, "SIGTERM");
  let exited = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const output = await json("chrome_process_output", { maxChars: 500 });
    if (output.process.state === "exited") { exited = true; break; }
    await delay(50);
  }
  assert.ok(exited, "test browser did not exit");
  const stopped = await json("chrome_status");
  assert.equal(stopped.managed.exited, true);
  await json("chrome_open", { url, project: directory, profile: "reopen" });
  const after = await json("chrome_status");
  assert.equal(after.mode, "managed");
  assert.notEqual(after.socketPath, before.socketPath);
  assert.match(await call("chrome_text"), /Reopen works/);
  assert.match(await call("chrome_snapshot"), /Test button/);
  const screenshot = await client.callTool({ name: "chrome_screenshot", arguments: {} });
  assert.ok(screenshot.content?.some(item => item.type === "image" && item.data.length > 100));
  console.log("PASS: three release/reopen cycles, same-URL latency, exited status, same-profile relaunch, text/snapshot/screenshot");
} finally {
  await client.close();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { force: true, recursive: true });
}
