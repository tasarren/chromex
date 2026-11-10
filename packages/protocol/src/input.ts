// Input executor: runs CDP input commands on a tab and always releases held input.

import { AgentCursor, easedPath } from "./cursor.ts"
import type { Point } from "./pointer.ts"
import { errorMessage, isObject } from "./rpc.ts"

/** One CDP input command; `input.run` carries a list of these. */
export type InputCommand = { method: string; params: Record<string, unknown> }

type Send = (method: string, params: Record<string, unknown>) => Promise<unknown>

/**
 * Send input commands in order. A mouse button or key counts as held from the moment its press is
 * sent, because a failed response does not prove the press was not delivered. Every held input is
 * released afterwards through `release`; presses are never replayed. A failed release is reported.
 */
async function sendInput(commands: InputCommand[], send: Send, cursor: AgentCursor | null): Promise<unknown[]> {
  const held = new Map<string, InputCommand>()
  return await withCleanup(
    async() => {
      const results: unknown[] = []
      for (const command of commands) {
        const hold = holdOf(command)
        if (hold?.pressed === true) held.set(hold.id, hold.release)
        results.push(await send(command.method, command.params))
        if (hold?.pressed === false) held.delete(hold.id)
        // Only a confirmed dispatch moves the cursor; a failed draw stops the remaining input.
        const point = cursor ? pointOf(command) : null
        if (cursor && point) await cursor.draw(point, held.size > 0)
      }
      return results
    },
    () => releaseHeld(held, send),
  )
}

/** The viewport point of a positioned mouse command; wheel input is not a pointer point. */
function pointOf(command: InputCommand): Point | null {
  const { params } = command
  if (command.method !== "Input.dispatchMouseEvent" || params.type === "mouseWheel") return null
  return typeof params.x === "number" && typeof params.y === "number" ? { x: params.x, y: params.y } : null
}

/** A field to focus, and optionally empty, before typing into it. */
export type FieldFocus = { backendNodeId: number; clear: boolean }

/** One input operation: an optional field to focus first, then the input commands. */
export type InputOperation = { commands: InputCommand[]; field?: FieldFocus | undefined }

/**
 * Run one input operation on a tab that is not the selected tab of its window. Focus emulation lets
 * the hidden tab accept trusted input without Chromium activating the window. A field is focused and
 * cleared only here, after the operation was accepted, so a refused operation never edits the page.
 * `cleanup` sends releases and the emulation reset; it must not depend on `send` still being allowed.
 */
export async function runInput(operation: InputOperation, send: Send, showCursor: boolean): Promise<unknown[]> {
  const target = operation.commands.map(pointOf).find((point) => point !== null)
  const cursor = showCursor && target ? new AgentCursor(send) : null
  // Refuse before any input or focus change when the cursor cannot be shown (DEC-67).
  const from = cursor ? await cursor.ensure() : null
  return await withCleanup(
    async() => {
      await send("Emulation.setFocusEmulationEnabled", { enabled: true })
      // Give the renderer a frame to observe emulated focus before input arrives.
      await new Promise((resolve) => setTimeout(resolve, 50))
      if (operation.field) await focusField(operation.field, send)
      // Real unheld travel from the last confirmed point, ending on the target like a real pointer.
      const travel = cursor && target ? easedPath(from, target) : []
      const moves = travel.map((point) => ({ method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", ...point, button: "none", buttons: 0 } }))
      const results = (await sendInput([...moves, ...operation.commands], send, cursor)).slice(moves.length)
      // Chromium scrolls a wheel on a later frame; turning emulation off at once drops the scroll.
      if (hasWheel(operation)) await send(AFTER_FRAMES.method, AFTER_FRAMES.params)
      return results
    },
    () => send("Emulation.setFocusEmulationEnabled", { enabled: false }),
  )
}

/** Wheel input scrolls only in a tab that was selected at least once before it, so it needs one. */
export function hasWheel(operation: InputOperation): boolean {
  return operation.commands.some(
    (command) =>
      command.method === "Input.dispatchMouseEvent" && command.params.type === "mouseWheel",
  )
}

/** Two animation frames in the page, bounded by a timer if frames do not run. */
const AFTER_FRAMES: InputCommand = {
  method: "Runtime.evaluate",
  params: {
    awaitPromise: true,
    expression:
      "new Promise((done) => { requestAnimationFrame(() => requestAnimationFrame(done)); setTimeout(done, 500) })",
  },
}

async function focusField(field: FieldFocus, send: Send): Promise<void> {
  const resolved = await send("DOM.resolveNode", { backendNodeId: field.backendNodeId })
  const object = isObject(resolved) && isObject(resolved.object) ? resolved.object : null
  if (typeof object?.objectId !== "string") throw new Error("Element is no longer on the page")
  await send("Runtime.callFunctionOn", {
    arguments: [{ value: field.clear }],
    functionDeclaration: "function(clear){this.focus(); if (clear && 'value' in this) this.value='';}",
    objectId: object.objectId,
  })
}

/** The press/release pair a command belongs to, and the command that releases it. */
function holdOf(command: InputCommand): { id: string; pressed: boolean; release: InputCommand } | null {
  const { params } = command
  switch (`${command.method}:${String(params.type)}`) {
    case "Input.dispatchMouseEvent:mousePressed":
    case "Input.dispatchMouseEvent:mouseReleased":
      return {
        id: `mouse:${String(params.button)}`,
        pressed: params.type === "mousePressed",
        release: { method: command.method, params: { ...params, type: "mouseReleased" } },
      }
    case "Input.dispatchKeyEvent:keyDown":
    case "Input.dispatchKeyEvent:rawKeyDown":
    case "Input.dispatchKeyEvent:keyUp":
      return {
        id: `key:${String(params.code ?? params.key)}`,
        pressed: params.type !== "keyUp",
        release: { method: command.method, params: { ...params, text: undefined, type: "keyUp" } },
      }
    default:
      return null
  }
}

async function releaseHeld(held: Map<string, InputCommand>, send: Send): Promise<void> {
  const failures: unknown[] = []
  for (const release of held.values()) {
    await send(release.method, release.params).catch((cause: unknown) => failures.push(cause))
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Input release failed: ${failures.map(errorMessage).join("; ")}`)
  }
}

/**
 * Run `action`, then every cleanup step in order even when earlier steps fail. The action's error
 * stays first; cleanup failures are added to it, never dropped, so a caller cannot report full
 * restoration that did not happen.
 */
export async function withCleanup<T>(
  action: () => Promise<T>,
  ...cleanup: (() => Promise<unknown>)[]
): Promise<T> {
  let failure: { cause: unknown } | null = null
  let result: T | undefined
  try {
    result = await action()
  } catch(cause) {
    failure = { cause }
  }
  const cleanupFailures: unknown[] = []
  for (const step of cleanup) {
    await step().catch((cause: unknown) => cleanupFailures.push(cause))
  }
  if (cleanupFailures.length > 0) {
    const errors = failure ? [failure.cause, ...cleanupFailures] : cleanupFailures
    const lead = failure ? `${errorMessage(failure.cause)}; cleanup also failed: ` : "Cleanup failed: "
    throw new AggregateError(errors, lead + cleanupFailures.map(errorMessage).join("; "))
  }
  if (failure) throw failure.cause
  return result as T
}
