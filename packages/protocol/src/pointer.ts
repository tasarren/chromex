/**
 * One held-gesture step as its original executor runs it: the extension worker for an attached tab,
 * the Managed service for a pipe-driven page. Both send through their own cached session.
 *
 * Document checks are not atomic with delivery (DEC-57): a replacement known before a step refuses
 * it; one detected after input may have been sent makes the step uncertain, and input already sent
 * may have reached the replacement.
 */

import { AgentCursor, answered, easedPath } from "./cursor.ts"

export type PointerButton = "left" | "right"
export type Point = { readonly x: number; readonly y: number }
export type PointerTarget = Point | { readonly backendNodeId: number }
/** Stored step arguments; `up` has no target. */
export type PointerArgs = {
  readonly button: PointerButton
  /** 1 or 2 for a tested single/double click; omitted for a held gesture step. */
  readonly clickCount?: 1 | 2
  readonly target?: PointerTarget
}

/** The page document a gesture is bound to: main frame, loader, and replacements counted by its session. */
export type DocumentIdentity = { readonly epoch: number; readonly frameId: string; readonly loaderId: string }

/** Executor-local state of one gesture, kept with its original session between calls. */
export type GestureState = {
  document: DocumentIdentity | null
  emulating: boolean
  /** Last point whose dispatch was confirmed. */
  point: Point | null
  /** True only while this gesture owns a pressed button. */
  pressed: boolean
}

type Send = (method: string, params: Record<string, unknown>) => Promise<unknown>

export type StepSession = {
  readonly send: Send
  /** The current main-frame document, read after any event that arrived before it. */
  identity(): Promise<DocumentIdentity>
  /** Cancellation was latched: stop before the next event. */
  cancelled(): boolean
  /** Select the measured helper-edge tab before a press or release. */
  beforeEdge?(kind: "down" | "up"): Promise<void>
  /** Restore the target selection after a confirmed edge. Failure makes the edge uncertain. */
  afterEdge?(kind: "down" | "up"): Promise<void>
  /** Throw StepRefused when the authority no longer holds this gesture's cleanup. */
  live?(): Promise<void>
}

/** Nothing was sent: the step can be reported as not dispatched. */
export class StepRefused extends Error {
  override name = "StepRefused"
}

/** Input may have been sent and its result cannot be confirmed. */
export class StepUncertain extends Error {
  override name = "StepUncertain"
}

export const REPLACED_WARNING =
  "The page document changed while pointer input was being sent; input may have reached the replacement page. The gesture is uncertain: no further input is sent and the button may still be held."

const MASK: Record<PointerButton, number> = { left: 1, right: 2 }

export function sameDocument(a: DocumentIdentity, b: DocumentIdentity): boolean {
  return a.epoch === b.epoch && a.frameId === b.frameId && a.loaderId === b.loaderId
}

/**
 * Read the main frame of the page. The epoch is sampled after the reply, so a rewrite or replacement
 * delivered while the command was pending cannot be missed by a stale pre-request sample.
 */
export async function readDocument(send: Send, epoch: () => number): Promise<DocumentIdentity> {
  const before = epoch()
  const reply = await send("Page.getFrameTree", {})
  const after = epoch()
  if (after !== before) throw new Error("The page document changed while its frame tree was being read")
  const frame = isObject(reply) && isObject(reply.frameTree) && isObject(reply.frameTree.frame) ? reply.frameTree.frame : null
  if (typeof frame?.id !== "string" || typeof frame.loaderId !== "string") throw new Error("Page frame tree has no main frame")
  return { epoch: after, frameId: frame.id, loaderId: frame.loaderId }
}

/** True for a main-frame event that replaces or rewrites the document. */
export function replacesDocument(method: string, params: Record<string, unknown>): boolean {
  const frame = method === "Page.frameNavigated" && isObject(params.frame) ? params.frame : null
  if (frame) return frame.parentId === undefined
  // A document.open() rewrite keeps the loader; only the main frame matters here.
  return method === "Page.documentOpened" && isObject(params.frame) && params.frame.parentId === undefined
}

/**
 * Run one admitted step. Returns the confirmed endpoint; throws StepRefused before any input and
 * StepUncertain once input may have been sent. `pressed` is the stored button state of the gesture.
 */
