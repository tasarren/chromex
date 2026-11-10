/**
 * The agent cursor: a page-visible indicator of confirmed agent pointer points (DEC-67). Both Managed
 * executors draw it through their own session after each confirmed dispatch, never ahead of input.
 * It lives in an isolated world, under the document element (outside body text) and aria-hidden.
 */

import type { Point } from "./pointer.ts"

type Send = (method: string, params: Record<string, unknown>) => Promise<unknown>

/** Intermediate events of one eased move, including its endpoint. */
export const EASED_EVENTS = 8

const WORLD = "chromex-cursor"

const COMMAND_TIMEOUT_MS = 2_000

/** Runs in the isolated world; its globals reset with each new document. Returns the last drawn point. */
export const CURSOR_SCRIPT = `(args) => {
  const g = globalThis
  // DOM and CSSOM calls only: internal pages refuse innerHTML (Trusted Types) and inline <style> (CSP).
  if (!g.chromexCursor) {
    const ns = "http://www.w3.org/2000/svg"
    const node = (name, attributes) => {
      const element = document.createElementNS(ns, name)
      for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value)
      return element
    }
    const host = document.createElement("chromex-cursor")
    host.setAttribute("aria-hidden", "true")
    host.style.cssText = "all:initial;position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;display:block"
    const svg = node("svg", { width: "26", height: "28", viewBox: "-8 -8 26 28" })
    svg.style.cssText = "position:absolute;left:-8px;top:-8px;overflow:visible;filter:drop-shadow(0 1px 2px #0009)"
    const ring = node("circle", { cx: "0", cy: "0", r: "8", fill: "#e5484d66", visibility: "hidden" })
    const arrow = node("path", { d: "M0 0v19l5-5 4 9 3.5-1.6-4-8.6h7z", fill: "#2563eb", stroke: "#fff", "stroke-width": "1.5" })
    svg.append(ring, arrow)
    host.attachShadow({ mode: "closed" }).append(svg)
    g.chromexCursor = { host, ring, arrow }
  }
  const { host, ring, arrow } = g.chromexCursor
  if (!document.documentElement) throw new Error("The page has no document element")
  if (!host.isConnected) document.documentElement.append(host)
  if (args) {
    host.style.transform = "translate(" + args.x + "px," + args.y + "px)"
    ring.setAttribute("visibility", args.held ? "visible" : "hidden")
    arrow.setAttribute("fill", args.held ? "#e5484d" : "#2563eb")
    g.chromexPoint = { x: args.x, y: args.y }
  }
  return g.chromexPoint ?? null
}`

/** The cursor could not be shown; raised before input so nothing was sent. */
export class CursorUnavailable extends Error {
  override name = "CursorUnavailable"
}

/** One executor's cursor for the current document; holds the isolated-world context for one operation. */
export class AgentCursor {
  private readonly send: Send
  private context: number | null = null

  constructor(send: Send) {
    this.send = (method, params) => answered(send(method, params), method)
  }

  /**
   * Show the cursor on this document before any input and return its last confirmed point, null
   * on a new document. Throws CursorUnavailable, so the caller sends nothing.
   */
  async ensure(): Promise<Point | null> {
    try {
      return await this.run(null)
    } catch(cause) {
      throw new CursorUnavailable(message(cause), { cause })
    }
  }

  /** Draw a confirmed point; `held` while a button is pressed. Throws a plain Error after input. */
  async draw(point: Point, held: boolean): Promise<void> {
    await this.run({ ...point, held })
  }

  /** Remove the indicator after the tab is released or handed off. */
  async remove(): Promise<void> {
    this.context ??= await this.createWorld()
    await this.send("Runtime.evaluate", {
      contextId: this.context,
      expression: "globalThis.chromexCursor?.host.remove(); delete globalThis.chromexCursor; delete globalThis.chromexPoint",
    })
  }

