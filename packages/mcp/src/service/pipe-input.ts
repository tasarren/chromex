import {
  AgentCursor,
  CursorUnavailable,
  errorMessage,
  executeStep,
  type ExecutorAuthority,
  type InputOperation,
  parseInspection,
  type GestureState,
  readDocument,
  runInput,
  runInspection,
  runPointerStep,
  type StepAnswer,
  StepRefused,
} from "@chromex/protocol"
import { z } from "zod"
import { CdpCommandError } from "./cdp-pipe.ts"

/** What a fenced operation does: browser input, page CDP commands, or a profile change. */
export type FenceKind = "cdp" | "input" | "profile"

/** One fenced operation as the extension admitted it; the service runs exactly this. */
export type Begun =
  | { kind: "cdp"; operation: InputOperation; targetId: string }
  | { kind: "input"; operation: InputOperation; targetId: string }
  | { kind: "profile"; operation: Record<string, unknown> }

/** One admitted pipe operation, as the Managed service can observe it. */
export type ServicePipeInput = {
  begin(token: string): Promise<Begun>
  command(targetId: string, method: string, params: Record<string, unknown>): Promise<unknown>
  end(token: string): Promise<unknown>
  /** Tell the extension that the command outcome is unknown; it keeps the admission fenced. */
  uncertain(token: string): Promise<unknown>
}

/**
 * A profile change failed after it may have applied earlier steps. `completed` names the steps the
 * change confirmed, so the uncertainty message can report what is known to have happened.
 */
export class ProfileChangeError extends Error {
  override name = "ProfileChangeError"
  readonly completed: readonly string[]

  constructor(message: string, completed: readonly string[], options?: ErrorOptions) {
    super(message, options)
    this.completed = completed
  }
}

/**
 * Run one admitted operation inside the extension's fence. A failed begin may have been admitted
 * anyway, so the token is ended (cancelled when it never began). A single page command (cdp) ends
 * its fence when Chromium answered an error, since that command is the whole effect. A profile
 * change is composite: an answered error later does not undo earlier steps, so it stays uncertain
 * unless the change refused before doing anything. Input never ends on an answered error because a
 * pressed key or button can remain. Timeouts and lost pipes always leave the fence admitted.
 */
export async function runFenced<T>(
  token: string,
  pipe: ServicePipeInput,
  run: (begun: Begun) => Promise<T>,
): Promise<T> {
  let begun: Begun
  try {
    begun = await pipe.begin(token)
  } catch(cause) {
    await pipe.end(token).catch(() => undefined)
    throw cause
  }
  let result: T
  try {
    result = await run(begun)
  } catch(cause) {
    const settled =
      cause instanceof FenceRefusal ||
      cause instanceof CursorUnavailable ||
      (begun.kind === "cdp" && cause instanceof CdpCommandError)
    if (settled) {
      await pipe.end(token)
      throw cause
    }
    // Mark uncertainty in the owning bridge, so public status reports the orphan the fence holds.
    await pipe.uncertain(token).catch(() => undefined)
    const completed =
      cause instanceof ProfileChangeError && cause.completed.length > 0
        ? ` (completed: ${cause.completed.join(", ")})`
        : ""
    throw new Error(
      `Managed ${begun.kind} outcome is uncertain after ${errorMessage(cause)}${completed}; restart the browser to recover`,
      { cause },
    )
  }
  await pipe.end(token)
  return result
}

/** The service refused the admitted operation before sending anything to Chromium. */
export class FenceRefusal extends Error {
  override name = "FenceRefusal"
}

/** Run one admitted input operation through the pipe. */
export async function runServiceInput(token: string, pipe: ServicePipeInput): Promise<unknown[]> {
  return await runFenced(token, pipe, async(begun) => {
    if (begun.kind !== "input") throw new FenceRefusal(`Expected input, got ${begun.kind}`)
    // The service drives only Managed pages, so the agent cursor always shows.
    return await runInput(begun.operation, (method, params) => pipe.command(begun.targetId, method, params), true)
  })
}

