import {
  errorMessage,
  type InputOperation,
  type InspectRequest,
  type PointerState,
  runInspection,
  type TabInfo,
} from "@chromex/protocol"
import { z } from "zod"
import { BrokerStatusSchema, TabInfoSchema } from "../shared/schema.ts"
import { BrokerClient } from "../shared/broker-client.ts"
import { type ConsoleEntry, type NetworkEntry, PageActivity } from "./buffers.ts"
import { parseChord } from "./keys.ts"
import { AxNodeSchema, PageContextSchema, renderSnapshot } from "./snapshot.ts"

/** The part of BrokerClient the controller needs, so tests can supply a fake. */
export type Broker = Pick<BrokerClient, "close" | "onNotification" | "request">
/**
 * The Managed browser pipe: one page command or one input operation the service runs to completion
 * after the extension admits the reservation identified by `token`.
 */
export type PointerTargetInput = {
  button: "left" | "right";
  ref?: string | undefined;
  x?: number | undefined;
  y?: number | undefined;
}

export type PagePipe = {
  bind(tabId: number, targetId: string): Promise<void>
  cdp(token: string): Promise<unknown>
  /** Run one admitted gesture step as the bound pipe executor. */
  gesture(token: string): Promise<unknown>
  input(token: string): Promise<unknown>
  /** One fixed read of a pipe-driven tab another client controls. */
  inspect(token: string): Promise<unknown>
  /** Remove the agent cursor from a pipe-driven tab before release (ISS-07). */
  release(tabId: number): Promise<void>
}

/** Pages Chromium keeps from extension debuggers. */
const INTERNAL_URL = /^chrome(?:-untrusted|-extension)?:/iu
const INTERNAL_ATTACH_ERROR = /Cannot access a chrome(?:-untrusted|-extension)?:\/\//u

const WindowSchema = z.object({
  tabId: z.number().int().optional(),
  windowId: z.number().int(),
})

// A profile fence has no tab, so an orphaned one reports `tabId: null`.
const OrphanedInputSchema = z.object({ kind: z.string(), tabId: z.number().int().nullable(), token: z.string() })
const ClientStatusSchema = z.object({
  leases: z.array(z.object({ attached: z.boolean(), tabId: z.number().int() })),
  orphanedInput: OrphanedInputSchema.nullable().optional(),
  recoveryError: z.string().nullable().optional(),
  windowId: z.number().int().nullable(),
})

const HistorySchema = z.object({
  currentIndex: z.number().int(),
  entries: z.array(z.object({ id: z.number().int(), url: z.string() })),
})

const AxTreeSchema = z.object({ nodes: z.array(AxNodeSchema) })

/** Native host answer to `broker.status`. */
/** Broker notification envelope; each method reads only the fields it needs. */
const NotificationSchema = z.object({
  method: z.string().optional(),
  params: z.unknown().optional(),
  tabId: z.number().optional(),
})

/** What the fixed element-facts read returns; `null` when the node is gone. */
const ElementFactsSchema = z
  .object({
    tag: z.string(),
    id: z.string(),
    role: z.string().nullable(),
    label: z.string(),
    focused: z.boolean(),
    focusVisible: z.boolean(),
    rect: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
      top: z.number(),
      right: z.number(),
      bottom: z.number(),
      left: z.number(),
    }),
    styles: z.record(z.string(), z.string()),
  })
  .nullable()

const EvaluatedSchema = z.object({ result: z.object({ value: z.unknown().optional() }) })
const UrlReadSchema = z.object({
  frameTree: z.object({ frameTree: z.object({ frame: z.object({ unreachableUrl: z.string().optional() }) }) }).nullable(),
  href: z.object({ result: z.object({ value: z.string() }) }),
})
const SnapshotReadSchema = z.object({ context: EvaluatedSchema, tree: AxTreeSchema })
const MeasureReadSchema = z.object({
  nodes: z.array(EvaluatedSchema),
  page: EvaluatedSchema.extend({ exceptionDetails: z.unknown().optional() }),
})

/** What the measurement expression in `measure` returns. */
const PageMeasurementSchema = z.object({
  viewport: z.object({
    width: z.number(),
    height: z.number(),
    devicePixelRatio: z.number(),
    visual: z.object({ width: z.number(), height: z.number(), scale: z.number() }).nullable(),
  }),
  document: z.object({
    clientWidth: z.number(),
    clientHeight: z.number(),
    scrollWidth: z.number(),
    scrollHeight: z.number(),
    scrollX: z.number(),
    scrollY: z.number(),
    overflowX: z.boolean(),
    overflowY: z.boolean(),
  }),
  focus: ElementFactsSchema,
  elements: z.array(z.object({ selector: z.string(), element: ElementFactsSchema })),
})

