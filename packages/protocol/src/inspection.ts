// Fixed read-only page inspection. A caller picks a kind and bounded data, never CDP methods or code,
// so an agent that does not control a tab can still read it without changing its page state.

import { answered } from "./cursor.ts"

type Send = (method: string, params: Record<string, unknown>) => Promise<unknown>

export type InspectRequest =
  | { readonly kind: "url" }
  | { readonly kind: "text" }
  | { readonly kind: "ready"; readonly text: string | null }
  | { readonly kind: "snapshot" }
  | { readonly kind: "screenshot"; readonly clean: boolean }
  | {
    readonly kind: "measure";
    readonly nodes: readonly number[];
    readonly selectors: readonly string[];
    readonly styles: readonly string[];
  }

const MAX_ITEMS = 20
const MAX_SELECTOR = 500
const MAX_WAIT_TEXT = 10_000
const STYLE_NAME = /^(?:--[A-Za-z0-9_-]+|[a-z][a-z-]*)$/u
const ERROR_PAGE = "chrome-error://chromewebdata/"

// Fixed read-only page function. Caller supplies property names, never JavaScript.
const ELEMENT_FACTS = `function(styles) {
  if (!this) return null;
  const rect = this.getBoundingClientRect();
  const computed = getComputedStyle(this);
  return {
    tag: this.localName, id: this.id.slice(0, 200),
    role: this.getAttribute('role')?.slice(0, 200) ?? null, label: (this.getAttribute('aria-label') ?? '').slice(0, 200),
    focused: this === document.activeElement, focusVisible: this.matches(':focus-visible'),
    rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left},
    styles: Object.fromEntries(styles.map(name => [name, computed.getPropertyValue(name).slice(0, 1024)]))
  };
}`

const PAGE_CONTEXT =
  "({scrollHeight: document.documentElement.scrollHeight, scrollY: window.scrollY, title: document.title, url: location.href, viewportHeight: window.innerHeight})"

/** Validate an inspection request from another process; throws on anything outside the closed set. */
export function parseInspection(value: unknown): InspectRequest {
  if (!isFields(value)) throw new Error("Invalid inspection request")
  switch (value.kind) {
    case "url":
    case "text":
    case "snapshot":
      return { kind: value.kind }
    case "screenshot": {
      if (value.clean === undefined) return { kind: "screenshot", clean: false }
      if (typeof value.clean === "boolean") return { kind: "screenshot", clean: value.clean }
      break
    }
    case "ready": {
      const { text } = value
      if (text === null || (typeof text === "string" && text.length <= MAX_WAIT_TEXT)) {
        return { kind: "ready", text }
      }
      break
    }
    case "measure": {
      const nodes = list(value.nodes, (node) => Number.isInteger(node) && Number(node) >= 0)
      const selectors = list(value.selectors, (selector) =>
        typeof selector === "string" && selector.length > 0 && selector.length <= MAX_SELECTOR)
      const styles = list(value.styles, (style) => typeof style === "string" && STYLE_NAME.test(style))
      if (nodes && selectors && styles) {
        return { kind: "measure", nodes: nodes.map(Number), selectors: selectors.map(String), styles: styles.map(String) }
      }
      break
    }
    default:
      break
  }
  throw new Error("Invalid inspection request")
}

/** Run one inspection with fixed commands. Results are raw CDP replies for the caller to parse. */
export async function runInspection(request: InspectRequest, send: Send): Promise<unknown> {
  switch (request.kind) {
    case "url": {
      const href = await evaluate(send, "location.href")
      const errorPage = isFields(href) && isFields(href.result) && href.result.value === ERROR_PAGE
      return { frameTree: errorPage ? await send("Page.getFrameTree", {}) : null, href }
    }
    case "text":
      return await evaluate(send, "document.body?.innerText ?? ''")
    case "ready":
      return await evaluate(
        send,
        request.text === null
          ? "document.readyState === 'complete'"
          : `document.body?.innerText.includes(${JSON.stringify(request.text)}) === true`,
      )
    case "snapshot":
      return {
        context: await evaluate(send, PAGE_CONTEXT),
        tree: await send("Accessibility.getFullAXTree", {}),
      }
    case "screenshot":
      return await screenshot(request.clean, send)
    case "measure":
      return await measure(request, send)
  }
}

export type ScreenshotPage = {
  readonly width: number
  readonly height: number
  readonly scrollX: number
  readonly scrollY: number
  readonly cursor: { readonly x: number; readonly y: number } | null
}

const CURSOR_HOST = "chromex-cursor"

/**
 * A hidden tab that repainted after mouse input can stop answering a capture (ISS-03). A 1 px
 * screencast keeps its frames produced for the capture; the capture is bounded either way.
 *
 * The CSS viewport, scroll position and cursor point come from one read in the same inspection,
 * before the capture, so the metadata describes what the image shows. `clean` hides the agent
 * cursor after that read and restores it even when the capture fails (REQ-12).
 */
