import { writeFile } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { errorMessage, formatPointerState, formatScreenshotLine } from "@chromex/protocol"
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { connectionOptions, type SessionBrowser, sessionOptions } from "./session-browser.ts"

type ToolConfig<Shape extends z.ZodRawShape> = {
  description: string;
  /** A raw shape or a strict object; the MCP SDK accepts both at runtime. */
  inputSchema: Shape | z.ZodObject;
  annotations: ToolAnnotations;
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
/** Pointer fields, shared so the mouse routes cannot drift apart. */
const targetFields = { ref: z.string().optional(), x: z.number().optional(), y: z.number().optional() }
const buttonField = { button: z.enum(["left", "right"]).default("left") }
const downFields = { ...targetFields, ...buttonField }
const clickFields = { ...downFields, count: z.union([z.literal(1), z.literal(2)]).default(1) }

type Controller = Awaited<ReturnType<SessionBrowser["controller"]>>

/** Register every Chromex tool. chrome_help describes the same registrations, so it cannot drift. */
export function registerTools(server: McpServer, session: SessionBrowser): void {
  /**
   * Run one mouse step and answer the pointer state line, plus the executor's warning when the step
   * was not confirmed. Managed and Observe (on a popup-granted tab) behave the same.
   */
  async function pointer(action: (controller: Controller) => Promise<string | null | void>) {
    let controller: Controller | undefined
    const line = async() => controller ? formatPointerState(await controller.pointerState()) : null
    try {
      controller = await session.controller()
      const warning = (await action(controller)) ?? null
      return text([await line(), warning].filter((part) => part !== null).join("\n"))
    } catch(cause) {
      // A refused step still says where the pointer is, when the page can be read.
      const state = await line().catch(() => null)
      return { ...text([errorMessage(cause), state].filter((part) => part !== null).join("\n")), isError: true }
    }
  }
  const registered: { name: string; config: ToolConfig<z.ZodRawShape> }[] = []
  function tool<Shape extends z.ZodRawShape>(
    name: string,
    config: ToolConfig<Shape>,
    handler: ToolCallback<Shape>,
  ): void {
    // The SDK runtime accepts a strict Zod object as well as a raw shape; its declaration only names the shape.
    server.registerTool(name, { ...config, inputSchema: config.inputSchema as Shape }, handler)
    registered.push({ name, config })
  }

  tool(
    "chrome_status",
    {
      description:
        "Connect to this workspace's Managed browser, or to Observe tabs with observe:true, and report browserId, workspace, selected tab and pointer state.",
      inputSchema: connectionOptions,
      annotations: write,
    },
    async(options) => {
      const result = await session.status(options)
      // The same pointer state line the mouse verbs answer, for the selected tab.
      const state = await session.controller()
        .then(async(controller) => formatPointerState(await controller.pointerState()))
        .catch((cause: unknown) => `none: ${errorMessage(cause)}`)
      return json({ ...result, pointer: state })
    },
  )
  tool(
    "chrome_tabs",
    {
      description:
        "List tabs with lease state; Observe lists only popup-enabled tabs.",
      inputSchema: connectionOptions,
      annotations: write,
    },
    async(options) => json(await session.tabs(options)),
  )
  tool(
    "chrome_use_tab",
    {
      description:
        "Claim an unleased tab by tabId, or read a tab another agent controls with inspect:true, joining its browser in this workspace with browserId; Observe requires popup consent.",
      inputSchema: {
        ...connectionOptions,
        tabId: z.number().int().nonnegative(),
        inspect: z.boolean().default(false),
      },
      annotations: write,
    },
    async({ tabId, inspect, ...options }) => json(await session.useTab(tabId, inspect, options)),
  )
  tool(
    "chrome_open",
    {
      description:
        "Open a URL in a Managed browser, reusing this client's selected tab: profile picks a shared persistent browser, temporary:true a separate one deleted on close, browserId an existing one in this workspace.",
      inputSchema: {
        url: z.url(),
        ...sessionOptions,
      },
      annotations: write,
    },
    async({ url, ...options }) => json(await session.open(url, options)),
  )
  tool(
    "chrome_extension_install",
    {
      description:
        "Load an unpacked extension directory (absolute path with manifest.json) into the Managed profile now and at every launch, reloading it when already listed.",
      inputSchema: { path: z.string().min(1), profile: sessionOptions.profile },
      annotations: write,
    },
    async({ path, profile }) =>
      json(await session.extension("extensionInstall", { path }, { profile })),
  )
  tool(
    "chrome_extension_list",
    {
      description:
        "List unpacked extensions loaded in the Managed profile and the directories it loads at launch.",
      inputSchema: { profile: sessionOptions.profile },
      annotations: readOnly,
    },
    async({ profile }) => json(await session.extension("extensionList", {}, { profile })),
  )
  tool(
    "chrome_extension_remove",
    {
      description:
        "Uninstall an unpacked extension by path or id from the Managed profile and its launch list.",
      inputSchema: {
        path: z.string().min(1).optional(),
        id: z.string().min(1).optional(),
        profile: sessionOptions.profile,
      },
      annotations: { ...write, destructiveHint: true },
    },
    async({ path, id, profile }) => {
      if ((path === undefined) === (id === undefined))
        return exactlyOne("path", "id")
      return json(await session.extension("extensionRemove", { id, path }, { profile }))
    },
  )
  tool(
    "chrome_process_output",
    {
      description:
        "Read bounded stdout/stderr from the latest Managed browser launch; omit cursor for the newest page, or pass a result's olderCursor as cursor to page back.",
      inputSchema: {
        stream: z.enum(["all", "stdout", "stderr"]).default("all"),
        cursor: z.number().int().positive().optional(),
        maxChars: z.number().int().min(500).max(100_000).default(20_000),
      },
      annotations: readOnly,
    },
    async({ stream, cursor, maxChars }) =>
      json(
        await session.processOutput({
          stream,
          maxChars,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      ),
  )
  tool(
    "chrome_navigate",
    {
      description:
        "Navigate to a URL (chrome:// pages in Managed only) or move through history with action back, forward or reload.",
      inputSchema: {
        url: z.url().optional(),
        action: z.enum(["back", "forward", "reload"]).optional(),
      },
      annotations: write,
    },
    async({ url, action }) => {
      if (url !== undefined && action === undefined)
        return json(await (await session.controller()).navigate(url))
      if (action !== undefined && url === undefined)
        return json(await (await session.controller()).history(action))
      return exactlyOne("url", "action")
    },
  )
  tool(
    "chrome_scroll",
    {
      description: "Scroll a ref into view, or wheel at an in-viewport {x, y} or at the cursor while no button is held, and answer the pointer state line.",
      inputSchema: {
        ref: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        direction: z.enum(["up", "down"]).default("down"),
        amount: z.number().int().min(1).max(10_000).default(600),
      },
      annotations: write,
    },
    async({ ref, x, y, direction, amount }) =>
      pointer((controller) => controller.scroll({ amount, direction, ref, x, y })),
  )
  tool(
    "chrome_select",
    {
      description: "Choose an option in a <select> ref by value, label or visible text.",
      inputSchema: { ref: z.string(), value: z.string() },
      annotations: write,
    },
    async({ ref, value }) => run(async() => (await session.controller()).select(ref, value)),
  )
  tool(
    "chrome_hover",
    {
      description: "Move the pointer over a ref to reveal hover-only UI and answer the pointer state line.",
      inputSchema: { ref: z.string() },
      annotations: write,
    },
    async({ ref }) => pointer((controller) => controller.hover(ref)),
  )
  tool(
    "chrome_snapshot",
    {
      description:
        "Get an accessibility snapshot with refs for interactive elements; filter 'all' adds decorative nodes.",
      inputSchema: { filter: z.enum(["interactive", "all"]).default("interactive") },
      annotations: readOnly,
    },
    async({ filter }) => text((await (await session.controller()).snapshot(filter)).text),
  )
  tool(
    "chrome_text",
    {
      description:
        "Read the page's visible text; use chrome_snapshot for structure.",
      inputSchema: { maxChars: z.number().int().min(500).max(200_000).default(20_000) },
      annotations: readOnly,
    },
    async({ maxChars }) => text(await (await session.controller()).text(maxChars)),
  )
  tool(
    "chrome_screenshot",
    {
      description:
        "Capture the visible viewport as PNG plus the line png WxH css WxH scale S scroll X,Y cursor X,Y held B, where pixel (px, py) is x = px / scale, y = py / scale unless the line ends in mapping none; clean:true hides the agent cursor and an absolute path saves a new .png file.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .max(4096)
          .refine(
            (value) => isAbsolute(value) && value.endsWith(".png") && !value.includes("\0"),
            "Use an absolute .png path",
          )
          .optional(),
        clean: z.boolean().default(false),
      },
      annotations: write,
    },
    async({ path, clean }) => {
      const shot = await (await session.controller()).screenshot(clean)
      const bytes = Buffer.from(shot.data, "base64")
      if (path) await writeFile(path, bytes, { flag: "wx", mode: 0o600 })
      const png = { height: bytes.readUInt32BE(20), width: bytes.readUInt32BE(16) }
      return {
        content: [
          { type: "image" as const, data: shot.data, mimeType: "image/png" },
          { type: "text" as const, text: formatScreenshotLine(png, shot.state, path ? { bytes: bytes.length, file: path } : undefined) },
        ],
      }
    },
  )
  tool(
    "chrome_viewport",
    {
      description:
        "Set the CSS viewport to width and height (DPR 1), or omit both to read it, and return the actual size and matchesRequested; take a fresh snapshot after resizing.",
      inputSchema: {
        width: z.number().int().min(1).max(4096).optional(),
        height: z.number().int().min(1).max(4096).optional(),
      },
      annotations: write,
    },
    async({ width, height }) => {
      if ((width === undefined) !== (height === undefined))
        return { ...text("Provide both width and height, or neither."), isError: true }
      return json(
        await (await session.controller()).viewport(
          width === undefined || height === undefined ? undefined : { width, height },
        ),
      )
    },
  )
  tool(
    "chrome_measure",
    {
      description:
        "Measure viewport, overflow, focus, CSS boxes and computed styles for snapshot refs or first selector matches, without scrolling or running caller code.",
      inputSchema: {
        refs: z
          .array(z.string().regex(/^e\d+$/))
          .max(20)
          .default([]),
        selectors: z.array(z.string().min(1).max(500)).max(20).default([]),
        styles: z
          .array(
            z
              .string()
              .max(100)
              .regex(/^(?:--[A-Za-z0-9_-]+|[a-z][a-z-]*)$/),
          )
          .max(20)
          .default([]),
      },
      annotations: readOnly,
    },
    async(options) => json(await (await session.controller()).measure(options)),
  )
  tool<typeof clickFields>(
    "chrome_click",
    {
      description:
        "Click one ref or viewport {x, y} with button left or right and count 1 or 2, without bringing the tab to the front, and answer the pointer state line.",
      // Strict: unknown fields are refused, not silently dropped.
      inputSchema: z.object(clickFields).strict(),
      annotations: write,
    },
    async(target) => {
      if (!oneTarget(target)) return exactlyOne("ref", "{x, y}")
      return await pointer((controller) => controller.pointerClick(target, target.count))
    },
  )
  tool<typeof downFields>(
    "chrome_mouse_down",
    {
      description: "Travel to one ref or viewport {x, y} and hold the button, and answer the pointer state line; refuses when one is already held.",
      inputSchema: z.object(downFields).strict(),
      annotations: write,
    },
    async(target) => {
      if (!oneTarget(target)) return exactlyOne("ref", "{x, y}")
      return await pointer((controller) => controller.pointerDown(target))
    },
  )
  tool<typeof targetFields>(
    "chrome_mouse_move",
    {
      description: "Move the agent cursor along an eased path to one ref or viewport {x, y}, dragging while a button is held, and answer the pointer state line.",
      inputSchema: z.object(targetFields).strict(),
      annotations: write,
    },
    async(target) => {
      if (!oneTarget(target)) return exactlyOne("ref", "{x, y}")
      return await pointer((controller) => controller.pointerMove({ ...target, button: "left" }))
    },
  )
  tool(
    "chrome_mouse_up",
    {
      description: "Release the held button at its last confirmed point and answer the pointer state line.",
      inputSchema: z.object({}).strict(),
      annotations: write,
    },
    async() => await pointer((controller) => controller.pointerUp()),
  )
  tool(
    "chrome_mouse_cancel",
    {
      description: "Release any held button at its last point (idle holds release after 120 s) and answer the pointer state line.",
      inputSchema: z.object({}).strict(),
      annotations: write,
    },
    async() => await pointer((controller) => controller.pointerCancel()),
  )
  tool(
    "chrome_type",
    {
      description: "Focus a ref and insert text, replacing its value unless clear:false.",
      inputSchema: { ref: z.string(), text: z.string(), clear: z.boolean().default(true) },
      annotations: write,
    },
    async({ ref, text: value, clear }) =>
      run(async() => (await session.controller()).type(ref, value, clear)),
  )
  tool(
    "chrome_press",
    {
      description: "Press a key such as Enter, Tab, or Escape.",
      inputSchema: { key: z.string().min(1) },
      annotations: write,
    },
    async({ key }) => run(async() => (await session.controller()).press(key)),
  )
  tool(
    "chrome_wait",
    {
      description: "Wait for page load or visible body text.",
      inputSchema: {
        text: z.string().optional(),
        timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
      },
      annotations: readOnly,
    },
    async({ text: value, timeoutMs }) =>
      run(async() =>
        (await session.controller()).wait({
          ...(value === undefined ? {} : { text: value }),
          timeoutMs,
        }),
      ),
  )
  tool(
    "chrome_console",
    {
      description:
        "Read console output and uncaught exceptions from the controlled tab since the last navigation.",
      inputSchema: { level: z.enum(["error", "warn", "all"]).default("all") },
      annotations: readOnly,
    },
    async({ level }) => json(await (await session.controller()).console(level)),
  )
  tool(
    "chrome_network",
    {
      description:
        "Read up to 200 buffered requests for the controlled tab, with 'all' adding successes; navigation, reload, attachment and release clear the buffer.",
      inputSchema: { status: z.enum(["failed", "all"]).default("failed") },
      annotations: readOnly,
    },
    async({ status }) => json(await (await session.controller()).network(status)),
  )
  tool(
    "chrome_release",
    {
      description: "Detach and release the tab without closing it.",
      inputSchema: {},
      annotations: write,
    },
    async() => run(() => session.release()),
  )
  tool(
    "chrome_close_tab",
    {
      description:
        "Close the selected tab this client opened with chrome_open and release its lease; claimed and user tabs are refused.",
      inputSchema: {},
      annotations: { ...write, destructiveHint: true },
    },
    async() => run(async() => (await session.controller()).closeTab()),
  )

  tool(
    "chrome_help",
    {
      description:
        "List every Chromex tool with its purpose and the recommended call order; start here.",
      inputSchema: {},
      annotations: readOnly,
    },
    () => text(help()),
  )

  function help(): string {
    const lines = registered
      .map(({ name, config }) => {
        const params = Object.keys("shape" in config.inputSchema ? config.inputSchema.shape : config.inputSchema)
        const kind = config.annotations.readOnlyHint === true ? "read" : "write"
        return `${name}(${params.join(", ")}) [${kind}] — ${config.description}`
      })
      .sort()
    return [
      "Managed is default: start or join this workspace's Chromium for the profile. Agent disconnect leaves its browser and tabs open.",
      "Workspace comes from --workspace or Claude Code's project; without one, Managed is refused and Observe still works.",
      "Agents in one workspace and profile share its browser. Each tab has at most one controlling agent; others may inspect it read-only. A named profile is a separate persistent browser whose data stays after it closes.",
      "",
      "Typical sequence:",
      "  chrome_status -> chrome_tabs",
      "  Managed: chrome_open(profile?, temporary?, browserId?) -> chrome_snapshot -> act/read -> chrome_release",
      "  Inspect: B chrome_use_tab(tabId, inspect:true, browserId?) -> chrome_snapshot/chrome_measure while A controls it",
      "  Handoff: A chrome_release; B chrome_use_tab(tabId, browserId?), then fresh chrome_snapshot",
      "  Observe: user enables 'Allow agents on this tab' in popup; chrome_tabs(observe:true) -> chrome_use_tab -> chrome_snapshot",
      "  Drag: chrome_mouse_down(ref | x,y) -> chrome_mouse_move(ref | x,y)... -> chrome_mouse_up; chrome_mouse_cancel releases a held button",
      "  Managed diagnostics: chrome_process_output(stream?, cursor?, maxChars?)",
      "",
      "Refs come from the most recent chrome_snapshot and expire when the page changes.",
      "Pointer actions show the agent cursor on the page; it marks only points whose input Chromium confirmed and is absent from snapshot and text.",
      "Mouse results and chrome_status pointer are one line: cursor <x>,<y>|none held left|right|none viewport <w>x<h> scroll <x>,<y> (CSS pixels of the viewport).",
      "When an action does not do what you expected, read chrome_console and chrome_network.",
      "Navigation failed / net::ERR_* means inspect chrome_network and verify the target server is reachable.",
      "Retain managed.browserId from chrome_status, especially with temporary:true; use it to rejoin instead of creating another temporary browser. browserId works only in its own workspace.",
      "Any URL opens, including LAN hosts, file:// and chrome:// pages (Managed only; chrome:// pages have no console/network). Use temporary or a dedicated profile for untrusted sites.",
      "Unpacked extensions: chrome_extension_install/list/remove act on the whole profile for every agent in it; a profile argument switches this session to that profile.",
      "Inspect (chrome_use_tab inspect:true) allows snapshot, text, screenshot, measure, viewport without size, wait, console and network; control is refused.",
      "Commands without a described result answer ok, or the error text on refusal.",
      "",
      `Tools (${lines.length}):`,
      ...lines.map((line) => `  ${line}`),
    ].join("\n")
  }
}

function oneTarget(value: { ref?: string | undefined; x?: number | undefined; y?: number | undefined }): boolean {
  const hasRef = value.ref !== undefined
  const hasPoint = value.x !== undefined || value.y !== undefined
  return hasRef !== hasPoint && (!hasPoint || (value.x !== undefined && value.y !== undefined))
}

function exactlyOne(a: string, b: string) {
  return { ...text(`Provide exactly one of ${a} or ${b}.`), isError: true }
}
function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] }
}
function json(value: unknown) {
  return text(JSON.stringify(value, null, 2))
}
async function run(action: () => Promise<unknown>) {
  try {
    await action()
    return text("ok")
  } catch(cause) {
    return { ...text(errorMessage(cause)), isError: true }
  }
}