/** The authority's `gesture.status` answer for this client. */
const GestureStatusSchema = z.object({
  context: z.object({ contextId: z.string(), nextSequence: z.number().int().positive() }).nullish(),
  gesture: z.object({ gestureId: z.string(), phase: z.string(), warning: z.string().nullable() }).loose().nullable(),
  held: z.enum(["left", "right"]).nullable(),
  reserved: z.boolean(),
})
/** A service executor's answer: the authority's receipt (absent when refused) and its warning. */
const StepAnswerSchema = z.object({
  receipt: z.object({ outcome: z.string() }).loose().nullish(),
  warning: z.unknown(),
}).loose()
const PointSchema = z.object({ x: z.number(), y: z.number() })
/** A screenshot inspection: the PNG and the page geometry read in the same call. */
const ScreenshotSchema = z.object({
  data: z.string(),
  page: z.object({ cursor: PointSchema.nullable(), height: z.number(), scrollX: z.number(), scrollY: z.number(), width: z.number() }),
})

export class BrowserController {
  readonly activity = new PageActivity()
  readonly broker: Broker
  /** Managed windows are shared, so a new client may adopt the one already open. */
  private readonly adoptExistingWindow: boolean
  /** Managed only: drives internal pages that refuse `chrome.debugger`. */
  private readonly pagePipe: PagePipe | undefined
  /** Retain detached owned tabs for debugger recovery until explicitly released. */
  private ownsTab = false
  private parkedTabId: number | null = null
  /** A tab another client controls that this client only reads; never set with `selectedTabId`. */
  private inspectedTabId: number | null = null
  /** Set while the selected tab runs over the browser pipe instead of the extension debugger. */
  private pipeTarget: string | null = null
  private refs = new Map<string, number>()
  /** This client's last mouse down left a button held that no up or cancel ended yet. */
  private holding = false
  private selectedTabId: number | null = null
  private windowId: number | null = null

  constructor(broker: Broker = new BrokerClient(), adoptExistingWindow = false, pagePipe?: PagePipe) {
    this.broker = broker
    this.adoptExistingWindow = adoptExistingWindow
    this.pagePipe = pagePipe
    broker.onNotification((method, params) => { this.onNotification(method, params) })
  }

  async status() {
    const [broker, client] = await Promise.all([
      this.broker.request("broker.status").then((value) => BrokerStatusSchema.parse(value)),
      this.broker.request("client.status").then((value) => ClientStatusSchema.parse(value)),
    ])
    this.reconcileStatus(client)
    return {
      ...broker,
      // A fenced admission keeps mutating requests held; status stays actionable for a restart.
      inspectedTabId: this.inspectedTabId,
      orphanedInput: client.orphanedInput ?? null,
      parkedTabId: this.parkedTabId,
      recoveryError: client.recoveryError ?? null,
      selectedTabId: this.selectedTabId,
      windowId: client.windowId,
    }
  }

  async tabs(): Promise<TabInfo[]> {
    return z.array(TabInfoSchema).parse(await this.broker.request("tabs.list"))
  }

  async useTab(tabId: number): Promise<TabInfo> {
    await this.release()
    const tab = TabInfoSchema.parse(await this.broker.request("tabs.claim", { tabId }))
    try {
      await this.attach(tabId)
    } catch(cause) {
      await this.broker.request("tabs.release", { tabId })
      throw cause
    }
    // The user owned this tab first, so releasing it must leave it open.
    this.ownsTab = false
    return tab
  }

  /**
   * Read a tab another client controls, without a lease: snapshots, text, screenshots, measurements,
   * waits and the console/network events seen since now. Control tools stay refused for it.
   */
  async inspectTab(tabId: number): Promise<TabInfo> {
    await this.release()
    const tab = TabInfoSchema.parse(await this.broker.request("tabs.inspect", { tabId }))
    this.inspectedTabId = tabId
    this.refs.clear()
    this.activity.clear()
    return tab
  }

