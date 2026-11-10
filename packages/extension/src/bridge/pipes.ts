import { errorMessage, hasWheel, withCleanup } from "@chromex/protocol"
import {
  ABORTED_ADMISSION,
  blockedFence,
  type BackgroundSelection,
  type BridgeApi,
  type Fence,
  type OrphanedAdmission,
  type PipeInput,
} from "./params.ts"

type BackgroundAdmission = {
  beginBackgroundInput(tabId: number, wheel?: boolean): Promise<BackgroundSelection | null>
  finishBackgroundInput(state: BackgroundSelection | null): Promise<void>
  addHelper(tabId: number): void
}

type PipeHost = {
  readonly background: BackgroundAdmission
  readonly blockRecovery: (message: string) => void
  readonly leases: ReadonlyMap<number, string>
  readonly storage: BridgeApi["storage"]["session"]
  readonly assertSettled: () => void
  readonly targets: () => Promise<Pick<chrome.debugger.TargetInfo, "attached" | "id" | "tabId">[]>
}

export const PIPE_KEY = "bridgeAdmittedPipeInput"
export const RELEASE_UNCERTAIN_KEY = "bridgeReleaseUncertain"
export const RELEASE_UNCERTAIN_MESSAGE =
  "Debugger release is uncertain; restart the browser to recover"

/**
 * Owns pipe admission: reserved and admitted input, the fence that holds later requests, and the
 * fail-closed records restored after a worker or host loss.
 */
export class PipeAdmissions {
  private readonly host: PipeHost
  /** Pipe input reserved by a client and run by the Managed service, keyed by single-use token. */
  private readonly pipeInputs = new Map<string, PipeInput>()
  /** Set while admitted pipe input runs; queued requests wait for it, so none can overtake it. */
  private fence: Fence | null = null
  /** Admission restored after a worker restart; its service pipe outcome is unknown. */
  private orphanedAdmission: OrphanedAdmission | null = null
  /** An unanswered debugger detach; control stays blocked until the browser restarts. */
  private releaseUncertain = false

  constructor(host: PipeHost) {
    this.host = host
  }

  get fenceValue(): Fence | null {
    return this.fence
  }

  get orphaned(): OrphanedAdmission | null {
    return this.orphanedAdmission
  }

  get size(): number {
    return this.pipeInputs.size
  }

  get uncertain(): boolean {
    return this.releaseUncertain
  }

  hasInput(): boolean {
    return this.fence !== null || this.orphanedAdmission !== null || this.pipeInputs.size > 0
  }

  restoreUncertain(value: boolean): void {
    this.releaseUncertain = value
  }

  reserve(token: string, input: PipeInput): void {
    this.pipeInputs.set(token, input)
  }

  /** The executor was lost; abort an admission still starting, or orphan running input. */
  abandon(owner: string): "starting" | "orphaned" | null {
    const token = this.fence?.token
    if (token === undefined) return null
    const input = this.pipeInputs.get(token)
    if (input?.executor !== owner) return null
    if (input.phase === "starting") {
      input.aborted = true
      return "starting"
    }
    input.phase = "orphaned"
    return "orphaned"
  }

  dropTab(tabId: number): void {
    for (const [token, input] of this.pipeInputs) {
      if (input.tabId === tabId) this.pipeInputs.delete(token)
    }
  }

  /** A reservation that never began cannot outlive its owner. A running one keeps its fence. */
  dropReserved(owner: string): void {
    for (const [token, input] of this.pipeInputs) {
      if (input.client === owner && input.phase === "reserved") this.pipeInputs.delete(token)
    }
  }

  blockFence(): void {
    this.fence ??= blockedFence()
  }

  /**
   * The native host died, so no executor can report completion. Admission aborts; running input
   * becomes orphaned and stays fenced until the browser restarts. Restoring now could expose a
   * target whose commands are still executing.
   */
  orphanPipeInputs(): void {
    for (const input of this.pipeInputs.values()) {
      if (input.phase === "starting") input.aborted = true
      else if (input.phase === "running") input.phase = "orphaned"
    }
  }

