import type { DocumentIdentity } from "@chromex/protocol"
import { isRecord, nonnegativeInteger } from "./session-state.ts"
import {
  type Gesture,
  type GestureBinding,
  GestureRefusal,
  type GesturePhase,
  type GestureView,
  RefusalCode,
  type Step,
  type StepReceipt,
  type StepRequest,
} from "./gesture-authority.ts"

/** Session-storage key of the one retained gesture. */
export const GESTURE_KEY = "bridgeGesture"

export type GestureStorage = {
  get(keys: string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

export type StoredGesture = Pick<Gesture, "binding" | "button" | "cancelRequested" | "deadline" | "id" | "phase" | "pressed" | "standalone">

export function view(gesture: Gesture): GestureView {
  return {
    button: gesture.button,
    cancelRequested: gesture.cancelRequested,
    deadline: gesture.deadline,
    gestureId: gesture.id,
    outcome: gesture.outcome,
    owner: gesture.binding.owner,
    phase: gesture.phase,
    pressed: gesture.pressed,
    stepInFlight: gesture.step !== null && gesture.step.kind !== "cancel",
    tabId: gesture.binding.tabId,
    warning: gesture.warning,
  }
}

export function outcomeOf(gesture: Gesture, step: Step): StepReceipt["outcome"] {
  if (step.phase !== "done") return "pending"
  switch (gesture.phase) {
    case "terminal":
      return gesture.outcome ?? "not-dispatched"
    case "cancelling":
      return "cancelling"
    case "starting":
    case "held":
    case "executing":
    case "ending":
      return "held"
  }
}

export function mismatch(sequence: number): GestureRefusal {
  return new GestureRefusal(RefusalCode.Mismatch, `Sequence ${sequence} was admitted with different arguments`)
}

export function sameBinding(a: GestureBinding, b: GestureBinding): boolean {
  return a.owner === b.owner && a.tabId === b.tabId && a.documentEpoch === b.documentEpoch &&
    a.attachmentEpoch === b.attachmentEpoch && a.generation === b.generation && a.executor === b.executor &&
    a.sessionId === b.sessionId && a.targetId === b.targetId &&
    a.document.frameId === b.document.frameId && a.document.loaderId === b.document.loaderId
}

function parseDocument(value: unknown, epoch: number): DocumentIdentity | null {
  if (!isRecord(value)) return { epoch, frameId: "", loaderId: "" }
  if (typeof value.frameId !== "string" || typeof value.loaderId !== "string") return null
  return { epoch, frameId: value.frameId, loaderId: value.loaderId }
}

/** Sorted-key JSON of the public arguments, so equal requests compare equal in any property order. */
export function stepKey(request: StepRequest): string {
  return JSON.stringify({ args: request.args, gestureId: request.gestureId, kind: request.kind }, (_key, entry: unknown) =>
    isRecord(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry,
  )
}

const PHASES = new Set<string>(["starting", "held", "executing", "ending", "cancelling", "terminal", "uncertain"])
const TERMINAL_OUTCOMES = new Set<unknown>(["released", "cancelled", "moved", "not-dispatched"])

export function parseRecord(value: unknown): StoredGesture | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.binding)) return null
  const { binding } = value
  const tabId = nonnegativeInteger(binding.tabId)
  const generation = nonnegativeInteger(binding.generation)
  const documentEpoch = nonnegativeInteger(binding.documentEpoch)
  const attachmentEpoch = nonnegativeInteger(binding.attachmentEpoch) ?? 0
  const document = documentEpoch === undefined ? null : parseDocument(binding.document, documentEpoch)
  const deadline = nonnegativeInteger(value.deadline)
  if (
    typeof value.gestureId !== "string" || value.gestureId.length === 0 || typeof binding.owner !== "string" ||
    typeof binding.executor !== "string" || document === null ||
    tabId === undefined || generation === undefined || documentEpoch === undefined || deadline === undefined ||
    typeof value.cancelRequested !== "boolean" || typeof value.pressed !== "boolean" ||
    (value.button !== undefined && value.button !== "left" && value.button !== "right") ||
    typeof value.phase !== "string" || !PHASES.has(value.phase) ||
    (value.step !== null && !isRecord(value.step))
  ) return null
  // A finished gesture is ignored only when the record is coherent: released, nothing pending.
  if (value.phase === "terminal" && (value.pressed || value.step !== null || !TERMINAL_OUTCOMES.has(value.outcome))) {
    return null
  }
  return {
    binding: {
      attachmentEpoch,
      document,
      documentEpoch,
      executor: binding.executor,
      generation,
      owner: binding.owner,
      sessionId: typeof binding.sessionId === "string" ? binding.sessionId : null,
      tabId,
      targetId: typeof binding.targetId === "string" ? binding.targetId : null,
    },
    button: value.button === "right" ? "right" : "left",
    cancelRequested: value.cancelRequested,
    deadline,
    id: value.gestureId,
    phase: value.phase === "uncertain" ? "cancelling" : value.phase as GesturePhase,
    pressed: value.pressed,
    standalone: value.standalone === true,
  }
}