  /** Open a URL, reusing this client's tab when it already has one. */
  async open(url: string): Promise<TabInfo> {
    if (this.inspectedTabId !== null) await this.release()
    if (this.selectedTabId !== null || this.parkedTabId !== null) {
      this.reconcileStatus(ClientStatusSchema.parse(await this.broker.request("client.status")))
    }
    if (this.selectedTabId !== null) {
      await this.navigate(url)
      // Claiming a tab this client already leases is idempotent and returns its current info.
      return TabInfoSchema.parse(
        await this.broker.request("tabs.claim", { tabId: this.selectedTabId }),
      )
    }
    if (this.parkedTabId !== null) {
      const tabId = this.parkedTabId
      await this.broker.request("tabs.claim", { tabId })
      await this.attach(tabId)
      this.parkedTabId = null
      this.ownsTab = true
      await this.navigate(url)
      return TabInfoSchema.parse(await this.broker.request("tabs.claim", { tabId }))
    }
    const { tabId, windowId } = WindowSchema.parse(
      await this.broker.request("window.ensure", { adoptExisting: this.adoptExistingWindow }),
    )
    this.windowId = windowId
    // A new window already contains a blank tab; adopt it rather than stranding it.
    const tab =
      tabId === undefined
        ? TabInfoSchema.parse(await this.broker.request("tabs.create", { windowId }))
        : TabInfoSchema.parse(await this.broker.request("tabs.claim", { tabId }))
    await this.attach(tab.id)
    this.ownsTab = true
    await this.navigate(url)
    return TabInfoSchema.parse(await this.broker.request("tabs.claim", { tabId: tab.id }))
  }

  async navigate(url: string): Promise<{ url: string }> {
    const tabId = this.requireTab()
    const internal = INTERNAL_URL.test(url)
    // Chrome accepts top-frame data: navigation on a plain CDP pipe, but aborts it through an
    // extension debugger. Route data URLs like internal pages: detach, navigate over the pipe,
    // then return to the extension debugger when the next navigation is a web page.
    const pipeRoute = internal || url.startsWith("data:")
    // The extension debugger detaches when its tab enters an internal page; hand over first.
    if (pipeRoute && this.pagePipe && this.pipeTarget === null) {
      await this.broker.request("cdp.detach", { tabId })
      this.pipeTarget = await this.targetOf(tabId)
      await this.bindPipe(tabId, this.pipeTarget)
    }
    const previous = await this.currentUrl().catch(() => "")
    this.activity.clear()
    this.refs.clear()
    const result = z
      .object({ errorText: z.string().optional() })
      .parse(await this.cdp("Page.navigate", { url }))
    if (result.errorText) throw new Error(`Navigation failed for ${url}: ${result.errorText}`)
    if (!internal && this.pipeTarget !== null) {
      // The pipe loses the old internal document on commit, so read the browser tab instead.
      await this.waitForTabUrl(
        tabId,
        (current) => current !== previous && !INTERNAL_URL.test(current),
        30_000,
      )
      // A web page, including a data: page, returns to the extension debugger only after the new
      // document commits. Attaching while the internal page unloads races Chrome's detach.
      await this.attach(tabId)
    } else if (url !== previous) {
      // The old document can still report readyState 'complete', so wait for the URL to turn over
      // before trusting the load state.
      await this.waitForUrlChange(previous, 30_000)
    }
    await this.wait({ state: "load", timeoutMs: 30_000 })
    const current = await this.currentUrl()
    this.refs.clear()
    return { url: current }
  }

  /**
   * Move through session history or reload.
   * ponytail: history into an internal page from an extension-attached tab detaches and parks it;
   * chrome_open the internal URL instead. Add a pre-check of the target entry if this gets used.
   */
  async history(action: "back" | "forward" | "reload"): Promise<{ url: string }> {
    this.requireTab()
    const previous = await this.currentUrl()
    this.activity.clear()
    this.refs.clear()
    if (action === "reload") await this.cdp("Page.reload")
    else {
      const history = HistorySchema.parse(await this.cdp("Page.getNavigationHistory"))
      const target = history.entries[history.currentIndex + (action === "back" ? -1 : 1)]
      if (!target) throw new Error(`No ${action} entry in this tab's history`)
      await this.cdp("Page.navigateToHistoryEntry", { entryId: target.id })
      await this.waitForUrlChange(previous, 30_000)
    }
    await this.wait({ state: "load", timeoutMs: 30_000 })
    const current = await this.currentUrl()
    return { url: current }
  }

