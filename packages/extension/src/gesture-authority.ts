import { type DocumentIdentity, errorMessage, type Point, type PointerTarget } from "@chromex/protocol"
import {
  GESTURE_KEY,
  type GestureStorage,
  mismatch,
  outcomeOf,
  parseRecord,
  sameBinding,
  stepKey,
  view,
} from "./gesture-storage.ts"

/** Owner movement and inspection renew this idle deadline; status never does. */
export const GESTURE_IDLE_MS = 120_000
const CLEANUP_TIMEOUT_MS = 10_000

export type StepKind = "down" | "move" | "up"

/** The page a context is issued for. The bridge derives every field from its own state. */
export type GestureBinding = {
  /** Debugger attachment generation, so a detach/reattach cannot revive an old context. */
  readonly attachmentEpoch: number
  /** The main-frame document captured before this context became usable. */
  readonly document: DocumentIdentity
  readonly documentEpoch: number
  /** The one executor that may run this context's steps, fixed when the context is issued. */
  readonly executor: string
  readonly generation: number
  readonly owner: string
  /** Pipe executor identity; null for the extension worker. */
  readonly sessionId: string | null
  readonly tabId: number
  readonly targetId: string | null
}

/** The extension worker's own executor; no client ID can name it. */
export function workerExecutor(generation: number): string {
  return `worker:${generation}`
}

/** The service executor of one authenticated host session; a reconnect gets a new generation. */
export function serviceExecutor(clientId: string, generation: number): string {
  return `service:${generation}:${clientId}`
}

function viaHost(executor: string): boolean {
  return executor.startsWith("service:")
}

export type GesturePhase = "starting" | "held" | "executing" | "ending" | "cancelling" | "terminal"
export type GestureOutcome = "released" | "cancelled" | "moved" | "not-dispatched"

export type StepRequest = {
  readonly args: Readonly<Record<string, unknown>>
  /** Validated public button, when the caller supplied it. */
  readonly button?: "left" | "right"
  readonly contextId: string
  /** Required for held move and up; null for down and an unheld move. */
  readonly gestureId: string | null
  readonly kind: StepKind
  /** The executor target resolved after the public arguments were validated. */
  readonly resolved?: { readonly target: PointerTarget }
  readonly sequence: number
}

/** The owner's answer for one step. `token` names the step for its executor while it is pending. */
export type StepReceipt = {
  readonly gestureId: string
  readonly kind: StepKind
  readonly outcome: "pending" | "held" | "cancelling" | GestureOutcome
  /** The confirmed endpoint, retained so an exact retry returns the same answer. */
  readonly point: Point | null
  readonly sequence: number
  readonly token: string
  /** The executor's reason, retained for an exact retry. */
  readonly warning: string | null
}

/** What the original executor is admitted to send, including cancellation's release. */
export type AdmittedStep = {
  readonly args: Readonly<Record<string, unknown>>
  readonly gestureId: string
  readonly kind: StepKind | "cancel"
  readonly document: DocumentIdentity
  readonly sequence: number
  /** The bound tab, so the executor sends only to the gesture's own page. */
  readonly sessionId: string | null
  readonly standalone: boolean
  readonly tabId: number
  readonly targetId: string | null
}

export type GestureView = {
  /** Public button held by this gesture, so a status line can name it without reading the step. */
  readonly button: "left" | "right"
  readonly cancelRequested: boolean
  readonly deadline: number
  readonly gestureId: string
  readonly outcome: GestureOutcome | null
  readonly owner: string
  readonly phase: GesturePhase
  /** A press may have reached the page and no release or cleanup is confirmed. */
  readonly pressed: boolean
  readonly stepInFlight: boolean
  readonly tabId: number
  /** What the executor sent, or why it could not confirm delivery. */
  readonly warning: string | null
}

export const RefusalCode = {
  Blocked: "GESTURE_BLOCKED",
  Busy: "POINTER_BUSY",
  Expired: "GESTURE_EXPIRED",
  Foreign: "GESTURE_FOREIGN",
  Mismatch: "SEQUENCE_MISMATCH",
  NoGesture: "NO_GESTURE",
  OutOfOrder: "SEQUENCE_OUT_OF_ORDER",
  Reserved: "GESTURE_RESERVED",
  StaleContext: "STALE_CONTEXT",
  StaleSequence: "SEQUENCE_STALE",
  Storage: "GESTURE_STORAGE",
  UnknownStep: "UNKNOWN_STEP",
} as const
export type RefusalCode = (typeof RefusalCode)[keyof typeof RefusalCode]

