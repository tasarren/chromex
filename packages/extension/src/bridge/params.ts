import { errorMessage, type InputOperation, type InspectRequest, type Point, type TabInfo } from "@chromex/protocol"
import type { GestureBinding, StepKind, StepRequest } from "../gesture-authority.ts"
import type { ConnectionApi, Listened } from "../native-connection.ts"
import { isRecord, nonnegativeInteger } from "../session-state.ts"

export type Tab = Pick<chrome.tabs.Tab, "active" | "id" | "pendingUrl" | "title" | "url" | "windowId">

export type Window = Pick<chrome.windows.Window, "id"> & { tabs?: Tab[] | undefined }
export type Target = { tabId: number }

/** The Chromium extension APIs the bridge uses; tests supply a typed fake of this shape. */
export type BridgeApi = ConnectionApi & {
  debugger: {
    attach(target: Target, requiredVersion: string): Promise<void>;
    detach(target: Target): Promise<void>;
    getTargets(): Promise<Pick<chrome.debugger.TargetInfo, "attached" | "id" | "tabId">[]>;
    sendCommand(target: Target, method: string, params?: Record<string, unknown>): Promise<unknown>;
    onDetach: Listened<typeof chrome.debugger.onDetach>;
    onEvent: Listened<typeof chrome.debugger.onEvent>;
  };
  runtime: ConnectionApi["runtime"] & {
    id: string;
    getManifest(): { version?: string };
    getURL(path: string): string;
    onMessage: Listened<typeof chrome.runtime.onMessage>;
  };
  storage: {
    session: {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  tabs: {
    create(properties: Parameters<typeof chrome.tabs.create>[0]): Promise<Tab>;
    get(tabId: number): Promise<Tab>;
    query(info: Parameters<typeof chrome.tabs.query>[0]): Promise<Tab[]>;
    remove(tabId: number): Promise<void>;
    update(tabId: number, properties: { active: boolean }): Promise<Tab | undefined>;
    onRemoved: Listened<typeof chrome.tabs.onRemoved>;
  };
  windows: {
    create(data: Parameters<typeof chrome.windows.create>[0]): Promise<Window | undefined>;
    get(windowId: number): Promise<unknown>;
    getAll(options?: chrome.windows.QueryOptions): Promise<Window[]>;
    onRemoved: {
      addListener(callback: (windowId: number) => void): void;
      // chrome-types 0.1.457 declares removeListener with the addListener(callback, filters)
      // signature. Chrome removes by the added callback, which this union also accepts.
      removeListener(
        callback:
          | ((windowId: number) => void)
          | Parameters<typeof chrome.windows.onRemoved.removeListener>[0],
      ): void;
    };
  };
}

/** A fence no request can pass; only a browser restart clears it. */
export type Fence = { done: () => void; promise: Promise<void>; token: string }

export type PipeKind = "input" | "cdp" | "profile"

/** Tab selected while another tab receives background input. */
export type BackgroundSelection = {
  helperCreated: boolean
  helperId: number
  /** Selected before the operation; may be another client's tab or the target itself. */
  previousTabId: number
  targetTabId: number
  windowId: number
}

/**
 * Pipe input for a leased `chrome://` tab. The reserving client names the tab and operation; the
 * Managed service begins it (`executor`), sends the commands over its browser pipe, and ends it.
 */
export type PipeInput = {
  /** Set when the executor is lost during admission; the in-flight begin must abort. */
  aborted: boolean
  client: string
  executor: string | null
  phase: "reserved" | "starting" | "running" | "orphaned"
  selection: BackgroundSelection | null
} & (
  | { kind: "input"; operation: InputOperation; profileOperation: null; tabId: number }
  | { kind: "cdp"; operation: InputOperation; profileOperation: null; tabId: number }
  | {
    kind: "profile";
    operation: null;
    profileOperation: Record<string, unknown>;
    tabId: null;
  }
)

export type OrphanedAdmission = { kind: PipeKind; tabId: number | null; token: string }

/**
 * A read of a pipe-driven tab: the controller at issue time must still lease it for every command.
 * A token begins at most once; `targetId` is set when its begin completes.
 */
export type PipeInspection = {
  binding: GestureBinding | null
  client: string
  controller: string
  owner: boolean
  phase: "issued" | "beginning" | "begun"
  request: InspectRequest
  tabId: number
  targetId: string | null
}

const INSPECTION_METHODS = new Set([
  "tabs.inspect",
  "tabs.uninspect",
  "cdp.inspect",
  "cdp.ownerInspect",
  "inspect.begin",
  "inspect.step",
  "inspect.end",
])

/**
 * Gesture authority calls. They never wait behind the queue or a pipe fence: refusals answer at
 * once, and status and cancellation stay reachable while a step or its storage write is stalled.
 * Only a native host built with gestures enabled forwards them; the shipped host refuses every one.
 */
const GESTURE_METHODS = new Set([
  "gesture.status",
  "gesture.reserve",
  "gesture.admit",
  "gesture.complete",
  "gesture.uncertain",
  "gesture.cancel",
  "gesture.bind",
  "gesture.edge",
  "gesture.invalidate",
])

/** Requests a closing browser still answers: diagnostics, departures and admitted pipe ends. */
const CLOSING_METHODS = new Set([
  "bridge.close",
  "bridge.status",
  "client.release",
  "client.status",
  "gesture.status",
  "input.end",
  "input.uncertain",
])
const CLOSING_MESSAGE = "Managed browser is closing"
/** Pending pipe reads one inspector may hold; older tokens are invalidated first. */
const MAX_PIPE_INSPECTIONS = 4
/** Pages the extension debugger cannot attach to; only these are read over the service pipe. */
const PIPE_URL = /^chrome(?:-untrusted|-extension)?:/iu

const ABORTED_ADMISSION = "Pipe input executor was lost during admission"

const STEP_KINDS = new Set<string>(["down", "move", "up"])
const MAX_STEP_ARGS = 4 * 1024

export function blockedFence(): Fence {
  return { done: () => {}, promise: new Promise<void>(() => {}), token: "recovery" }
}

export function pipeKindParam(params: unknown): PipeKind {
  const kind = isRecord(params) ? params.kind : undefined
  if (kind === undefined) return "input"
  if (kind === "input" || kind === "cdp" || kind === "profile") return kind
  throw new Error("Invalid pipe input kind")
}

export function readProfileOperation(params: unknown): Record<string, unknown> {
  if (!isRecord(params) || !isRecord(params.operation)) {
    throw new Error("Invalid profile operation")
  }
  const size = new TextEncoder().encode(JSON.stringify(params.operation)).byteLength
  if (size > 16 * 1024) throw new Error("Profile operation exceeds 16 KiB")
  return params.operation
}

export function parsePipeMarker(value: unknown): OrphanedAdmission | null {
  if (!isRecord(value) || typeof value.token !== "string" || value.token.length === 0) return null
  if (value.kind !== "input" && value.kind !== "cdp" && value.kind !== "profile") return null
  let tabId: number | null
  if (value.tabId === null) {
    tabId = null
  } else {
    const parsed = nonnegativeInteger(value.tabId)
    if (parsed === undefined) return null
    tabId = parsed
  }
  if (value.kind === "profile" ? tabId !== null : tabId === null) return null
  return { kind: value.kind, tabId, token: value.token }
}

export function isCleanDetachError(cause: unknown): boolean {
  return /not attached|not being debugged|no tab with id|no such tab|tab (?:was )?closed/i.test(
    errorMessage(cause),
  )
}

export function tabInfo(tab: Tab): TabInfo {
  if (tab.id === undefined) throw new Error("Chromium returned a tab without an ID")
  return {
    active: tab.active,
    id: tab.id,
    title: tab.title ?? "",
    url: tab.url ?? "",
    windowId: tab.windowId,
  }
}

export function clientId(params: unknown): string {
  if (!isRecord(params) || !("clientId" in params)) throw new Error("Missing broker client ID")
  const value = params.clientId
  if (typeof value !== "string" || value.length === 0) throw new Error("Invalid broker client ID")
  return value
}

export function tokenParam(params: unknown): string {
  const token = isRecord(params) ? params.token : undefined
  if (typeof token !== "string" || token.length === 0) throw new Error("Invalid pipe input token")
  return token
}

export function pointParam(params: unknown): Point | null {
  const point = isRecord(params) ? params.point : null
  if (point === null || point === undefined) return null
  if (!isRecord(point) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("Invalid pointer point")
  return { x: point.x as number, y: point.y as number }
}

/** The public step arguments as the owner sent them; the authority compares duplicates on these. */
export function readStepRequest(params: unknown, requireResolved = true): StepRequest {
  if (!isRecord(params)) throw new Error("Invalid pointer step")
  const { args = {}, contextId, gestureId = null, kind, sequence } = params
  if (typeof contextId !== "string" || contextId.length === 0) throw new Error("Invalid context ID")
  if (typeof kind !== "string" || !STEP_KINDS.has(kind)) throw new Error("Invalid pointer step kind")
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Invalid sequence")
  if (gestureId !== null && (typeof gestureId !== "string" || gestureId.length === 0)) throw new Error("Invalid gesture ID")
  if (!isRecord(args)) throw new Error("Invalid pointer step arguments")
  if (new TextEncoder().encode(JSON.stringify(args)).byteLength > MAX_STEP_ARGS) {
    throw new Error("Pointer step arguments exceed 4 KiB")
  }
  // Validate the public button/count/target before admission; these args remain the duplicate key.
  const button = args.button ?? "left"
  if (button !== "left" && button !== "right") throw new Error(`Unsupported mouse button ${JSON.stringify(button)}`)
  if (args.clickCount !== undefined && args.clickCount !== 1 && args.clickCount !== 2) throw new Error("Invalid click count")
  const publicTarget = isRecord(args.target) ? args.target : null
  const publicRef = publicTarget !== null && Object.keys(publicTarget).length === 1 && typeof publicTarget.ref === "string"
  const publicPoint = publicTarget !== null && Object.keys(publicTarget).length === 2 &&
    Number.isFinite(publicTarget.x) && Number.isFinite(publicTarget.y)
  const flatPoint = Number.isFinite(args.x) && Number.isFinite(args.y)
  if ([publicRef, publicPoint, flatPoint].filter(Boolean).length > 1) {
    throw new Error("Provide exactly one of ref or {x, y}.")
  }
  if (kind !== "up" && !publicRef && !publicPoint && !flatPoint) {
    throw new Error("A pointer step needs exactly one ref or one complete finite {x, y}")
  }
  const rawResolved = isRecord(params) && isRecord(params.resolvedTarget) ? params.resolvedTarget : null
  const resolved = rawResolved !== null && Object.keys(rawResolved).length === 1 &&
    typeof rawResolved.backendNodeId === "number"
    ? { target: { backendNodeId: rawResolved.backendNodeId } }
    : rawResolved !== null && Object.keys(rawResolved).length === 2 &&
        Number.isFinite(rawResolved.x) && Number.isFinite(rawResolved.y)
      ? { target: { x: rawResolved.x as number, y: rawResolved.y as number } }
      : publicPoint
        ? { target: { x: publicTarget.x as number, y: publicTarget.y as number } }
        : flatPoint
          ? { target: { x: args.x as number, y: args.y as number } }
          : publicTarget !== null && typeof publicTarget.backendNodeId === "number" &&
              Object.keys(publicTarget).length === 1
            ? { target: { backendNodeId: publicTarget.backendNodeId } }
            : null
  if (requireResolved && kind !== "up" && resolved === null) throw new Error("A pointer step needs one resolved target")
  return { args, button, contextId, gestureId, kind: kind as StepKind, ...(resolved === null ? {} : { resolved }), sequence }
}

export function numberParam(params: unknown, key: string): number {
  if (!isRecord(params)) throw new Error(`Missing ${key}`)
  const value = nonnegativeInteger(params[key])
  if (value === undefined) throw new Error(`Invalid ${key}`)
  return value
}

export {
  ABORTED_ADMISSION,
  CLOSING_MESSAGE,
  CLOSING_METHODS,
  GESTURE_METHODS,
  INSPECTION_METHODS,
  MAX_PIPE_INSPECTIONS,
  PIPE_URL,
}
