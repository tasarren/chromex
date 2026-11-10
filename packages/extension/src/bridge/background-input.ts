import { hasWheel, runInput, withCleanup, type InputCommand, type InputOperation } from "@chromex/protocol"
import { GestureRefusal, RefusalCode } from "../gesture-authority.ts"
import { isRecord, nonnegativeInteger } from "../session-state.ts"
import type { BackgroundSelection, BridgeApi } from "./params.ts"

type BackgroundInputHost = {
  readonly api: BridgeApi
  readonly attachedTabs: ReadonlySet<number>
  readonly leases: ReadonlyMap<number, string>
  readonly managed: () => boolean
}

/**
 * Owns background input: the blank helper tab that keeps Chromium from activating the window, the
 * per-gesture helper selections, and the count of legacy input commands in flight.
 */
export class BackgroundInput {
  private readonly host: BackgroundInputHost
  /** Blank tabs selected for input; nobody may adopt or claim them until input ends. */
  private readonly inputHelpers = new Set<number>()
  /** Service executor helper selections, keyed by gesture, retained after an uncertain edge. */
  private readonly edgeSelections = new Map<string, BackgroundSelection | null>()
  /** Legacy input.run and raw Input commands sending now; a gesture is not reserved or admitted meanwhile. */
  private legacyInputs = 0

  constructor(host: BackgroundInputHost) {
    this.host = host
  }

  hasHelper(tabId: number): boolean {
    return this.inputHelpers.has(tabId)
  }

  helperIds(): number[] {
    return [...this.inputHelpers]
  }

  helperCount(): number {
    return this.inputHelpers.size
  }

  addHelper(tabId: number): void {
    this.inputHelpers.add(tabId)
  }

  dropTab(tabId: number): void {
    this.inputHelpers.delete(tabId)
  }

  hasEdge(gestureId: string): boolean {
    return this.edgeSelections.has(gestureId)
  }

  async beginEdge(gestureId: string, tabId: number): Promise<void> {
    if (!this.edgeSelections.has(gestureId)) {
      this.edgeSelections.set(gestureId, await this.beginBackgroundInput(tabId, false))
    }
  }

  async endEdge(gestureId: string): Promise<void> {
    const selection = this.edgeSelections.get(gestureId) ?? null
    await this.finishBackgroundInput(selection)
    this.edgeSelections.delete(gestureId)
  }

  /** Take a terminal gesture's helper selection; a retained edge selection is dropped even when unused. */
  takeEdge(gestureId: string): BackgroundSelection | null {
    const selection = this.edgeSelections.get(gestureId) ?? null
    this.edgeSelections.delete(gestureId)
    return selection
  }

  /** Count legacy input from its admission (same tick as assertNoGesture) until it settles. */
  async legacyInput<T>(run: () => Promise<T>): Promise<T> {
    this.legacyInputs++
    try {
      return await run()
    } finally {
      this.legacyInputs--
    }
  }

  assertNoLegacyInput(): void {
    if (this.legacyInputs > 0) throw new GestureRefusal(RefusalCode.Busy, "Browser input is running; retry after it ends")
  }

  readCommands(params: unknown): InputCommand[] {
    if (!isRecord(params) || !Array.isArray(params.commands)) {
      throw new Error("Invalid input commands")
    }
    return params.commands.map((entry) => {
      if (!isRecord(entry) || typeof entry.method !== "string" || entry.method.length === 0) {
        throw new Error("Invalid input command")
      }
      const commandParams = entry.params ?? {}
      if (!isRecord(commandParams)) throw new Error("Invalid input params")
      return { method: entry.method, params: commandParams }
    })
  }

  readInputOperation(params: unknown): InputOperation {
    const commands = this.readCommands(params)
    if (!isRecord(params) || params.field === undefined) return { commands }
    const { field } = params
    const backendNodeId = isRecord(field) ? nonnegativeInteger(field.backendNodeId) : undefined
    if (!isRecord(field) || backendNodeId === undefined || typeof field.clear !== "boolean") {
      throw new Error("Invalid input field")
    }
    return { commands, field: { backendNodeId, clear: field.clear } }
  }