  /**
   * Admit reserved pipe input while its client still holds the lease. The calling client becomes
   * the executor, and the fence holds every later queued request until that executor ends it.
   */
  async beginPipeInput(token: string, executor: string) {
    this.host.assertSettled()
    const input = this.pipeInputs.get(token)
    const leaseHeld = input?.kind === "profile" || this.host.leases.get(input?.tabId ?? -1) === input?.client
    if (!input || input.executor !== null || !leaseHeld) {
      this.pipeInputs.delete(token)
      throw new Error("Pipe input is not reserved, already began, or its tab was released")
    }
    // Own the operation synchronously, before the first await, so loss at any admission step is seen.
    input.executor = executor
    input.phase = "starting"
    let done = () => {}
    const promise = new Promise<void>((resolve) => { done = resolve })
    this.fence = { done, promise, token }
    try {
      // Recorded before the acknowledgement: a new worker must fail closed, not forget this.
      await this.host.storage.set({
        [PIPE_KEY]: { kind: input.kind, tabId: input.tabId, token },
      })
      if (input.aborted) throw new Error(ABORTED_ADMISSION)
      let targetId: string | null = null
      if (input.kind !== "profile") {
        const target = (await this.host.targets()).find((t) => t.tabId === input.tabId)
        if (!target) throw new Error(`No debugger target for tab ${input.tabId}`)
        targetId = target.id
      }
      if (this.admissionAborted(input)) throw new Error(ABORTED_ADMISSION)
      if (input.kind === "input") {
        input.selection = await this.host.background.beginBackgroundInput(input.tabId, hasWheel(input.operation))
      }
      // The same flag is set by a loss during the awaited selection; TypeScript keeps the old narrowing.
      if (this.admissionAborted(input)) throw new Error(ABORTED_ADMISSION)
      input.phase = "running"
      if (input.kind === "profile") {
        return { kind: input.kind, operation: input.profileOperation }
      }
      if (targetId === null) throw new Error("Pipe input has no debugger target")
      return input.kind === "cdp"
        ? { kind: input.kind, operation: input.operation, targetId }
        : { operation: input.operation, targetId }
    } catch(cause) {
      return await withCleanup(
        () => Promise.reject(cause as Error),
        async() => {
          this.pipeInputs.delete(token)
          await this.host.storage.set({ [PIPE_KEY]: null })
        },
        async() => {
          this.releaseFence(token)
          if (input.selection) await this.host.background.finishBackgroundInput(input.selection)
        },
      )
    }
  }

  /**
   * End pipe input outside the queue, so a request held by the fence cannot deadlock it. A token
   * that never began is cancelled, which makes an uncertain begin acknowledgement recoverable.
   * Only the executor may end admitted input. Orphaned input stays fenced: its commands may still
   * run, so neither the selection nor the queue is released.
   */
  async endPipeInput(token: string, executor: string): Promise<object> {
    const input = this.pipeInputs.get(token)
    if (!input) throw new Error("Unknown pipe input")
    if (input.executor === null) {
      this.pipeInputs.delete(token)
      return { cancelled: true }
    }
    if (input.executor !== executor) throw new Error("Unknown pipe input")
    if (input.phase === "starting") {
      // The suspended admission aborts and cleans up; its fence stays until it does.
      input.aborted = true
      return { cancelled: true }
    }
    if (input.phase === "orphaned") {
      throw new Error("Pipe input is orphaned because its executor was lost; restart the browser")
    }
    // Only a successful cleanup proves completion; any failure keeps the marker and fence.
    await this.host.background.finishBackgroundInput(input.selection)
    await this.clearAdmission()
    this.pipeInputs.delete(token)
    this.releaseFence(token)
    return {}
  }

  restoreOrphanedAdmission(admission: OrphanedAdmission): void {
    this.orphanedAdmission = admission
    // The helper or target stays reserved, and every mutation waits behind the never-resolved fence.
    if (admission.kind === "input" && admission.tabId !== null) {
      this.host.background.addHelper(admission.tabId)
    }
    let done = () => {}
    const promise = new Promise<void>((resolve) => { done = resolve })
    this.fence = { done, promise, token: admission.token }
  }

  clearAdmission(): Promise<void> {
    return this.host.storage.set({ [PIPE_KEY]: null })
  }

  orphanedInputInfo(): OrphanedAdmission | null {
    if (this.orphanedAdmission) return this.orphanedAdmission
    for (const [token, input] of this.pipeInputs) {
      if (input.phase === "orphaned") {
        return { kind: input.kind, tabId: input.tabId, token }
      }
    }
    return null
  }

  /** The service cannot prove its command outcome. Keep the admission fenced and hidden. */
  async markPipeInputUncertain(token: string, executor: string): Promise<object> {
    const input = this.pipeInputs.get(token)
    if (!input || input.executor !== executor || input.phase !== "running") {
      throw new Error("Unknown pipe input")
    }
    input.phase = "orphaned"
    return {}
  }

  /** An unanswered detach leaves debugger state unknown; control stays blocked until restart. */
  async markReleaseUncertain(): Promise<void> {
    this.releaseUncertain = true
    try {
      await this.host.storage.set({ [RELEASE_UNCERTAIN_KEY]: true })
    } catch(cause) {
      this.host.blockRecovery(`Release uncertainty could not be persisted: ${errorMessage(cause)}`)
    }
  }

  private admissionAborted(input: PipeInput): boolean {
    return input.aborted
  }

  private releaseFence(token: string): void {
    if (this.fence?.token !== token) return
    this.fence.done()
    this.fence = null
  }
}
