import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { errorMessage } from "../protocol/schema.js";
import { BrowserController } from "./browser-controller.js";

const controller = new BrowserController();
await controller.initialize();
const server = new McpServer(
  { name: "chrome-browser-bridge", version: "0.1.0" },
  {
    instructions:
      "Control Chromium through a local, exact-origin-gated bridge. List tabs, allow non-local origins, select or open a tab, snapshot, then interact through refs.",
  },
);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };

server.registerTool(
  "chrome_status",
  {
    description: "Check the bridge connection, selected tab, and allowed origins.",
    inputSchema: {},
    annotations: readOnly,
  },
  async () => json(await controller.status()),
);
server.registerTool(
  "chrome_tabs",
  {
    description: "List tabs; disallowed titles and URLs are redacted.",
    inputSchema: {},
    annotations: readOnly,
  },
  async () => json(await controller.tabs()),
);
server.registerTool(
  "chrome_allow_origin",
  {
    description: "Allow one exact HTTP(S) origin.",
    inputSchema: { origin: z.string(), persist: z.boolean().default(false) },
    annotations: write,
  },
  async ({ origin, persist }) =>
    json({ allowed: await controller.policy.allow(origin, persist), persist }),
);
server.registerTool(
  "chrome_revoke_origin",
  {
    description: "Remove an origin from session and persistent allowlists.",
    inputSchema: { origin: z.string() },
    annotations: write,
  },
  async ({ origin }) => json({ revoked: await controller.policy.revoke(origin) }),
);
server.registerTool(
  "chrome_use_tab",
  {
    description: "Claim and attach to an existing allowed tab.",
    inputSchema: { tabId: z.number().int().nonnegative() },
    annotations: write,
  },
  async ({ tabId }) => json(await controller.useTab(tabId)),
);
server.registerTool(
  "chrome_open",
  {
    description: "Open and control a new tab at an allowed URL.",
    inputSchema: { url: z.string().url() },
    annotations: write,
  },
  async ({ url }) => json(await controller.open(url)),
);
server.registerTool(
  "chrome_navigate",
  {
    description: "Navigate to an allowed URL; disallowed redirects are rejected.",
    inputSchema: { url: z.string().url() },
    annotations: write,
  },
  async ({ url }) => json(await controller.navigate(url)),
);
server.registerTool(
  "chrome_snapshot",
  {
    description: "Get an accessibility snapshot with element refs.",
    inputSchema: {},
    annotations: readOnly,
  },
  async () => text((await controller.snapshot()).text),
);
server.registerTool(
  "chrome_screenshot",
  { description: "Capture the visible viewport as PNG.", inputSchema: {}, annotations: readOnly },
  async () => {
    const shot = await controller.screenshot();
    return { content: [{ type: "image" as const, data: shot.data, mimeType: shot.mimeType }] };
  },
);
server.registerTool(
  "chrome_click",
  {
    description: "Click an element ref from the latest snapshot.",
    inputSchema: { ref: z.string() },
    annotations: write,
  },
  async ({ ref }) => run(() => controller.click(ref)),
);
server.registerTool(
  "chrome_type",
  {
    description: "Focus an element ref and insert text.",
    inputSchema: { ref: z.string(), text: z.string(), clear: z.boolean().default(true) },
    annotations: write,
  },
  async ({ ref, text: value, clear }) => run(() => controller.type(ref, value, clear)),
);
server.registerTool(
  "chrome_press",
  {
    description: "Press a key such as Enter, Tab, or Escape.",
    inputSchema: { key: z.string().min(1) },
    annotations: write,
  },
  async ({ key }) => run(() => controller.press(key)),
);
server.registerTool(
  "chrome_wait",
  {
    description: "Wait for page load or visible body text.",
    inputSchema: {
      text: z.string().optional(),
      timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
    },
    annotations: readOnly,
  },
  async ({ text: value, timeoutMs }) =>
    run(() => controller.wait({ ...(value === undefined ? {} : { text: value }), timeoutMs })),
);
server.registerTool(
  "chrome_release",
  {
    description: "Detach and release the tab without closing it.",
    inputSchema: {},
    annotations: write,
  },
  async () => run(() => controller.release()),
);

await server.connect(new StdioServerTransport());
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void controller.close().finally(() => process.exit(0)));

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}
function json(value: unknown) {
  return text(JSON.stringify(value, null, 2));
}
async function run(action: () => Promise<unknown>) {
  try {
    await action();
    return text("ok");
  } catch (cause) {
    return { ...text(errorMessage(cause)), isError: true };
  }
}