export async function runPointerStep(
  kind: "down" | "move" | "up" | "cancel",
  args: PointerArgs,
  state: GestureState,
  session: StepSession,
): Promise<Point> {
  // Cancel is the release of a held button; it is the one step a latched cancellation still runs.
  if (kind === "cancel" && !state.pressed) {
    // A down that failed before its press can leave focus emulation on; the gesture ends here.
    if (state.emulating) await session.send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => undefined)
    state.emulating = false
    throw new StepRefused("No button is held; no release was sent")
  }
  // Document replacement and rewrite events are counted only while the Page domain is enabled.
  if (kind === "down") await refuseOnError(() => session.send("Page.enable", {}))
  const before = await refuseOnError(() => session.identity())
  if (state.document && !sameDocument(state.document, before)) throw new StepRefused("The page document changed; the gesture cannot continue")
  if (kind !== "cancel" && session.cancelled()) throw new StepRefused("The gesture was cancelled before the step began")
  const target = kind === "up" || kind === "cancel" ? state.point : await refuseOnError(() => resolvePoint(args.target, session.send, kind === "down"))
  if (!target) throw new StepRefused("The gesture has no confirmed point")
  // The cursor must show before any travel input (DEC-67); a release never waits on it.
  const cursor = new AgentCursor(session.send)
  const from = kind === "up" || kind === "cancel" ? null : await refuseOnError(() => cursor.ensure())
  // A hidden tab stops answering a burst of mouseMoved events unless it renders as focused (TASK-07
  // live hang), so a standalone move owns emulation for its own duration only.
  const standalone = kind === "move" && !state.emulating
  if (kind === "down" || standalone) {
    if (kind === "down") state.document = before
    await refuseOnError(() => session.send("Emulation.setFocusEmulationEnabled", { enabled: true }))
    state.emulating = true
  }

  const checked = async() => {
    const current = await uncertainOnError(() => session.identity())
    if (!sameDocument(before, current)) throw new StepUncertain(REPLACED_WARNING)
  }
  const send = async(params: Record<string, unknown>, sent: boolean) => {
    if (sent) await checked()
    try {
      await answered(session.send("Input.dispatchMouseEvent", params), "Input.dispatchMouseEvent")
    } catch(cause) {
      throw new StepUncertain(`Pointer input outcome is unknown: ${message(cause)}`, { cause })
    }
  }
  const button = args.button
  const buttons = MASK[button]
  const clickCount = args.clickCount ?? 1
  const drawn = async(point: Point, held: boolean) => {
    try {
      await cursor.draw(point, held)
    } catch(cause) {
      throw new StepUncertain(`Pointer input was sent but ${message(cause)}`, { cause })
    }
  }
  /** Real eased input from the cursor's last confirmed point; each confirmed event moves the cursor. */
  const travel = async(held: boolean) => {
    for (const [index, point] of easedPath(state.point ?? from, target).entries()) {
      // A cancel between events stops the path; the last confirmed point stays the gesture's point.
      // A down already checked its document right before its first event.
      if (index > 0 || kind !== "down") {
        await checked()
        if (session.cancelled()) return
      }
      await send({ type: "mouseMoved", x: point.x, y: point.y, button: held ? button : "none", buttons: held ? buttons : 0 }, false)
      state.point = point
      await drawn(point, held)
    }
  }
  switch (kind) {
    case "down": {
      const resetEmulation = async() => {
        await session.send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => undefined)
        state.emulating = false
      }
      // Scrolling and geometry reads can race a navigation, so check again right before any input.
      const fresh = await refuseOnError(() => session.identity()).catch(async(cause: unknown) => {
        await resetEmulation()
        throw cause
      })
      if (session.cancelled() || !sameDocument(before, fresh)) {
        await resetEmulation()
        throw new StepRefused("The page changed or the gesture was cancelled before any input")
      }
      // From here input may have reached the page (hover effects), so every failure is uncertain.
      // Do not reset emulation after an origin move that may have dispatched: the input outcome is
      // unknown, and removing owned focus state would be an unproved teardown.
      await travel(false)
      await checked()
      if (session.cancelled()) throw new StepUncertain("The gesture was cancelled after the pointer moved; no press was sent")
      try {
        await session.beforeEdge?.("down")
      } catch(cause) {
        throw new StepUncertain(`The pointer moved but the helper edge could not be selected: ${message(cause)}`, { cause })
      }
      // The edge can take time; a change known before the press must still prevent it.
      await checked()
      if (session.cancelled()) throw new StepUncertain("The gesture was cancelled during helper selection; no press was sent")
      // A lost reply may still have pressed the button, so cancel must find it held.
      state.pressed = true
      state.point = target
      await send({ type: "mousePressed", x: target.x, y: target.y, button, buttons, clickCount }, false)
      await drawn(target, true)
      await edgeAfter(session, "down")
      break
    }
    case "move":
      try {
        await travel(state.pressed)
      } finally {
        if (standalone) {
          await session.send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => undefined)
          state.emulating = false
        }
      }
      break
    case "up":
    case "cancel":
      // Do not select a helper or send a release for a document that already changed.
      await checked()
      await refuseOnError(async() => { await session.beforeEdge?.("up") })
      await checked()
      if (kind === "up" && session.cancelled()) throw new StepUncertain("The gesture was cancelled during helper selection; no release was sent")
      // A late cleanup must not release a button that a newer gesture now holds.
      // ponytail: check-then-send is not atomic; the window is one authority round trip.
      if (kind === "cancel") {
        await refuseOnError(async() => { await session.live?.() }).catch(async(cause: unknown) => {
          await session.afterEdge?.("up").catch(() => undefined)
          throw cause
        })
      }
      await send({ type: "mouseReleased", x: target.x, y: target.y, button, buttons: 0, clickCount }, true)
      state.pressed = false
      // ponytail: an idle-state draw failure after a confirmed release is not reported; the cursor
      // may still look held. Report it in the receipt warning if this shows up in live checks.
      await cursor.draw(target, false).catch(() => undefined)
      await edgeAfter(session, "up")
      break
  }
  await checked()
  if (kind === "up" || kind === "cancel") {
    // The release is confirmed either way; a failed reset only leaves emulated focus on a hidden tab.
    await session.send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => undefined)
    state.emulating = false
  }
  return state.point ?? target
}

