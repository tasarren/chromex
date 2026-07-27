// Verify installed Managed launch diagnostics without starting a real browser.
// Usage: node .orchestrator/scripts/verification/managed-process-output-check.mjs
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const directory = await mkdtemp(join(tmpdir(), "chromex-output-check-"));
const project = join(directory, "project");
const browser = join(directory, "fixture-chromium");
const server = resolve(homedir(), "plugins/chrome-browser-bridge/dist/mcp-server.mjs");
await mkdir(project);
await writeFile(
  browser,
  `#!${process.execPath}
import { readFile } from "node:fs/promises";
process.stdout.write("managed diagnostics stdout fixture\\n");
process.stderr.write(await readFile(process.env.CHROME_BROWSER_BRIDGE_CONFIG, "utf8"));
process.stderr.write("managed diagnostics stderr fixture\\n");
process.exit(23);
`,
);
await chmod(browser, 0o700);

const transport = new StdioClientTransport({
  args: [server],
  command: process.execPath,
  cwd: process.cwd(),
  env: { ...process.env, CHROMEX_BROWSER: browser },
  stderr: "pipe",
});
const stderr = [];
transport.stderr?.on("data", (chunk) => stderr.push(chunk.toString()));
const client = new Client(
  { name: "chromex-managed-output-verifier", version: "1.0.0" },
  { capabilities: {} },
);

try {
  await client.connect(transport);
  const launch = await client.callTool({
    arguments: {
      profile: "diagnostic-fixture",
      project,
      temporary: true,
      url: "about:blank",
    },
    name: "chrome_open",
  });
  const launchText = textContent(launch);
  assert.equal(launch.isError, true);
  assert.match(launchText, /exit code 23/);
  assert.match(launchText, /managed diagnostics stderr fixture/);
  assert.match(launchText, /\[REDACTED\]/);
  assert.doesNotMatch(launchText, /"token":"[a-f0-9]{64}"/);

  const output = await client.callTool({
    arguments: { maxChars: 20_000, stream: "all" },
    name: "chrome_process_output",
  });
  assert.notEqual(output.isError, true, textContent(output));
  const parsed = JSON.parse(textContent(output));
  assert.equal(parsed.process.exitCode, 23);
  assert.equal(parsed.process.state, "failed");
  const retained = parsed.output.entries.map((entry) => entry.text).join("");
  assert.match(retained, /managed diagnostics stdout fixture/);
  assert.match(retained, /managed diagnostics stderr fixture/);
  assert.match(retained, /\[REDACTED\]/);
  assert.doesNotMatch(retained, /"token":"[a-f0-9]{64}"/);
  console.log("Installed Managed diagnostics reported exit 23 and redacted the bridge token");
} catch (cause) {
  const diagnostics = stderr.join("").trim();
  if (diagnostics) console.error(diagnostics);
  throw cause;
} finally {
  await client.close();
  await rm(directory, { force: true, recursive: true });
}

function textContent(result) {
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}