  async scroll(options: {
    amount: number;
    direction: "up" | "down";
    ref?: string | undefined;
    x?: number | undefined;
    y?: number | undefined;
  }): Promise<string | null> {
    await this.currentUrl()
    if (options.ref !== undefined) {
      if (options.x !== undefined || options.y !== undefined) throw new Error("Provide exactly one of ref or {x, y}.")
      await this.centerOf(this.requireRef(options.ref), options.ref)
      return null
    }
    if ((options.x === undefined) !== (options.y === undefined)) throw new Error("Provide both x and y.")
    const state = await this.pointerState()
    // A move while held would drag, so a held button refuses the scroll.
    if (state.held) throw new Error("Release the held button before scrolling")
    let warning: string | null = null
    let point: { x: number; y: number }
    if (options.x !== undefined && options.y !== undefined) {
      // The move refuses a point outside the viewport and draws the cursor where the wheel lands.
      warning = await this.pointerMove({ button: "left", x: options.x, y: options.y })
      point = { x: options.x, y: options.y }
    } else point = state.cursor ?? { x: state.viewport.width / 2, y: state.viewport.height / 2 }
    await this.input({ commands: [
      {
        method: "Input.dispatchMouseEvent",
        params: {
          deltaX: 0,
          deltaY: options.direction === "down" ? options.amount : -options.amount,
          type: "mouseWheel",
          ...point,
        },
      },
    ] })
    return warning
  }

  /** Set a `<select>` value. Native dropdowns cannot be driven by synthetic input events. */
  async select(ref: string, value: string): Promise<void> {
    await this.currentUrl()
    const result = await this.callOn(
      this.requireRef(ref),
      `function(value){
        if (this.tagName !== 'SELECT') return 'Element ' + this.tagName + ' is not a <select>';
        const option = [...this.options].find((o) => o.value === value || o.label === value || o.text.trim() === value);
        if (!option) return 'No option matching ' + JSON.stringify(value);
        this.value = option.value;
        this.dispatchEvent(new Event('input', {bubbles: true}));
        this.dispatchEvent(new Event('change', {bubbles: true}));
        return null;
      }`,
      [{ value }],
    )
    if (typeof result === "string") throw new Error(result)
  }