/** Resolve a target to a viewport point. Before a press a ref may scroll into view; while held it never scrolls. */
export async function resolvePoint(target: PointerTarget | undefined, send: Send, mayScroll: boolean): Promise<Point> {
  if (!target) throw new StepRefused("The step has no target")
  let point: Point
  if ("backendNodeId" in target) {
    if (mayScroll) await send("DOM.scrollIntoViewIfNeeded", { backendNodeId: target.backendNodeId })
    const model = await send("DOM.getBoxModel", { backendNodeId: target.backendNodeId })
    const quad = isObject(model) && isObject(model.model) && Array.isArray(model.model.content) ? model.model.content : []
    const numbers = quad.filter((value): value is number => typeof value === "number")
    if (numbers.length !== 8) throw new StepRefused("The element has no box; take a new snapshot")
    point = {
      x: numbers.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0) / 4,
      y: numbers.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b, 0) / 4,
    }
  } else point = target
  const metrics = await send("Page.getLayoutMetrics", {})
  const viewport = isObject(metrics) && isObject(metrics.cssLayoutViewport) ? metrics.cssLayoutViewport : null
  const width = viewport?.clientWidth
  const height = viewport?.clientHeight
  if (typeof width !== "number" || typeof height !== "number") throw new StepRefused("Viewport size is unknown")
  if (!insideViewport(point, width, height)) {
    throw new StepRefused(`Point ${point.x},${point.y} is outside the ${width}x${height} viewport`)
  }
  return point
}

/** Finite and inside the CSS viewport; an outside point is refused, never clamped. */
export function insideViewport(point: Point, width: number, height: number): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0 && point.x < width && point.y < height
}

/** The authority calls an executor makes, under its own identity: in-process for the worker, the host for the service. */
export type ExecutorAuthority = {
  admit(token: string): Promise<unknown>
  complete(token: string, dispatched: boolean, point: Point | null, warning: string | null): Promise<unknown>
  uncertain(token: string, warning: string, point: Point | null): Promise<unknown>
}

/** What the authority admitted, with the page it is for. */
export type Admitted = {
  readonly args: PointerArgs
  readonly document: DocumentIdentity
  readonly gestureId: string
  readonly kind: "down" | "move" | "up" | "cancel"
  readonly sessionId: string | null
  /** One unheld move: no button is pressed and no gesture state is retained after it. */
  readonly standalone: boolean
  readonly tabId: number
  readonly targetId: string | null
}