  /**
   * Select a blank helper so the target is hidden and Chromium does not activate the window on
   * input. A wheel target that was never selected does not scroll (measured, Chromium 156), so it is
   * selected once first; the prior selection is kept for restore.
   */
  async beginBackgroundInput(
    tabId: number,
    wheel = false,
  ): Promise<BackgroundSelection | null> {
    // Observe never opens or selects tabs the person did not grant; the grant is consent to input
    // on the tab as it is, selected or not (DEC-86).
    if (!this.host.managed()) return null
    const tab = await this.host.api.tabs.get(tabId)
    const selectTarget = wheel && !tab.active
    if (!tab.active && !selectTarget) return null
    const [previous] = await this.host.api.tabs.query({ active: true, windowId: tab.windowId })
    const previousTabId = previous?.id ?? tabId
    if (selectTarget) await this.host.api.tabs.update(tabId, { active: true })
    try {
      return await this.selectHelper(tabId, tab.windowId, previousTabId)
    } catch(cause) {
      if (!selectTarget) throw cause
      // Put the prior tab back only while the target this operation selected is still selected.
      return await withCleanup(
        () => Promise.reject(cause as Error),
        async() => {
          const [active] = await this.host.api.tabs.query({ active: true, windowId: tab.windowId })
          if (active?.id === tabId) await this.host.api.tabs.update(previousTabId, { active: true })
        },
      )
    }
  }

  private async selectHelper(
    tabId: number,
    windowId: number,
    previousTabId: number,
  ): Promise<BackgroundSelection> {
    const tabs = await this.host.api.tabs.query({ windowId })
    const idle = tabs.find(
      (candidate) =>
        candidate.id !== undefined &&
        candidate.id !== tabId &&
        !candidate.active &&
        candidate.url === "about:blank" &&
        !this.host.leases.has(candidate.id) &&
        !this.host.attachedTabs.has(candidate.id) &&
        !this.inputHelpers.has(candidate.id),
    )
    const helper = idle ?? (await this.host.api.tabs.create({
      active: false,
      url: "about:blank",
      windowId,
    }))
    if (helper.id === undefined) throw new Error("Chromium returned a helper tab without an ID")
    const state = {
      helperCreated: idle === undefined,
      helperId: helper.id,
      previousTabId,
      targetTabId: tabId,
      windowId,
    }
    this.inputHelpers.add(helper.id)
    try {
      await this.host.api.tabs.update(helper.id, { active: true })
    } catch(cause) {
      return await withCleanup(
        () => Promise.reject(cause as Error),
        () => this.finishBackgroundInput(state),
      )
    }
    return state
  }

  /**
   * Put the previous tab back, and remove a created helper, only while the helper is still the
   * selected, untouched blank tab. Once a human selects or navigates elsewhere, their state stays.
   */
  async finishBackgroundInput(state: BackgroundSelection | null): Promise<void> {
    if (!state) return
    const idle = await this.idleHelper(state.helperId)
    await withCleanup(
      async() => {
        const [active] = await this.host.api.tabs.query({ active: true, windowId: state.windowId })
        // The target may have closed meanwhile; nothing to put back then.
        if (idle && active?.id === state.helperId && (await this.knownTab(state.previousTabId))) {
          await this.host.api.tabs.update(state.previousTabId, { active: true })
        }
      },
      async() => {
        this.inputHelpers.delete(state.helperId)
        if (idle && state.helperCreated) await this.host.api.tabs.remove(state.helperId)
      },
    )
  }

  private knownTab(tabId: number): Promise<boolean> {
    return this.host.api.tabs.get(tabId).then(() => true, () => false)
  }

  /** A helper is idle while it is a blank tab nobody navigated, leased or attached. */
  private async idleHelper(tabId: number): Promise<boolean> {
    const tab = await this.host.api.tabs.get(tabId).catch(() => null)
    const blank = tab?.url === "about:blank" && tab.pendingUrl === undefined
    return blank && !this.host.leases.has(tabId) && !this.host.attachedTabs.has(tabId)
  }

  async runBackgroundInput(tabId: number, operation: InputOperation): Promise<unknown[]> {
    const selection = await this.beginBackgroundInput(tabId, hasWheel(operation))
    const send = (method: string, params: Record<string, unknown>) =>
      this.host.api.debugger.sendCommand({ tabId }, method, params)
    return await withCleanup(
      () => runInput(operation, send, true),
      () => this.finishBackgroundInput(selection),
    )
  }
}
