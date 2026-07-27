import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorMessage } from "../protocol/schema.js";
import { SessionBrowser } from "./session-browser.js";

const server = new McpServer(
  { name: "chrome-browser-bridge", version: "0.1.0" },
  {
    instructions:
      "Use the chrome-browser skill and chrome_help. Managed Chromium is default; chrome_status returns browserId for reuse. Loopback needs no origin grant. Open a URL, snapshot, then interact through refs. Navigation failures require chrome_network and a reachable server, not more origin grants. Observe requires user popup consent.",
  },
);
const session = new SessionBrowser(() => server.server.listRoots());
await session.initialize();
type RegisteredTool = {
  annotations?: ToolAnnotations;
  description?: string;
  enabled?: boolean;
  inputSchema?: { shape: Record<string, unknown> };
};

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
const browserOptions = {
  browserId: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,180}$/)
    .optional(),
  profile: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .optional(),
  project: z.string().optional(),
  temporary: z.boolean().optional(),
};
const connectionOptions = { ...browserOptions, observe: z.boolean().optional() };

server.registerTool(
  "chrome_status",
  {
    description:
      "Connect to shared Managed Chromium by default; report browserId, selected tab, and allowed origins. Use observe:true for popup-enabled user tabs.",
    inputSchema: connectionOptions,
    annotations: write,
  },
  async (options) => json(await session.status(options)),
);
server.registerTool(
  "chrome_tabs",
  {
    description:
      "Connect to shared Managed Chromium and list tabs with lease state; disallowed titles and URLs are redacted. Observe lists only popup-enabled tabs.",
    inputSchema: connectionOptions,
    annotations: write,
  },
  async (options) => json(await session.tabs(options)),
);
server.registerTool(
  "chrome_allow_origin",
  {
    description: "Allow one exact HTTP(S) origin.",
    inputSchema: { origin: z.string(), persist: z.boolean().default(false) },
    annotations: write,
  },
  async ({ origin, persist }) =>
    json({ allowed: await session.policy.allow(origin, persist), persist }),
);
server.registerTool(
  "chrome_revoke_origin",
  {
    description: "Remove an origin from session and persistent allowlists.",
    inputSchema: { origin: z.string() },
    annotations: write,
  },
  async ({ origin }) => json({ revoked: await session.policy.revoke(origin) }),
);
server.registerTool(
  "chrome_use_tab",
  {
    description:
      "Claim an unleased allowed tab. For handoff, pass browserId and tabId from the releasing agent. Observe requires popup consent.",
    inputSchema: { ...connectionOptions, tabId: z.number().int().nonnegative() },
    annotations: write,
  },
  async ({ tabId, ...options }) => json(await session.useTab(tabId, options)),
);
server.registerTool(
  "chrome_open",
  {
    description:
      "Open a URL in shared Managed Chromium, reusing this client's selected tab. Project/profile selects a shared persistent browser; browserId joins an existing browser.",
    inputSchema: {
      url: z.string().url(),
      ...browserOptions,
    },
    annotations: write,
  },
  async ({ url, ...options }) => json(await session.open(url, options)),
);
server.registerTool(
  "chrome_process_output",
  {
    description:
      "Read bounded stdout/stderr diagnostics from the latest Managed Chromium launch. Omit cursor for the newest page; pass olderCursor to page backward.",
    inputSchema: {
      stream: z.enum(["all", "stdout", "stderr"]).default("all"),
      cursor: z.number().int().positive().optional(),
      maxChars: z.number().int().min(500).max(100_000).default(20_000),
    },
    annotations: readOnly,
  },
  async ({ stream, cursor, maxChars }) =>
    json(
      await session.processOutput({
        stream,
        maxChars,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    ),
);
server.registerTool(
  "chrome_navigate",
  {
    description:
      "Navigate to an allowed URL, or move through history with action back/forward/reload. Disallowed redirects are rejected.",
    inputSchema: {
      url: z.string().url().optional(),
      action: z.enum(["back", "forward", "reload"]).optional(),
    },
    annotations: write,
  },
  async ({ url, action }) => {
    if (url !== undefined && action === undefined)
      return json(await (await session.controller()).navigate(url));
    if (action !== undefined && url === undefined)
      return json(await (await session.controller()).history(action));
    return { ...text("Provide exactly one of url or action."), isError: true };
  },
);
server.registerTool(
  "chrome_scroll",
  {
    description: "Scroll a ref into view, or scroll the page when no ref is given.",
    inputSchema: {
      ref: z.string().optional(),
      direction: z.enum(["up", "down"]).default("down"),
      amount: z.number().int().min(1).max(10_000).default(600),
    },
    annotations: write,
  },
  async ({ ref, direction, amount }) =>
    run(async () =>
      (await session.controller()).scroll({
        amount,
        direction,
        ...(ref === undefined ? {} : { ref }),
      }),
    ),
);
server.registerTool(
  "chrome_select",
  {
    description: "Choose an option in a <select> by value, label, or visible text.",
    inputSchema: { ref: z.string(), value: z.string() },
    annotations: write,
  },
  async ({ ref, value }) => run(async () => (await session.controller()).select(ref, value)),
);
server.registerTool(
  "chrome_hover",
  {
    description: "Move the pointer over an element ref to reveal hover-only UI.",
    inputSchema: { ref: z.string() },
    annotations: write,
  },
  async ({ ref }) => run(async () => (await session.controller()).hover(ref)),
);
server.registerTool(
  "chrome_snapshot",
  {
    description:
      "Get a hierarchical accessibility snapshot with refs for interactive elements. Use filter 'all' to include decorative nodes.",
    inputSchema: { filter: z.enum(["interactive", "all"]).default("interactive") },
    annotations: readOnly,
  },
  async ({ filter }) => text((await (await session.controller()).snapshot(filter)).text),
);
server.registerTool(
  "chrome_text",
  {
    description: "Read the page's visible text. Use with chrome_snapshot, which carries structure.",
    inputSchema: { maxChars: z.number().int().min(500).max(200_000).default(20_000) },
    annotations: readOnly,
  },
  async ({ maxChars }) => text(await (await session.controller()).text(maxChars)),
);
server.registerTool(
  "chrome_screenshot",
  { description: "Capture the visible viewport as PNG.", inputSchema: {}, annotations: readOnly },
  async () => {
    const shot = await (await session.controller()).screenshot();
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
  async ({ ref }) => run(async () => (await session.controller()).click(ref)),
);
server.registerTool(
  "chrome_type",
  {
    description: "Focus an element ref and insert text.",
    inputSchema: { ref: z.string(), text: z.string(), clear: z.boolean().default(true) },
    annotations: write,
  },
  async ({ ref, text: value, clear }) =>
    run(async () => (await session.controller()).type(ref, value, clear)),
);
server.registerTool(
  "chrome_press",
  {
    description: "Press a key such as Enter, Tab, or Escape.",
    inputSchema: { key: z.string().min(1) },
    annotations: write,
  },
  async ({ key }) => run(async () => (await session.controller()).press(key)),
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
    run(async () =>
      (await session.controller()).wait({
        ...(value === undefined ? {} : { text: value }),
        timeoutMs,
      }),
    ),
);
server.registerTool(
  "chrome_console",
  {
    description:
      "Read console output and uncaught exceptions from the controlled tab, buffered since the last navigation.",
    inputSchema: { level: z.enum(["error", "warn", "all"]).default("all") },
    annotations: readOnly,
  },
  async ({ level }) => json(await (await session.controller()).console(level)),
);
server.registerTool(
  "chrome_network",
  {
    description:
      "Read network activity for the controlled tab. Defaults to failed and non-2xx requests; use 'all' for every request.",
    inputSchema: { status: z.enum(["failed", "all"]).default("failed") },
    annotations: readOnly,
  },
  async ({ status }) => json(await (await session.controller()).network(status)),
);
server.registerTool(
  "chrome_release",
  {
    description: "Detach and release the tab without closing it.",
    inputSchema: {},
    annotations: write,
  },
  async () => run(() => session.release()),
);

server.registerTool(
  "chrome_help",
  {
    description:
      "List every Chromex tool with its purpose and the recommended order to call them in. Start here.",
    inputSchema: {},
    annotations: readOnly,
  },
  async () => text(help()),
);

const transport = new StdioServerTransport();
let shuttingDown: Promise<void> | null = null;
function shutdown(): Promise<void> {
  shuttingDown ??= Promise.allSettled([session.close(), server.close()]).then(() => undefined);
  return shuttingDown;
}
process.stdin.once("end", () => void shutdown());
process.stdin.once("close", () => void shutdown());
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown().finally(() => process.exit(0)));
}
await server.connect(transport);

/** Describe every registered tool, so this can never drift from what is actually registered. */
function help(): string {
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const lines = Object.entries(registered)
    .filter(([, tool]) => tool.enabled !== false)
    .map(([name, tool]) => {
      const params = Object.keys(tool.inputSchema?.shape ?? {});
      const kind = tool.annotations?.readOnlyHint === true ? "read" : "write";
      return `${name}(${params.join(", ")}) [${kind}] — ${tool.description ?? ""}`;
    })
    .sort();
  return [
    "Managed is default: start or join shared Chromium for the project/profile. Agent disconnect leaves its browser and tabs open.",
    "",
    "Typical sequence:",
    "  chrome_status -> chrome_tabs -> chrome_allow_origin (non-loopback, with user approval)",
    "  Managed: chrome_open(project?, profile?, temporary?, browserId?) -> chrome_snapshot -> act/read -> chrome_release",
    "  Handoff: A chrome_release; B chrome_use_tab(browserId, tabId), then fresh chrome_snapshot",
    "  Observe: user enables 'Allow agents on this tab' in popup; chrome_tabs(observe:true) -> chrome_use_tab -> chrome_snapshot",
    "  Managed diagnostics: chrome_process_output(stream?, cursor?, maxChars?)",
    "",
    "Refs come from the most recent chrome_snapshot and expire when the page changes.",
    "When an action does not do what you expected, read chrome_console and chrome_network.",
    "Loopback URLs need no chrome_allow_origin. Navigation failed / net::ERR_* means inspect chrome_network and verify the target server, not grant an internal error-page origin.",
    "Retain managed.browserId from chrome_status, especially with temporary:true; use it to rejoin instead of creating another temporary browser.",
    "",
    "Tools:",
    ...lines.map((line) => `  ${line}`),
  ].join("\n");
}

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