  private async run(args: (Point & { held: boolean }) | null): Promise<Point | null> {
    try {
      // Chromium reuses a named isolated world per frame, so repeated creation does not grow it.
      this.context ??= await this.createWorld()
      const reply = await this.send("Runtime.evaluate", {
        contextId: this.context,
        expression: `(${CURSOR_SCRIPT})(${JSON.stringify(args)})`,
        returnByValue: true,
      })
      if (!isObject(reply) || reply.exceptionDetails !== undefined || !isObject(reply.result)) {
        throw new Error("the page refused the indicator")
      }
      const value = reply.result.value
      return isObject(value) && typeof value.x === "number" && typeof value.y === "number" ? { x: value.x, y: value.y } : null
    } catch(cause) {
      this.context = null
      throw new Error(`The agent cursor cannot be shown: ${message(cause)}`, { cause })
    }
  }

  private async createWorld(): Promise<number> {
    const tree = await this.send("Page.getFrameTree", {})
    const frame = isObject(tree) && isObject(tree.frameTree) && isObject(tree.frameTree.frame) ? tree.frameTree.frame : null
    if (typeof frame?.id !== "string") throw new Error("the page has no main frame")
    const world = await this.send("Page.createIsolatedWorld", { frameId: frame.id, worldName: WORLD })
    if (!isObject(world) || typeof world.executionContextId !== "number") throw new Error("no isolated world")
    return world.executionContextId
  }
}

/** The eased points from one point to another, ending exactly at `to`; one point when they match. */
export function easedPath(from: Point | null, to: Point): Point[] {
  if (!from || (from.x === to.x && from.y === to.y)) return [to]
  return Array.from({ length: EASED_EVENTS }, (_, index) => {
    const t = (index + 1) / EASED_EVENTS
    const k = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
    return index === EASED_EVENTS - 1 ? to : { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k }
  })
}

/** What an agent sees of the pointer after each call: one line, no screenshot needed (DEC-75). */
export type PointerState = {
  cursor: Point | null
  held: "left" | "right" | null
  viewport: { width: number; height: number }
  scroll: Point
}

export function formatPointerState(s: PointerState): string {
  const at = s.cursor ? `${Math.round(s.cursor.x)},${Math.round(s.cursor.y)}` : "none"
  return `cursor ${at} held ${s.held ?? "none"} viewport ${s.viewport.width}x${s.viewport.height} scroll ${Math.round(s.scroll.x)},${Math.round(s.scroll.y)}`
}

export type ScreenshotPath = {
  readonly file: string
  readonly bytes: number
}

/**
 * One line for a screenshot: how a pixel in the PNG maps to a CSS click point, where the page
 * is scrolled, and where the cursor sits (DEC-75). `mapping none` means the two aspect ratios
 * differ by more than one pixel; the agent must not convert.
 */
export function formatScreenshotLine(
  png: { readonly width: number; readonly height: number },
  state: PointerState,
  path?: ScreenshotPath,
): string {
  const { width, height } = state.viewport
  // A 1 px rounding difference between the PNG and the CSS viewport is a 1:1 capture: Chromium
  // can report a fractional layout viewport rounded to an integer while the PNG keeps the request.
  const nearOne = Math.abs(png.width - width) <= 1 && Math.abs(png.height - height) <= 1
  const scale = nearOne ? 1 : width > 0 ? Math.round((png.width / width) * 1000) / 1000 : null
  const mapped = nearOne || (scale !== null && Math.abs(png.height - height * scale) <= 1)
  const at = state.cursor ? `${Math.round(state.cursor.x)},${Math.round(state.cursor.y)}` : "none"
  const line = `png ${png.width}x${png.height} css ${width}x${height}${mapped ? ` scale ${scale}` : ""} scroll ${Math.round(state.scroll.x)},${Math.round(state.scroll.y)} cursor ${at} held ${state.held ?? "none"}`
  const withPath = path ? `${line} path ${path.file} bytes ${path.bytes}` : line
  return mapped ? withPath : `${withPath} mapping none`
}

/** A browser command must never hold a step: one that does not answer in time fails instead. */
export async function answered<T>(reply: Promise<T>, method: string, ms = COMMAND_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error(`${method} did not answer within ${ms} ms`)) }, ms)
  })
  try {
    return await Promise.race([reply, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
