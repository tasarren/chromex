// Verify that the installed Chromex MCP runtime initializes and exposes the browser tool catalog.
// Usage: node .orchestrator/scripts/verification/installed-mcp-check.mjs
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const serverPath = resolve(homedir(), "plugins/chrome-browser-bridge/dist/mcp-server.mjs");
const expectedTools = [
  "chrome_status",
  "chrome_tabs",
  "chrome_use_tab",
  "chrome_open",
  "chrome_process_output",
  "chrome_snapshot",
  "chrome_click",
  "chrome_type",
  "chrome_release",
];

await access(serverPath);
const transport = new StdioClientTransport({
  args: [serverPath],
  command: process.execPath,
  cwd: process.cwd(),
  env: process.env,
  stderr: "pipe",
});
const stderr = [];
transport.stderr?.on("data", (chunk) => stderr.push(chunk.toString()));
const client = new Client(
  { name: "chromex-installed-verifier", version: "1.0.0" },
  { capabilities: {} },
);

try {
  await client.connect(transport);
  const catalog = await client.listTools();
  const names = new Set(catalog.tools.map((tool) => tool.name));
  const missing = expectedTools.filter((name) => !names.has(name));
  if (missing.length > 0) throw new Error(`Missing installed tools: ${missing.join(", ")}`);
  console.log(`Installed MCP initialized with ${catalog.tools.length} tools`);
  console.log(`Verified core tools: ${expectedTools.join(", ")}`);

  const tabResult = await client.callTool({ arguments: {}, name: "chrome_tabs" });
  const tabText = (tabResult.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (tabResult.isError) throw new Error(tabText || "chrome_tabs failed");
  const tabs = JSON.parse(tabText);
  if (!Array.isArray(tabs)) throw new Error("chrome_tabs did not return an array");
  console.log(`Observe bridge authenticated and returned ${tabs.length} tab(s)`);
} catch (cause) {
  const diagnostics = stderr.join("").trim();
  if (diagnostics) console.error(diagnostics);
  throw cause;
} finally {
  await client.close();
}