async function screenshot(clean: boolean, send: Send): Promise<{ data: string; page: ScreenshotPage }> {
  try {
    const page = await pageFacts(clean, send)
    await send("Page.startScreencast", { format: "png", maxWidth: 1, maxHeight: 1 })
    const reply = await answered(
      send("Page.captureScreenshot", { captureBeyondViewport: false, format: "png" }),
      "Page.captureScreenshot",
      10_000,
    )
    const data = isFields(reply) && typeof reply.data === "string" ? reply.data : null
    if (!data) throw new Error("The screenshot returned no image")
    return { data, page }
  } finally {
    await send("Page.stopScreencast", {}).catch(() => undefined)
    if (clean) await restoreCursor(send)
  }
}

async function pageFacts(clean: boolean, send: Send): Promise<ScreenshotPage> {
  const reply = await evaluate(send, `(() => {
    const host = document.querySelector(${JSON.stringify(CURSOR_HOST)});
    const rect = host ? host.getBoundingClientRect() : null;
    ${clean ? "if (host) host.style.visibility = 'hidden';" : ""}
    return {
      width: innerWidth, height: innerHeight, scrollX, scrollY,
      cursor: rect ? { x: rect.x, y: rect.y } : null
    };
  })()`)
  if (isFields(reply) && reply.exceptionDetails !== undefined)
    throw new Error("The page refused the screenshot inspection")
  const value = isFields(reply) && isFields(reply.result) ? reply.result.value : null
  if (!isFields(value)) throw new Error("The screenshot inspection returned no page facts")
  const { width, height, scrollX, scrollY, cursor } = value
  if (typeof width !== "number" || typeof height !== "number" || typeof scrollX !== "number" || typeof scrollY !== "number")
    throw new Error("The screenshot inspection returned invalid page facts")
  return {
    width,
    height,
    scrollX,
    scrollY,
    cursor: isFields(cursor) && typeof cursor.x === "number" && typeof cursor.y === "number"
      ? { x: cursor.x, y: cursor.y }
      : null,
  }
}

async function restoreCursor(send: Send): Promise<void> {
  try {
    const reply = await evaluate(
      send,
      `(() => { const host = document.querySelector(${JSON.stringify(CURSOR_HOST)}); if (host) host.style.visibility = ""; })()`,
    )
    if (isFields(reply) && reply.exceptionDetails !== undefined) throw new Error("the page refused the restore")
  } catch(cause) {
    throw new Error("The agent cursor stays hidden after the clean capture; the next pointer call draws it again", { cause })
  }
}

async function measure(request: Extract<InspectRequest, { kind: "measure" }>, send: Send) {
  const page = await evaluate(send, `(() => {
    const facts = ${ELEMENT_FACTS};
    const styles = ${JSON.stringify(request.styles)};
    const root = document.documentElement;
    return {
      viewport: {width: innerWidth, height: innerHeight, devicePixelRatio,
        visual: window.visualViewport ? {width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale} : null},
      document: {clientWidth: root.clientWidth, clientHeight: root.clientHeight,
        scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight, scrollX, scrollY,
        overflowX: root.scrollWidth > root.clientWidth, overflowY: root.scrollHeight > root.clientHeight},
      focus: document.activeElement ? facts.call(document.activeElement, styles) : null,
      elements: ${JSON.stringify(request.selectors)}.map(selector => {
        const element = document.querySelector(selector);
        return {selector, element: element ? facts.call(element, styles) : null};
      })
    };
  })()`)
  if (request.nodes.length === 0) return { nodes: [], page }
  // A unique group: the controller and an inspector can share one page session.
  const objectGroup = `chromex-inspect-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const nodes: unknown[] = []
  try {
    for (const backendNodeId of request.nodes) {
      const resolved = await send("DOM.resolveNode", { backendNodeId, objectGroup })
      const objectId = isFields(resolved) && isFields(resolved.object) ? resolved.object.objectId : undefined
      if (typeof objectId !== "string") throw new Error("Element is no longer on the page")
      nodes.push(await send("Runtime.callFunctionOn", {
        arguments: [{ value: request.styles }],
        functionDeclaration: ELEMENT_FACTS,
        objectId,
        returnByValue: true,
      }))
    }
  } finally {
    // Only frees remote handles; a page that navigated meanwhile already dropped them.
    await send("Runtime.releaseObjectGroup", { objectGroup }).catch(() => undefined)
  }
  return { nodes, page }
}

function evaluate(send: Send, expression: string): Promise<unknown> {
  return send("Runtime.evaluate", { expression, returnByValue: true })
}

function list(value: unknown, valid: (item: unknown) => boolean): unknown[] | null {
  return Array.isArray(value) && value.length <= MAX_ITEMS && value.every(valid) ? value : null
}

function isFields(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