  async hover(ref: string): Promise<void> {
    await this.currentUrl()
    const { x, y } = await this.centerOf(this.requireRef(ref), ref)
    await this.input({ commands: [
      { method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x, y } },
    ] })
  }

  async snapshot(filter: "interactive" | "all" = "interactive"): Promise<{
    text: string;
    url: string;
  }> {
    const url = await this.currentUrl()
    const { context, tree } = SnapshotReadSchema.parse(await this.read({ kind: "snapshot" }))
    const rendered = renderSnapshot(tree.nodes, { context: PageContextSchema.parse(context.result.value), filter })
    this.refs = rendered.refs
    return { text: rendered.text, url }
  }

  async text(maxChars: number): Promise<string> {
    await this.currentUrl()
    const result = z.object({ result: z.object({ value: z.string().optional() }) }).parse(
      await this.read({ kind: "text" }),
    )
    const value = result.result.value ?? ""
    return value.length > maxChars
      ? `${value.slice(0, maxChars)}\n\n[truncated at ${maxChars} characters of ${value.length}]`
      : value
  }

  /** The PNG and the pointer state read in the same inspection, so pixels map to click points. */
  async screenshot(clean: boolean): Promise<{ data: string; state: PointerState }> {
    await this.currentUrl()
    const { data, page } = ScreenshotSchema.parse(await this.read({ clean, kind: "screenshot" }))
    // An inspector or a tab without a gesture context has no held button to report.
    const held = (await this.pointerStatus().catch(() => null))?.held ?? null
    return {
      data,
      state: { cursor: page.cursor, held, scroll: { x: page.scrollX, y: page.scrollY }, viewport: { height: page.height, width: page.width } },
    }
  }

  async viewport(size?: { width: number; height: number }) {
    if (size) this.requireTab()
    await this.currentUrl()
    if (size) {
      await this.cdp("Emulation.setDeviceMetricsOverride", {
        ...size,
        deviceScaleFactor: 1,
        mobile: false,
      })
      this.refs.clear()
    }
    const result = await this.measure({ refs: [], selectors: [], styles: [] })
    const { viewport } = result
    return {
      ...result,
      ...(size
        ? {
          requested: size,
          matchesRequested: viewport.width === size.width && viewport.height === size.height,
        }
        : {}),
    }
  }

  async measure(options: { refs: string[]; selectors: string[]; styles: string[] }) {
    const tabId = this.readTab()
    await this.currentUrl()
    const nodes = options.refs.map((ref) => this.requireRef(ref))
    const result = MeasureReadSchema.parse(await this.read({
      kind: "measure",
      nodes,
      selectors: options.selectors,
      styles: options.styles,
    }))
    if (result.page.exceptionDetails) throw new Error("Page measurement failed; check CSS selectors.")
    const page = PageMeasurementSchema.parse(result.page.result.value)
    const refs = options.refs.map((ref, index) => ({
      ref,
      element: ElementFactsSchema.parse(result.nodes[index]?.result.value),
    }))
    return { tabId, ...page, refs }
  }

  /**
   * A service or host from an older build refuses gesture.bind; its pipe pages still read and take
   * one-shot input, and only the mouse verbs are refused, so this refusal is not an ordinary failure.
   */
  private async bindPipe(tabId: number, targetId: string): Promise<void> {
    if (!this.pagePipe) return
    try {
      await this.pagePipe.bind(tabId, targetId)
    } catch(cause) {
      if (!/Unsupported broker method|Unsupported service method|Unknown Managed service method/i.test(errorMessage(cause))) throw cause
    }
  }

  /** The authority-issued context, next sequence and held gesture for the controlled tab. */
  private async pointerStatus() {
    const tabId = this.selectedTabId
    // A pipe binding is invalidated by replacement/detach; refresh it before asking for a context.
    if (tabId !== null && this.pipeTarget !== null && this.pagePipe) await this.bindPipe(tabId, this.pipeTarget)
    return GestureStatusSchema.parse(await this.broker.request("gesture.status", tabId === null ? {} : { tabId }))
  }

  /** The cursor, held button, viewport and scroll of the controlled tab, read after a pointer call. */
  async pointerState(): Promise<PointerState> {
    const { held } = await this.pointerStatus()
    const page = await this.measure({ refs: [], selectors: ["chromex-cursor"], styles: [] })
    const rect = page.elements[0]?.element?.rect
    return {
      cursor: rect ? { x: rect.x, y: rect.y } : null,
      held,
      scroll: { x: page.document.scrollX, y: page.document.scrollY },
      viewport: { height: page.viewport.height, width: page.viewport.width },
    }
  }

  private pointerPublicTarget(target: PointerTargetInput): { ref: string } | { x: number; y: number } {
    if (target.ref !== undefined) return { ref: target.ref }
    if (target.x === undefined || target.y === undefined) throw new Error("Provide exactly one of ref or {x, y}.")
    return { x: target.x, y: target.y }
  }

  private pointerResolvedTarget(target: PointerTargetInput): { backendNodeId: number } | { x: number; y: number } {
    if (target.ref !== undefined) return { backendNodeId: this.requireRef(target.ref) }
    if (target.x === undefined || target.y === undefined) throw new Error("Provide both x and y.")
    return { x: target.x, y: target.y }
  }

  /**
   * Reserve and run one pointer step through its bound executor. The authority's context, sequence
   * and held gesture are read right before the step, so callers name only the target (DEC-74).
   * Returns the executor's warning: null when the step was confirmed.
   */
  private async pointerStep(
    kind: "down" | "move" | "up",
    args: { button: "left" | "right"; clickCount?: 1 | 2; target?: { ref: string } | { x: number; y: number } },
    target?: PointerTargetInput,
  ): Promise<string | null> {
    const tabId = this.requireTab()
    const { context, gesture, reserved } = await this.pointerStatus()
    if (!context && reserved && gesture === null) throw new Error("POINTER_BUSY: another client holds the mouse in this browser; retry after it ends")
    if (!context) throw new Error("No pointer context; the tab is not controlled or its page is not readable")
    // A held move drags; an unheld move is standalone. Up needs the held gesture.
    const gestureId = kind === "down" || gesture?.phase === "terminal" ? null : gesture?.gestureId ?? null
    // This client's drag ended without its up or cancel (document change, expiry): refuse once, never
    // turn the next drag step into a plain move.
    if (this.holding && kind !== "down" && gestureId === null) {
      this.holding = false
      throw new Error(`The held gesture ended: ${gesture?.warning ?? "the button is no longer held"}`)
    }
    if (kind === "up" && gestureId === null) throw new Error("No button is held")
    const receipt = z.object({ outcome: z.string().optional(), token: z.string() }).loose().parse(
      await this.broker.request("gesture.reserve", {
        args,
        contextId: context.contextId,
        gestureId,
        kind,
        resolvedTarget: target && this.pointerResolvedTarget(target),
        sequence: context.nextSequence,
        tabId,
      }),
    )
    // A new pending service step runs now; a worker step already answered with its receipt.
    const answer = receipt.outcome === "pending" && this.pipeTarget !== null && this.pagePipe
      ? StepAnswerSchema.parse(await this.pagePipe.gesture(receipt.token))
      : { receipt, warning: receipt.warning }
    const warning = typeof answer.warning === "string" ? answer.warning : null
    // Nothing was sent: the call failed, as any refused input does.
    if (answer.receipt?.outcome === "not-dispatched") throw new Error(warning ?? "Pointer input was not sent")
    this.holding = kind === "down" ? args.clickCount === undefined : kind === "move" && this.holding
    return warning
  }

  async pointerDown(target: PointerTargetInput): Promise<string | null> {
    return await this.pointerStep("down", { button: target.button, target: this.pointerPublicTarget(target) }, target)
  }

  async pointerMove(target: PointerTargetInput): Promise<string | null> {
    return await this.pointerStep("move", { button: target.button, target: this.pointerPublicTarget(target) }, target)
  }

  async pointerUp(): Promise<string | null> {
    const { held } = await this.pointerStatus()
    return await this.pointerStep("up", { button: held ?? "left" })
  }

  /** Release this client's held button now; nothing happens when it holds none. */
  async pointerCancel(): Promise<null> {
    this.holding = false
    await this.broker.request("gesture.cancel", {})
    return null
  }

  /** One or two real press/release pairs through the authority; never leaves a hold. */
  async pointerClick(target: PointerTargetInput, count: 1 | 2): Promise<string | null> {
    const publicTarget = this.pointerPublicTarget(target)
    for (let pair = 0; pair < count; pair++) {
      const clickCount = pair === 0 ? 1 : 2
      const warning = await this.pointerStep("down", { button: target.button, clickCount, target: publicTarget }, target)
        ?? await this.pointerStep("up", { button: target.button, clickCount })
      if (warning !== null) return warning
    }
    return null
  }

  async type(ref: string, text: string, clear: boolean): Promise<void> {
    await this.currentUrl()
    // The field is focused and cleared inside the input operation, so a refusal leaves it untouched.
    await this.input({
      commands: [{ method: "Input.insertText", params: { text } }],
      field: { backendNodeId: this.requireRef(ref), clear },
    })
  }

  async press(key: string): Promise<void> {
    await this.currentUrl()
    const chord = parseChord(key)
    await this.input({ commands: [
      {
        method: "Input.dispatchKeyEvent",
        params: { ...chord, type: chord.text === undefined ? "rawKeyDown" : "keyDown" },
      },
      {
        method: "Input.dispatchKeyEvent",
        params: { ...chord, text: undefined, type: "keyUp" },
      },
    ] })
  }

  async wait(options: { state?: "load"; text?: string; timeoutMs: number }): Promise<void> {
    const deadline = Date.now() + options.timeoutMs
    while (Date.now() < deadline) {
      // Throws on Chromium's error page instead of waiting it out.
      await this.currentUrl()
      const result = EvaluatedSchema.parse(await this.read({ kind: "ready", text: options.text ?? null }))
      if (result.result.value === true) return
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error(`Timed out after ${options.timeoutMs} ms`)
  }

  async console(level: "error" | "warn" | "all"): Promise<ConsoleEntry[]> {
    return this.activity.console(level)
  }

  async network(status: "failed" | "all"): Promise<NetworkEntry[]> {
    return this.activity.network(status)
  }

  async release(): Promise<void> {
    if (this.inspectedTabId !== null) {
      this.inspectedTabId = null
      this.refs.clear()
      this.activity.clear()
      await this.broker.request("tabs.uninspect")
    }
    const tabId = this.selectedTabId ?? this.parkedTabId
    if (tabId === null) return
    if (this.pipeTarget !== null && this.pagePipe) await this.pagePipe.release(tabId).catch(() => undefined)
    this.clearSelected(false)
    this.parkedTabId = null
    await this.broker.request("tabs.release", { tabId })
  }

  async closeTab(): Promise<void> {
    const tabId = this.requireTab()
    if (!this.ownsTab)
      throw new Error(
        "Only a tab created by this client's chrome_open can be closed. Use chrome_release for claimed tabs.",
      )
    await this.broker.request("tabs.close", { tabId })
    this.clearSelected(false)
    this.parkedTabId = null
  }

  async close(): Promise<void> {
    try {
      await this.release()
    } finally {
      await this.broker.close()
    }
  }

  /** Attach the debugger and enable the domains that feed the activity buffers. */
  private async attach(tabId: number): Promise<void> {
    try {
      await this.broker.request("cdp.attach", { tabId })
      this.pipeTarget = null
    } catch(cause) {
      if (!this.pagePipe || !INTERNAL_ATTACH_ERROR.test(errorMessage(cause))) throw cause
      this.pipeTarget = await this.targetOf(tabId)
      await this.bindPipe(tabId, this.pipeTarget)
    }
    this.selectedTabId = tabId
    this.activity.clear()
    // ponytail: pipe pages get no console/network buffers; route pipe events if agents need them.
    if (this.pipeTarget !== null) return
    for (const domain of ["Runtime", "Log", "Network", "Page"]) {
      // A page that refuses one domain should not block control of the tab.
      await this.cdp(`${domain}.enable`).catch(() => undefined)
    }
  }
  private onNotification(method: string, params: unknown): void {
    const parsed = NotificationSchema.safeParse(params)
    if (!parsed.success) return
    const event = parsed.data
    if (method === "cdp.event") {
      if (event.tabId === undefined || event.method === undefined) return
      if (event.tabId !== (this.selectedTabId ?? this.inspectedTabId)) return
      this.activity.record(event.method, event.params, Date.now())
      return
    }
    if (event.tabId === undefined) return
    if (method === "tab.closed") {
      if (event.tabId === this.inspectedTabId) {
        this.inspectedTabId = null
        this.refs.clear()
        this.activity.clear()
      }
      if (event.tabId === this.selectedTabId) this.clearSelected(false)
      if (event.tabId === this.parkedTabId) this.parkedTabId = null
      return
    }
    if (method !== "cdp.detached" || event.tabId !== this.selectedTabId) return
    const owned = this.ownsTab
    this.clearSelected(owned)
    // The browser already detached the debugger; only relinquish a user-owned tab's lease.
    if (!owned)
      void this.broker.request("tabs.release", { tabId: event.tabId }).catch(() => undefined)
  }
  private clearSelected(parkOwned: boolean): void {
    if (parkOwned && this.ownsTab && this.selectedTabId !== null) {
      this.parkedTabId = this.selectedTabId
    }
    this.selectedTabId = null
    this.pipeTarget = null
    this.ownsTab = false
    this.refs.clear()
    this.activity.clear()
  }
  private reconcileStatus(status: z.infer<typeof ClientStatusSchema>): void {
    const leases = new Map(status.leases.map((lease) => [lease.tabId, lease.attached]))
    // A pipe-driven tab is leased but has no extension debugger attached.
    const attached = this.selectedTabId === null ? undefined : leases.get(this.selectedTabId)
    if (this.selectedTabId !== null && attached !== true && !(attached === false && this.pipeTarget !== null)) {
      this.clearSelected(this.ownsTab)
    }
    if (this.parkedTabId !== null && !leases.has(this.parkedTabId)) this.parkedTabId = null
    this.windowId = status.windowId
  }
  /** The tab this client controls; refuses for a tab it only inspects. */
  private requireTab(): number {
    if (this.inspectedTabId !== null) {
      throw new Error(
        `Tab ${this.inspectedTabId} is only inspected by this client; another agent controls it. Use chrome_use_tab without inspect after it releases the tab.`,
      )
    }
    if (this.selectedTabId === null)
      throw new Error("No tab selected. Use chrome_use_tab or chrome_open first.")
    return this.selectedTabId
  }
  /** The tab this client reads, controlled or inspected. */
  private readTab(): number {
    return this.inspectedTabId ?? this.requireTab()
  }
  /** One fixed read: over this client's own lease, or admitted by the extension for an inspected tab. */
  private async read(request: InspectRequest): Promise<unknown> {
    const tabId = this.inspectedTabId
    if (tabId === null) {
      if (this.pipeTarget !== null && this.pagePipe) {
        const reply = z
          .union([z.object({ result: z.unknown() }), z.object({ token: z.string() })])
          .parse(await this.broker.request("cdp.ownerInspect", { request, tabId: this.requireTab() }))
        if ("token" in reply) return await this.pagePipe.inspect(reply.token)
        return reply.result
      }
      return await runInspection(request, async(method, params) => await this.cdp(method, params))
    }
    const reply = z
      .union([z.object({ result: z.unknown() }), z.object({ token: z.string() })])
      .parse(await this.broker.request("cdp.inspect", { request, tabId }))
    if ("token" in reply) {
      if (!this.pagePipe) throw new Error(`Tab ${tabId} needs the Managed browser pipe`)
      return await this.pagePipe.inspect(reply.token)
    }
    return reply.result
  }
  private requireRef(ref: string): number {
    const id = this.refs.get(ref)
    if (!id) throw new Error(`Unknown element ref ${ref}; take a new snapshot.`)
    return id
  }
  /** Run a function with `this` bound to the element, returning its value. */
  private async callOn(
    backendNodeId: number,
    functionDeclaration: string,
    args: { value: unknown }[] = [],
  ): Promise<unknown> {
    const resolved = z
      .object({ object: z.object({ objectId: z.string() }) })
      .parse(await this.cdp("DOM.resolveNode", { backendNodeId }))
    const result = z.object({ result: z.object({ value: z.unknown().optional() }) }).parse(
      await this.cdp("Runtime.callFunctionOn", {
        arguments: args,
        functionDeclaration,
        objectId: resolved.object.objectId,
        returnByValue: true,
      }),
    )
    return result.result.value
  }
  /** Scroll the node into view, then return its viewport center. */
  private async centerOf(backendNodeId: number, ref: string): Promise<{ x: number; y: number }> {
    // Scrolling the node into view is control; refuse it before the catch below rewords the error.
    this.requireTab()
    try {
      await this.cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId })
      const model = z
        .object({ model: z.object({ content: z.array(z.number()) }) })
        .parse(await this.cdp("DOM.getBoxModel", { backendNodeId }))
      const xs = model.model.content.filter((_, i) => i % 2 === 0)
      const ys = model.model.content.filter((_, i) => i % 2 === 1)
      return {
        x: xs.reduce((a, b) => a + b, 0) / xs.length,
        y: ys.reduce((a, b) => a + b, 0) / ys.length,
      }
    } catch {
      throw new Error(`Element ${ref} is no longer on the page; take a new snapshot.`)
    }
  }
  private async waitForTabUrl(
    tabId: number,
    accept: (url: string) => boolean,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const tabs = z.array(TabInfoSchema).parse(await this.broker.request("tabs.list"))
      const url = tabs.find((tab) => tab.id === tabId)?.url
      if (url !== undefined && accept(url)) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  private async waitForUrlChange(previous: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((await this.currentUrl().catch(() => previous)) !== previous) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  private async cdp(method: string, params: unknown = {}): Promise<unknown> {
    const tabId = this.requireTab()
    if (this.pipeTarget === null || !this.pagePipe) {
      return await this.broker.request("cdp.command", { tabId, method, params })
    }
    // The extension records the exact command for this lease; the service may run only that.
    const { token } = z
      .object({ token: z.string() })
      .parse(await this.broker.request("input.reserve", {
        commands: [{ method, params }],
        kind: "cdp",
        tabId,
      }))
    return await this.pagePipe.cdp(token)
  }

  /**
   * Run input away from the visible tab: the extension temporarily selects another tab and enables
   * focus emulation, so Chromium does not activate the window. A pipe tab has no extension debugger:
   * the extension reserves the operation for this lease and the Managed service runs it to the end.
   */
  private async input(operation: InputOperation): Promise<void> {
    const tabId = this.requireTab()
    if (this.pipeTarget === null || !this.pagePipe) {
      await this.broker.request("input.run", { ...operation, tabId })
      return
    }
    const { token } = z
      .object({ token: z.string() })
      .parse(await this.broker.request("input.reserve", { ...operation, tabId }))
    await this.pagePipe.input(token)
  }
  private async targetOf(tabId: number): Promise<string> {
    return z
      .object({ targetId: z.string() })
      .parse(await this.broker.request("tabs.target", { tabId })).targetId
  }
  /** The page URL; throws while Chromium shows its error page, so actions call it first. */
  private async currentUrl(): Promise<string> {
    const { frameTree, href } = UrlReadSchema.parse(await this.read({ kind: "url" }))
    if (frameTree === null) return href.result.value
    const target = frameTree.frameTree.frame.unreachableUrl
    throw new Error(
      `Navigation failed${target ? ` for ${target}` : ""}: Chromium is showing an error page. Check chrome_network; verify the server is reachable, then call chrome_open again.`,
    )
  }
}