/** The extension calls the service uses to admit a pipe read; the broker client provides them. */
export type InspectBroker = { request(method: string, params?: unknown): Promise<unknown> }
/** The browser pipe a read runs over. */
export type InspectPipe = {
  send(method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown>
  session(targetId: string): Promise<string>
}

/**
 * Run one fixed read of a `chrome://` tab another client controls. The extension names the target and
 * the closed request, so a caller cannot run its own commands. Reads grant no control, so they skip
 * the service queue and its fences. The extension re-admits the read before every command and before
 * the result is returned, so an uninspect, handoff, revoke or close stops it midway.
 */
/** The service side of a pipe gesture: the service is the bound executor for its own tab. */
export type ServiceGestureHost = {
  broker: { request(method: string, params?: unknown): Promise<unknown> };
  cdp: {
    send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  };
  /** The service's local replacement counter for one exact attached session. */
  epoch(sessionId: string): number;
}

/**
 * Run steps and cleanup offers as the original pipe executor. The authority has already bound this
 * service and the exact document; each input step rereads the frame tree before and after delivery.
 */
export class ServiceGestureExecutor {
  private readonly active: ServiceGestureHost
  private readonly cancelled = new Set<string>()
  private readonly inflight = new Map<string, Promise<StepAnswer>>()
  private readonly states = new Map<string, GestureState>()

  constructor(active: ServiceGestureHost) {
    this.active = active
  }

  /** Latch the owner's cancellation so the next eased event stops without another round trip. */
  cancel(gestureId: string): void {
    this.cancelled.add(gestureId)
  }

  run(token: string): Promise<StepAnswer> {
    // A duplicate pending request joins the first execution; a retained receipt never reaches here.
    const running = this.inflight.get(token)
    if (running) return running
    const started = this.execute(token)
    this.inflight.set(token, started)
    void started.then(
      () => this.inflight.delete(token),
      () => this.inflight.delete(token),
    )
    return started
  }

  private async execute(token: string): Promise<StepAnswer> {
    const authority: ExecutorAuthority = {
      admit: async(step) => await this.active.broker.request("gesture.admit", { token: step }),
      complete: async(step, dispatched, point, warning) =>
        await this.active.broker.request("gesture.complete", { dispatched, point, token: step, warning }),
      uncertain: async(step, warning, point) =>
        await this.active.broker.request("gesture.uncertain", { point, token: step, warning }),
    }
    return await executeStep(authority, token, async(step) => {
      if (step.targetId === null) throw new StepRefused("The gesture has no pipe target")
      // Use exactly the session the authority bound. Never attach a replacement to finish an old hold.
      if (step.sessionId === null) throw new StepRefused("The gesture has no bound pipe session")
      const sessionId = step.sessionId
      const state = this.states.get(step.gestureId) ?? {
        document: step.document,
        emulating: false,
        point: null,
        pressed: false,
      }
      this.states.set(step.gestureId, state)
      const send = (method: string, params: Record<string, unknown>) =>
        this.active.cdp.send(method, params, sessionId)
      // Keep state only while it owns a held button or focus emulation for the cleanup to undo.
      // Cancel ends the gesture whatever it sent: undo owned focus emulation and keep nothing.
      const finished = async() => {
        if (step.kind === "cancel" && state.emulating) await send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => undefined)
        if (step.kind === "cancel" || (!state.pressed && !state.emulating)) this.forget(step.gestureId)
      }
      const point = await runPointerStep(step.kind, step.args, state, {
        afterEdge: async(kind) => {
          await this.active.broker.request("gesture.edge", {
            action: "end",
            gestureId: step.gestureId,
            kind,
            tabId: step.tabId,
          })
        },
        beforeEdge: async(kind) => {
          await this.active.broker.request("gesture.edge", {
            action: "begin",
            gestureId: step.gestureId,
            kind,
            tabId: step.tabId,
          })
        },
        cancelled: () => this.cancelled.has(step.gestureId),
        identity: () => readDocument(send, () => this.active.epoch(sessionId)),
        live: async() => {
          if ((await this.status()).activeCleanup !== token) throw new StepRefused("The gesture already ended; no release was sent")
        },
        send,
      }).finally(finished)
      return point
    })
  }

  private forget(gestureId: string): void {
    this.states.delete(gestureId)
    this.cancelled.delete(gestureId)
  }

  /** Take the authority's cleanup offer for this executor: release the held button. */
  async cleanup(): Promise<StepAnswer | null> {
    const { cleanup } = await this.status()
    return cleanup === null ? null : await this.run(cleanup)
  }

  /** `cleanup` is offered only while reserved; `activeCleanup` stays set while that cancel dispatches. */
  private async status(): Promise<{ activeCleanup?: string | null | undefined; cleanup: string | null }> {
    return z.object({ activeCleanup: z.string().nullish(), cleanup: z.string().nullable() })
      .parse(await this.active.broker.request("gesture.status", {}))
  }
}

/**
 * Remove the agent cursor from a pipe-driven page on release (ISS-07). Bounded like the extension's
 * own removal, so a slow page never delays the release; a late failure is harmless.
 */
export async function removeCursor(send: (method: string, params: Record<string, unknown>) => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    new AgentCursor(send).remove().catch(() => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, 500) }),
  ])
  clearTimeout(timer)
}

export async function runInspect(broker: InspectBroker, pipe: InspectPipe, token: string): Promise<unknown> {
  const begun = z
    .object({ request: z.unknown(), sessionId: z.string().min(1).optional(), targetId: z.string().min(1) })
    .parse(await broker.request("inspect.begin", { token }))
  try {
    const request = parseInspection(begun.request)
    // During a hold the extension names the held session: read that document, never attach a new one.
    const session = begun.sessionId ?? await pipe.session(begun.targetId)
    const result = await runInspection(request, async(method, params) => {
      await broker.request("inspect.step", { token })
      return await pipe.send(method, params, session)
    })
    await broker.request("inspect.end", { token })
    return result
  } catch(cause) {
    // Invalidate the token on any failure; an already-ended token refuses harmlessly.
    await broker.request("inspect.end", { token }).catch(() => undefined)
    throw cause
  }
}