/** The authority's receipt for the step, its confirmed endpoint, and why it refused or became uncertain. */
export type StepAnswer = { readonly point: Point | null; readonly receipt: unknown; readonly warning: string | null }

/**
 * Admit one stored step as its original executor, run it, and report exactly what happened. A
 * cancel step releases a held button (DEC-65); no no-drop proof is attempted. An admission refusal
 * throws before anything is sent.
 */
export async function executeStep(
  authority: ExecutorAuthority,
  token: string,
  run: (step: Admitted) => Promise<Point>,
): Promise<StepAnswer> {
  const admitted = await authority.admit(token)
  let step: Admitted
  try {
    step = parseAdmitted(admitted)
  } catch(cause) {
    // Admitted but unusable: nothing was sent, so the step ends as not dispatched.
    return { point: null, receipt: await authority.complete(token, false, null, message(cause)), warning: message(cause) }
  }
  try {
    const point = await run(step)
    return { point, receipt: await authority.complete(token, true, point, null), warning: null }
  } catch(cause) {
    const warning = message(cause)
    if (cause instanceof StepRefused) return { point: null, receipt: await authority.complete(token, false, null, warning), warning }
    return { point: null, receipt: await authority.uncertain(token, warning, null), warning }
  }
}

export function parseAdmitted(value: unknown): Admitted {
  if (!isObject(value) || typeof value.gestureId !== "string" || typeof value.tabId !== "number") {
    throw new Error("Invalid admitted pointer step")
  }
  const kind = value.kind
  if (kind !== "down" && kind !== "move" && kind !== "up" && kind !== "cancel") throw new Error("Invalid pointer step kind")
  if (!isObject(value.document) || typeof value.document.epoch !== "number" ||
      typeof value.document.frameId !== "string" || typeof value.document.loaderId !== "string") {
    throw new Error("Invalid pointer document identity")
  }
  return {
    args: parsePointerArgs(value.args, kind === "up" || kind === "cancel"),
    document: { epoch: value.document.epoch, frameId: value.document.frameId, loaderId: value.document.loaderId },
    gestureId: value.gestureId,
    kind,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
    standalone: value.standalone === true,
    tabId: value.tabId,
    targetId: typeof value.targetId === "string" ? value.targetId : null,
  }
}

/** Validate stored or public step arguments: a button, and exactly one complete target unless untargeted. */
export function parsePointerArgs(value: unknown, untargeted: boolean): PointerArgs {
  if (!isObject(value)) throw new Error("Invalid pointer arguments")
  const button = value.button ?? "left"
  if (button !== "left" && button !== "right") throw new Error(`Unsupported mouse button ${JSON.stringify(button)}`)
  const clickCount = value.clickCount
  if (clickCount !== undefined && clickCount !== 1 && clickCount !== 2) throw new Error("Invalid click count")
  if (untargeted) return { button, ...(clickCount === undefined ? {} : { clickCount }) }
  const target = value.target
  if (isObject(target) && typeof target.backendNodeId === "number" && Object.keys(target).length === 1) {
    return { button, ...(clickCount === undefined ? {} : { clickCount }), target: { backendNodeId: target.backendNodeId } }
  }
  if (isObject(target) && Object.keys(target).length === 2 && Number.isFinite(target.x) && Number.isFinite(target.y)) {
    return { button, ...(clickCount === undefined ? {} : { clickCount }), target: { x: target.x as number, y: target.y as number } }
  }
  // Internal callers may pass the point directly; public tools use one target object.
  if (Number.isFinite(value.x) && Number.isFinite(value.y)) {
    return { button, ...(clickCount === undefined ? {} : { clickCount }), target: { x: value.x as number, y: value.y as number } }
  }
  throw new Error("A pointer step needs exactly one ref or one complete finite {x, y}")
}

async function refuseOnError<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch(cause) {
    if (cause instanceof StepRefused) throw cause
    throw new StepRefused(message(cause), { cause })
  }
}

async function edgeAfter(session: StepSession, kind: "down" | "up"): Promise<void> {
  try {
    await session.afterEdge?.(kind)
  } catch(cause) {
    throw new StepUncertain(`The input edge was sent but its helper selection could not be restored: ${message(cause)}`, { cause })
  }
}

async function uncertainOnError<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch(cause) {
    throw new StepUncertain(`The page document cannot be confirmed: ${message(cause)}`, { cause })
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