/** A refusal before any effect: no sequence was consumed and nothing was admitted. */
export class GestureRefusal extends Error {
  override name = "GestureRefusal"
  readonly code: RefusalCode

  constructor(code: RefusalCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

/** True while the binding still names the current lease holder, generation and document. */
export type BindingCheck = (binding: GestureBinding) => boolean

type Context = {
  readonly binding: GestureBinding
  readonly id: string
  /** The most recent step of this context, kept for exact duplicates. */
  last: { readonly gesture: Gesture; readonly key: string; readonly step: Step; readonly stored: Promise<StepReceipt> } | null
  nextSequence: number
}

export type Step = {
  readonly args: Readonly<Record<string, unknown>>
  readonly kind: StepKind | "cancel"
  /** `settling`: the executor answered and the resulting state is being written. */
  phase: "storing" | "reserved" | "dispatching" | "settling" | "done"
  /** Fixed once the step settled and its write finished; a duplicate after that returns exactly this. */
  result: StepReceipt | null
  /** The confirmed endpoint, or null when the step did not confirm one. */
  point: Point | null
  /** The executor reported that it sent nothing. */
  sentNothing: boolean
  /** While `settling`: the receipt the executor and exact duplicates receive once the write ends. */
  settled: Promise<StepReceipt> | null
  /** The executor's reason, retained for an exact retry. */
  warning: string | null
  /** Resolved only after the public args passed validation; never part of the duplicate key. */
  readonly resolved: { readonly target: PointerTarget } | null
  readonly sequence: number
  readonly token: string
}

/** The runtime gesture state and its executor-local completion promise. */
export type Gesture = {
  readonly binding: GestureBinding
  readonly button: "left" | "right"
  cancelRequested: boolean
  readonly contextId: string | null
  deadline: number
  readonly id: string
  outcome: GestureOutcome | null
  phase: GesturePhase
  pressed: boolean
  /** One unheld move; it owns no button and leaves no reservation after its answer. */
  readonly standalone: boolean
  step: Step | null
  warning: string | null
  readonly done: Promise<void>
  readonly resolveDone: () => void
}

/**
 * Admits one held gesture per browser and keeps its reservation between calls. The owner reserves
 * each step under an issued context and sequence; its intent is stored before the executor can
 * admit it, and the executor reports the outcome. Every refusal is synchronous, so a concurrent
 * step answers POINTER_BUSY instead of waiting. Cancellation releases through the original executor.
 * ponytail: one gesture per browser (owner choice); per-tab concurrency would key `gesture` by tab.
 */
export class GestureAuthority {
  private readonly storage: GestureStorage
  private readonly now: () => number
  private readonly contexts = new Map<string, Context>()
  private gesture: Gesture | null = null
  private writes: Promise<void> = Promise.resolve()
  private readonly offer: (executor: string) => void
  private readonly ended: (binding: GestureBinding, gestureId: string) => void
  private readonly cancelling: (executor: string, gestureId: string) => void
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private cleanupTimer: ReturnType<typeof setTimeout> | undefined

  /** `offer` delivers a stored cleanup offer to the gesture's own executor. */
  constructor(deps: { now: () => number; offer?: (executor: string) => void; ended?: (binding: GestureBinding, gestureId: string) => void; cancelling?: (executor: string, gestureId: string) => void; storage: GestureStorage }) {
    this.storage = deps.storage
    this.now = deps.now
    this.offer = deps.offer ?? (() => {})
    this.ended = deps.ended ?? (() => {})
    this.cancelling = deps.cancelling ?? (() => {})
  }

  /** A restarted worker has no executor-local pointer state. Clear its reservation, never replay. */
  async restore(): Promise<void> {
    try {
      const stored = (await this.storage.get([GESTURE_KEY]))[GESTURE_KEY]
      if (stored === undefined || stored === null) return
      const record = parseRecord(stored)
      if (!record) return
      // A standalone move owns no button, so a lost record cannot hide a held press.
      if (record.phase === "terminal" || record.standalone) return
      // Delivery cannot be reconstructed from stored intent; report no release instead of replaying.
      this.gesture = {
        ...record,
        ...completion(),
        contextId: null,
        outcome: "cancelled",
        phase: "terminal",
        pressed: false,
        step: null,
        warning: "The bridge restarted and lost its pointer executor state; no release was sent",
      }
      this.gesture.resolveDone()
      await this.persist(this.gesture)
    } catch {
      // No executor state survives restart; unreadable storage must not reserve the browser forever.
    }
  }

  /** Why legacy input must wait: a reservation that is not terminal. */
  conflict(): string | null {
    const gesture = this.reservation()
    if (!gesture) return null
    return gesture.phase === "terminal"
      ? `A pointer gesture on tab ${gesture.tabId} is still storing its outcome; retry shortly`
      : `A pointer gesture is ${gesture.phase} on tab ${gesture.tabId}; cancel it first`
  }

  /** The gesture keeps its tab until it is terminal and no step of it is still writing its answer. */
  reservation(): GestureView | null {
    const gesture = this.gesture
    return gesture && (gesture.phase !== "terminal" || gesture.step !== null) ? view(gesture) : null
  }

  /** A reserved gesture keeps its tab's lease and debugger until cleanup settles. */
  holds(tabId: number): boolean {
    return this.reservation()?.tabId === tabId
  }

  /** The live context for this binding, issuing a new one that makes older contexts of the tab stale. */
  issue(binding: GestureBinding): { contextId: string; nextSequence: number } {
    for (const context of this.contexts.values()) {
      if (context.binding.tabId !== binding.tabId) continue
      if (sameBinding(context.binding, binding)) return { contextId: context.id, nextSequence: context.nextSequence }
      this.contexts.delete(context.id)
    }
    const context: Context = { binding, id: crypto.randomUUID(), last: null, nextSequence: 1 }
    this.contexts.set(context.id, context)
    return { contextId: context.id, nextSequence: 1 }
  }

  /**
   * The tab's document, lease or access changed: every context issued for it is stale and dropped.
   * A gesture keeps its own binding, so its cancel and cleanup stay reachable.
   */
  invalidateTab(tabId: number): void {
    for (const context of this.contexts.values()) {
      if (context.binding.tabId === tabId) this.contexts.delete(context.id)
    }
  }

  /** Status for one caller: the owner's gesture, or for its executor the gesture and its cleanup offer. */
  status(client: string, executor: string | null): { activeCleanup: string | null; cleanup: string | null; gesture: GestureView | null; held: "left" | "right" | null; reserved: boolean } {
    const gesture = this.gesture
    const isExecutor = executor !== null && gesture?.binding.executor === executor
    const visible = gesture && (gesture.binding.owner === client || isExecutor) ? gesture : null
    const cleanup = isExecutor && visible?.step?.kind === "cancel" && visible.step.phase === "reserved" ? visible.step.token : null
    const activeCleanup = isExecutor && visible?.step?.kind === "cancel" && visible.step.phase === "dispatching" ? visible.step.token : cleanup
    const held = visible !== null && visible.pressed ? visible.button : null
    return { activeCleanup, cleanup, gesture: visible && view(visible), held, reserved: this.reservation() !== null }
  }

  /** The still-valid context of a live hold, so status does not reissue it against a replacement. */
  contextFor(client: string, executor: string | null): { contextId: string; nextSequence: number } | null {
    const gesture = this.gesture
    if (!gesture || gesture.standalone || gesture.phase === "terminal") return null
    if (gesture.binding.owner !== client && (executor === null || gesture.binding.executor !== executor)) return null
    const context = gesture.contextId === null ? null : this.contexts.get(gesture.contextId)
    return context ? { contextId: context.id, nextSequence: context.nextSequence } : null
  }

  /** The executor of one named gesture, so cancellation can reach a service executor. */
  executorForGesture(gestureId: string): string | null {
    return this.gesture?.id === gestureId ? this.gesture.binding.executor : null
  }

  /** Bind owner reads to the held page, not a newly attached replacement. */
  inspectionBinding(owner: string, tabId: number, current: BindingCheck): GestureBinding | null {
    const gesture = this.gesture
    if (!gesture || gesture.phase === "terminal" || gesture.standalone || gesture.binding.tabId !== tabId) return null
    if (gesture.binding.owner !== owner) throw new GestureRefusal(RefusalCode.Foreign, "The gesture belongs to another client")
    if (!current(gesture.binding)) throw new GestureRefusal(RefusalCode.StaleContext, "The held page document or session changed")
    if (this.now() >= gesture.deadline) {
      void this.latchCancel(gesture)
      throw new GestureRefusal(RefusalCode.Expired, "The gesture expired before inspection")
    }
    return gesture.binding
  }

  async renew(owner: string, tabId: number, current: BindingCheck): Promise<GestureBinding | null> {
    const binding = this.inspectionBinding(owner, tabId, current)
    const gesture = this.gesture
    if (binding && gesture && !gesture.cancelRequested) {
      gesture.deadline = this.now() + GESTURE_IDLE_MS
      this.armIdle(gesture)
      await this.persist(gesture)
    }
    return binding
  }

  stop(): void {
    clearTimeout(this.idleTimer)
    clearTimeout(this.cleanupTimer)
  }

  /** The bound executor of the live gesture, so the bridge can run a worker step or offer its cleanup. */
  pendingStep(): { executor: string; kind: StepKind | "cancel"; token: string } | null {
    const step = this.gesture?.step
    return this.gesture && step?.phase === "reserved"
      ? { executor: this.gesture.binding.executor, kind: step.kind, token: step.token }
      : null
  }

  /**
   * Reserve one step for the owner. Duplicates are compared on the public arguments before any
   * other check; the intent is stored before the step can be admitted. A failed write consumes no
   * sequence and leaves no step.
   */
  async reserve(owner: string, request: StepRequest, current: BindingCheck): Promise<StepReceipt> {
    // Every check runs before the first await, so a concurrent call already sees this step.
    const context = this.checkedContext(owner, request, current)
    const key = stepKey(request)
    const retained = this.retained(context, request)
    if (retained !== null) return await retained
    if (request.sequence < context.nextSequence) {
      throw new GestureRefusal(RefusalCode.StaleSequence, `Sequence ${request.sequence} is no longer retained`)
    }
    if (request.sequence > context.nextSequence) {
      throw new GestureRefusal(RefusalCode.OutOfOrder, `Expected sequence ${context.nextSequence}, got ${request.sequence}`)
    }
    if (this.gesture?.step) throw new GestureRefusal(RefusalCode.Busy, "Another pointer step is running")
    const gesture = this.gestureFor(context, request)
    const step: Step = {
      args: request.args,
      kind: request.kind,
      phase: "storing",
      point: null,
      result: null,
      resolved: request.resolved ?? null,
      sentNothing: false,
      sequence: request.sequence,
      settled: null,
      token: crypto.randomUUID(),
      warning: null,
    }
    return await this.store(context, gesture, step, key)
  }

  private checkedContext(owner: string, request: StepRequest, current: BindingCheck): Context {
    const context = this.contexts.get(request.contextId)
    if (!context || !current(context.binding)) {
      throw new GestureRefusal(RefusalCode.StaleContext, "The page context changed; read status for a new context")
    }
    if (context.binding.owner !== owner) throw new GestureRefusal(RefusalCode.Foreign, "The context belongs to another client")
    return context
  }

  /** The retained answer for an exact duplicate, or null when the sequence is new here. */
  private retained(context: Context, request: StepRequest): StepReceipt | Promise<StepReceipt> | null {
    const last = context.last
    if (last?.step.sequence !== request.sequence) return null
    if (last.key !== stepKey(request)) throw mismatch(request.sequence)
    if (last.step.phase === "storing") return last.stored
    if (last.step.settled) return last.step.settled
    return last.step.result ?? this.receipt(last.gesture, last.step)
  }

  /** The executor confirms the step was answered, or that it sent nothing. */
  async complete(executor: string, token: string, dispatched: boolean, point: Point | null = null, warning: string | null = null): Promise<StepReceipt> {
    return await this.finish(this.running(executor, token), dispatched ? "confirmed" : "not-dispatched", point, warning)
  }
  /** The executor bound when the context was issued takes a stored step; no other caller can. */
  admit(executor: string, token: string, current: BindingCheck): AdmittedStep {
    const gesture = this.gesture
    const step = gesture?.step
    if (!gesture || step?.token !== token || step.phase !== "reserved") {
      throw new GestureRefusal(RefusalCode.UnknownStep, "Pointer step is not reserved or already began")
    }
    if (gesture.binding.executor !== executor) {
      throw new GestureRefusal(RefusalCode.Foreign, "The gesture has another executor")
    }
    // Cleanup is for the original gesture and stays admissible after its context goes stale or expires.
    if (step.kind !== "cancel" && !current(gesture.binding)) {
      throw new GestureRefusal(RefusalCode.StaleContext, "The page context changed before the step began")
    }
    if (step.kind !== "cancel" && this.now() >= gesture.deadline) {
      // Nothing was sent: the step is withdrawn, and a down that never pressed ends.
      if (gesture.step === step) gesture.step = null
      step.sentNothing = true
      if (gesture.pressed) gesture.phase = "held"
      else {
        gesture.phase = "terminal"
        gesture.outcome = "not-dispatched"
      }
      this.settleStep(gesture, step)
      void this.persist(gesture).catch(() => undefined)
      if (gesture.pressed) void this.latchCancel(gesture)
      throw new GestureRefusal(RefusalCode.Expired, "The gesture expired before the step began")
    }
    step.phase = "dispatching"
    if (step.kind === "down") gesture.pressed = true
    return {
      args: { ...step.args, ...(step.resolved ?? {}), button: gesture.button },
      document: gesture.binding.document,
      gestureId: gesture.id,
      kind: step.kind,
      sequence: step.sequence,
      sessionId: gesture.binding.sessionId,
      standalone: gesture.standalone,
      tabId: gesture.binding.tabId,
      targetId: gesture.binding.targetId,
    }
  }

  /** An unknown step stops admission and offers release through the same executor. */
  async uncertain(executor: string, token: string, warning: string | null = null, point: Point | null = null): Promise<StepReceipt> {
    const running = this.running(executor, token)
    running.gesture.warning = warning
    return await this.finish(running, "uncertain", point, warning)
  }

  /** A replacement ends this reservation without sending release to the new document. */
  async documentLost(tabId: number, warning: string): Promise<void> {
    this.invalidateTab(tabId)
    const gesture = this.gesture
    if (!gesture || gesture.phase === "terminal" || gesture.binding.tabId !== tabId) return
    gesture.warning = `${warning} No release was sent to the replacement document.`
    await this.terminate(gesture, gesture.standalone ? "not-dispatched" : "cancelled")
  }

  /**
   * Latch cancellation of the owner's held gesture. Without an ID it resolves the caller's live
   * gesture; a public cancel therefore needs no authority handle. It needs no context or sequence,
   * coalesces with an earlier request. A running step settles first; the answer waits for bounded
   * cleanup. Returns null when the caller holds nothing, so the tool can answer a no-op line.
   */
  cancel(owner: string, gestureId?: string): Promise<GestureView | null> {
    const gesture = this.gesture
    if (!gesture || gesture.standalone) return Promise.resolve(null)
    if (gesture.phase === "terminal") {
      if (gesture.step?.phase === "settling") this.settleStep(gesture, gesture.step)
      return Promise.resolve(null)
    }
    if (gestureId !== undefined && gesture.id !== gestureId) return Promise.reject(new GestureRefusal(RefusalCode.NoGesture, `Unknown gesture ${gestureId}`))
    if (gesture.binding.owner !== owner) {
      return Promise.reject(new GestureRefusal(RefusalCode.Foreign, "The gesture belongs to another client"))
    }
    void this.latchCancel(gesture)
    return gesture.done.then(() => view(gesture))
  }

  /** Owner loss releases immediately; executor loss clears without claiming a release. */
  async clientLost(client: string | null, executor: string | null = null): Promise<void> {
    const gesture = this.gesture
    if (!gesture) return
    if (gesture.phase === "terminal") {
      if (gesture.step?.phase === "settling") this.settleStep(gesture, gesture.step)
      return
    }
    // A standalone move has no held button, so an executor loss is not an unresolved hold.
    if (gesture.standalone) {
      await this.terminate(gesture, "not-dispatched")
      return
    }
    // The host carries every service executor; the worker executor is lost only with the worker itself.
    const executorLost = client === null ? viaHost(gesture.binding.executor) : gesture.binding.executor === executor
    if (executorLost) {
      gesture.warning = "The original pointer executor disconnected; no release was sent"
      await this.terminate(gesture, "cancelled")
    } else if (client === null || gesture.binding.owner === client) {
      await this.cancel(gesture.binding.owner, gesture.id)
    }
  }

  /** A closed or detached target cannot receive its original executor's release. */
  async targetLost(tabId: number): Promise<void> {
    this.invalidateTab(tabId)
    const gesture = this.gesture
    if (!gesture || gesture.phase === "terminal" || gesture.binding.tabId !== tabId) return
    gesture.warning = "The pointer target closed or detached; no release was sent"
    await this.terminate(gesture, gesture.pressed ? "cancelled" : "not-dispatched")
  }

  private gestureFor(context: Context, request: StepRequest): Gesture {
    const live = this.gesture && this.gesture.phase !== "terminal" ? this.gesture : null
    if (request.kind === "down") {
      if (request.gestureId !== null) throw new GestureRefusal(RefusalCode.NoGesture, "Down starts a gesture; omit gestureId")
      if (live) {
        throw new GestureRefusal(
          RefusalCode.Reserved,
          `A gesture is already ${live.phase} in this browser`,
        )
      }
      return {
        ...completion(),
        binding: context.binding,
        button: request.button === "right" ? "right" : "left",
        cancelRequested: false,
        contextId: context.id,
        deadline: this.now() + GESTURE_IDLE_MS,
        id: crypto.randomUUID(),
        outcome: null,
        phase: "starting",
        pressed: false,
        standalone: false,
        step: null,
        warning: null,
      }
    }
    if (request.kind === "move" && request.gestureId === null) {
      if (live) throw new GestureRefusal(RefusalCode.Reserved, "Finish or cancel the held gesture before a standalone move")
      return {
        ...completion(),
        binding: context.binding,
        button: request.button === "right" ? "right" : "left",
        cancelRequested: false,
        contextId: context.id,
        deadline: this.now() + GESTURE_IDLE_MS,
        id: crypto.randomUUID(),
        outcome: null,
        phase: "executing",
        pressed: false,
        standalone: true,
        step: null,
        warning: null,
      }
    }
    if (live?.id !== request.gestureId || live.contextId !== context.id) {
      throw new GestureRefusal(RefusalCode.NoGesture, "No held gesture matches this context and gesture ID")
    }
    if (live.phase !== "held") throw new GestureRefusal(RefusalCode.Reserved, `The gesture is ${live.phase}`)
    // Checked before any preparation: a late step never revives an expired gesture.
    if (this.now() >= live.deadline) {
      void this.latchCancel(live)
      throw new GestureRefusal(RefusalCode.Expired, "The gesture expired")
    }
    live.deadline = this.now() + GESTURE_IDLE_MS
    return live
  }

  /** Claim the step synchronously, then store its intent; only a stored intent can be admitted. */
  private store(context: Context, gesture: Gesture, step: Step, key: string): Promise<StepReceipt> {
    const previous = this.gesture
    const previousPhase = gesture.phase
    this.gesture = gesture
    this.armIdle(gesture)
    gesture.step = step
    gesture.phase = step.kind === "down" ? "starting" : step.kind === "up" ? "ending" : "executing"
    const previousLast = context.last
    const stored = this.persist(gesture).then(
      async() => {
        context.nextSequence = step.sequence + 1
        // Settled meanwhile (tab closed, client lost) or cancelled: the step is never admitted.
        if (step.phase !== "storing") return step.result ?? this.receipt(gesture, step)
        if (gesture.cancelRequested) {
          await this.drop(gesture, step)
          return step.result ?? this.receipt(gesture, step)
        }
        step.phase = "reserved"
        return this.receipt(gesture, step)
      },
      async(cause: unknown) => {
        // Nothing was admitted and the sequence stays free.
        const failure = new GestureRefusal(RefusalCode.Storage, `Gesture intent could not be stored: ${errorMessage(cause)}`, { cause })
        context.last = previousLast
        if (step.phase !== "storing") throw failure
        step.phase = "done"
        gesture.step = null
        gesture.phase = previousPhase
        if (step.kind === "down") {
          this.stop()
          this.cleanupTimer = undefined
          this.gesture = previous
          // A cancel that arrived meanwhile names a press that never existed.
          if (gesture.cancelRequested) {
            gesture.phase = "terminal"
            gesture.outcome = "cancelled"
            gesture.warning = "No button was pressed; no release was sent"
            this.finished(gesture)
          }
        } else if (gesture.cancelRequested) {
          this.offerCleanup(gesture)
          await this.persist(gesture).catch(() => undefined)
        }
        throw failure
      },
    )
    context.last = { gesture, key, step, stored }
    return stored
  }

  /** The step is over: fix its receipt from the gesture state it left. */
  private settleStep(gesture: Gesture, step: Step): void {
    step.phase = "done"
    step.settled = null
    if (gesture.step === step) gesture.step = null
    const receipt = this.receipt(gesture, step)
    step.result = step.sentNothing && receipt.outcome === "held" ? { ...receipt, outcome: "not-dispatched" } : receipt
    this.finished(gesture)
  }

  private running(executor: string, token: string): { gesture: Gesture; step: Step } {
    const gesture = this.gesture
    const step = gesture?.step
    if (!gesture || step?.token !== token || step.phase !== "dispatching" || gesture.binding.executor !== executor) {
      throw new GestureRefusal(RefusalCode.UnknownStep, "Pointer step is not running for this executor")
    }
    return { gesture, step }
  }

  /**
   * Apply the executor's answer, then write it. The step stays busy until the write ends, and its
   * receipt is read only then, so a cancel or an executor loss that won meanwhile is reported. A
   * failed write cannot leave a permanent reservation: request cleanup instead.
   */
  private finish(
    { gesture, step }: { gesture: Gesture; step: Step },
    result: "confirmed" | "not-dispatched" | "uncertain",
    point: Point | null = null,
    warning: string | null = null,
  ): Promise<StepReceipt> {
    this.applyAnswer(gesture, step, result)
    if (warning !== null) gesture.warning = warning
    if (step.kind === "cancel") {
      gesture.warning = result === "confirmed"
        ? "Sent mouseReleased with buttons: 0 through the original executor"
        : `Release was not confirmed: ${warning ?? "the executor sent no release"}`
    }
    step.point = point
    step.warning = warning
    step.phase = "settling"
    step.sentNothing = result === "not-dispatched"
    step.settled = this.persist(gesture).then(
      async() => {
        if (step.phase !== "settling") return step.result ?? this.receipt(gesture, step)
        if (gesture.step === step) gesture.step = null
        // Cancellation latched while the step ran or its answer was written: offer cleanup now.
        const cleanup = gesture.cancelRequested && gesture.phase === "held"
        if (cleanup) {
          this.offerCleanup(gesture)
          // The step stays settling, so duplicates wait; an executor loss meanwhile is its answer.
          await this.persist(gesture).catch(() => undefined)
        }
        // Detached from the gesture above, so only this path settles it, from the state after the write.
        this.settleStep(gesture, step)
        return step.result ?? this.receipt(gesture, step)
      },
      async(cause: unknown) => {
        gesture.warning = `Gesture result could not be stored: ${errorMessage(cause)}`
        if (step.phase === "settling") {
          if (gesture.step === step) gesture.step = null
          if (gesture.pressed) {
            if (gesture.cancelRequested) this.offerCleanup(gesture)
            else await this.latchCancel(gesture)
          }
          this.settleStep(gesture, step)
        }
        return step.result ?? this.receipt(gesture, step)
      },
    )
    return step.settled
  }

  private applyAnswer(gesture: Gesture, step: Step, result: "confirmed" | "not-dispatched" | "uncertain"): void {
    if (gesture.standalone) {
      gesture.phase = "terminal"
      gesture.outcome = result === "confirmed" ? "moved" : "not-dispatched"
      return
    }
    if (step.kind === "cancel") {
      gesture.phase = "terminal"
      gesture.outcome = "cancelled"
      gesture.pressed = false
    } else if (result === "uncertain") {
      gesture.phase = "held"
      gesture.cancelRequested = true
      this.cancelling(gesture.binding.executor, gesture.id)
      this.armCleanup(gesture)
    } else if (step.kind === "up" && result === "confirmed") {
      // A dispatched release stays released even when cancellation was requested meanwhile.
      gesture.phase = "terminal"
      gesture.outcome = "released"
      gesture.pressed = false
    } else if (step.kind === "down" && result === "not-dispatched") {
      gesture.phase = "terminal"
      gesture.pressed = false
      gesture.outcome = gesture.cancelRequested ? "cancelled" : "not-dispatched"
    } else {
      // A cancel latched while the step ran is offered once the write ends (see finish).
      gesture.phase = "held"
    }
  }

  private async latchCancel(gesture: Gesture): Promise<void> {
    if (gesture.cancelRequested || gesture.phase === "terminal") return
    gesture.cancelRequested = true
    this.cancelling(gesture.binding.executor, gesture.id)
    this.armCleanup(gesture)
    const step = gesture.step
    // A running step settles first; its completion offers the cleanup.
    if (step?.phase === "dispatching" || step?.phase === "storing" || step?.phase === "settling") {
      await this.persist(gesture).catch(() => undefined)
      return
    }
    if (step) {
      await this.drop(gesture, step)
      return
    }
    this.offerCleanup(gesture)
    await this.persist(gesture).catch(() => undefined)
  }

  /** A stored step that never began is withdrawn; a press that never began needs no cleanup. */
  private async drop(gesture: Gesture, step: Step): Promise<void> {
    if (gesture.step === step) gesture.step = null
    if (gesture.pressed) {
      gesture.phase = "held"
      this.offerCleanup(gesture)
    } else {
      gesture.phase = "terminal"
      gesture.outcome = "cancelled"
      gesture.warning = "No button was pressed; no release was sent"
    }
    this.settleStep(gesture, step)
    await this.persist(gesture).catch(() => undefined)
  }

  private offerCleanup(gesture: Gesture): void {
    if (!gesture.pressed) {
      gesture.phase = "terminal"
      gesture.outcome = "cancelled"
      gesture.warning ??= "No button was pressed; no release was sent"
      this.finished(gesture)
      return
    }
    gesture.phase = "cancelling"
    gesture.step = {
      args: {},
      kind: "cancel",
      phase: "reserved",
      point: null,
      resolved: null,
      result: null,
      sentNothing: false,
      sequence: 0,
      settled: null,
      token: crypto.randomUUID(),
      warning: null,
    }
    this.offer(gesture.binding.executor)
  }

  private async terminate(gesture: Gesture, outcome: GestureOutcome): Promise<void> {
    const step = gesture.step
    gesture.step = null
    gesture.phase = "terminal"
    gesture.outcome = outcome
    gesture.pressed = false
    if (step) this.settleStep(gesture, step)
    this.finished(gesture)
    await this.persist(gesture).catch(() => undefined)
  }

  private armIdle(gesture: Gesture): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.gesture !== gesture || gesture.cancelRequested) return
      if (gesture.phase === "terminal") {
        if (gesture.step?.phase === "settling") this.settleStep(gesture, gesture.step)
        return
      }
      if (this.now() < gesture.deadline) this.armIdle(gesture)
      else void this.latchCancel(gesture)
    }, Math.max(0, gesture.deadline - this.now()))
  }

  private armCleanup(gesture: Gesture): void {
    clearTimeout(this.idleTimer)
    if (this.cleanupTimer !== undefined) return
    this.cleanupTimer = setTimeout(() => {
      gesture.warning = "Pointer cleanup timed out; release delivery was not confirmed"
      void this.terminate(gesture, "cancelled")
    }, CLEANUP_TIMEOUT_MS)
  }

  private finished(gesture: Gesture): void {
    if (gesture.phase !== "terminal" || gesture.step !== null) return
    if (this.gesture === gesture) {
      this.stop()
      this.cleanupTimer = undefined
    }
    gesture.resolveDone()
    this.ended(gesture.binding, gesture.id)
  }

  private receipt(gesture: Gesture, step: Step): StepReceipt {
    const kind = step.kind === "cancel" ? "up" : step.kind
    return {
      gestureId: gesture.id,
      kind,
      outcome: outcomeOf(gesture, step),
      point: step.point,
      sequence: step.sequence,
      token: step.token,
      warning: step.warning,
    }
  }

  /** Writes are serialized so a later state never lands before an earlier one. */
  private persist(gesture: Gesture): Promise<void> {
    // A settling step has its answer applied; only unanswered intent is stored.
    const step = gesture.step?.phase === "settling" ? null : gesture.step
    const record = {
      binding: gesture.binding,
      button: gesture.button,
      cancelRequested: gesture.cancelRequested,
      deadline: gesture.deadline,
      gestureId: gesture.id,
      outcome: gesture.outcome,
      phase: gesture.phase,
      pressed: gesture.pressed,
      standalone: gesture.standalone,
      step: step && { args: step.args, kind: step.kind, resolved: step.resolved, sequence: step.sequence },
      version: 1,
    }
    const write = this.writes.then(() => this.storage.set({ [GESTURE_KEY]: record }))
    this.writes = write.catch(() => undefined)
    return write
  }
}


function completion(): Pick<Gesture, "done" | "resolveDone"> {
  let resolveDone = () => {}
  const done = new Promise<void>((resolve) => { resolveDone = resolve })
  return { done, resolveDone }
}
