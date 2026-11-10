import {
  AgentCursor,
  EXTENSION_ID,
  type ExtensionInfo,
  type Admitted,
  type DocumentIdentity,
  errorMessage,
  executeStep,
  type GestureState,
  NATIVE_HOST_NAME,
  PROTOCOL_VERSION,
  type Point,
  REPLACED_WARNING,
  readDocument,
  replacesDocument,
  type RpcRequest,
  runPointerStep,
  type StepAnswer,
  StepRefused,
} from "@chromex/protocol"
import {
  appendEvent,
  type BridgeEvent,
  type BridgeEventKind,
  parseEvents,
  shortUrl,
} from "./events.ts"
import {
  type GestureBinding,
  GestureAuthority,
  GestureRefusal,
  RefusalCode,
  serviceExecutor,
  workerExecutor,
} from "./gesture-authority.ts"
import { NativeConnection } from "./native-connection.ts"
import {
  type PopupCommand,
  type PopupResult,
  type PopupStatus,
  parsePopupCommand,
} from "./popup-contract.ts"
import {
  beginSessionGeneration,
  emptySessionState,
  findBootstrapTab,
  isRecord,
  nonnegativeInteger,
  parseSessionState,
  reconcileSessionState,
  SESSION_STATE_VERSION,
  type SessionState,
} from "./session-state.ts"
import {
  CLOSING_MESSAGE,
  CLOSING_METHODS,
  GESTURE_METHODS,
  INSPECTION_METHODS,
  clientId,
  isCleanDetachError,
  numberParam,
  parsePipeMarker,
  pipeKindParam,
  pointParam,
  readProfileOperation,
  readStepRequest,
  tabInfo,
  tokenParam,
  type BackgroundSelection,
  type BridgeApi,
} from "./bridge/params.ts"
import { BackgroundInput } from "./bridge/background-input.ts"
import { Inspections } from "./bridge/inspections.ts"
import { PipeAdmissions, PIPE_KEY, RELEASE_UNCERTAIN_KEY, RELEASE_UNCERTAIN_MESSAGE } from "./bridge/pipes.ts"

const EVENTS_KEY = "bridgeEvents"
const SESSION_KEY = "bridgeSessionState"

/**
 * Owns the extension's bridge state: leases, attached debuggers, client windows/labels/modes,
 * Observe grants, and session recovery. Every lease or grant mutation runs through one queue.
 */
export class ExtensionBridge {
  private readonly api: BridgeApi
  private readonly connection: NativeConnection
  private readonly background: BackgroundInput
  private readonly pipes: PipeAdmissions
  private readonly inspections: Inspections
  private readonly leases = new Map<number, string>()
  private readonly attachedTabs = new Set<number>()
  /** Per-client window preference; windows outlive clients. */
  private readonly windows = new Map<string, number>()
  /** Human-readable client names for the popup, sent by the MCP server on connect. */
  private readonly labels = new Map<string, string>()
  private readonly modes = new Map<string, "managed" | "observe">()
  private readonly observeTabs = new Set<number>()
  private managed = false
  private generation = 0
  private recoveryError: string | null = null
  /** Set once the Managed service is admitted to close the browser; no new work is admitted. */
  private closing = false
  private readonly gestures: GestureAuthority
  /** Main-frame replacements and rewrites seen per tab; a gesture context is bound to one value. */
  private readonly documentEpochs = new Map<number, number>()
  /** Incremented on every attach and detach, so an old context cannot survive a reattach. */
  private readonly attachmentEpochs = new Map<number, number>()
  /** Executor descriptors of host-authenticated Managed service sessions, by client ID. */
  private readonly serviceExecutors = new Map<string, string>()
  /** Pipe-driven tabs a service session executes for, with the document it bound. */
  private readonly pipeBindings = new Map<number, {
    readonly document: DocumentIdentity
    readonly executor: string
    readonly sessionId: string
    readonly targetId: string
  }>()
  /** Attached tabs whose Page domain this worker enabled; cleared when the debugger detaches. */
  private readonly pageEvents = new Set<number>()
  /** The worker executor's state for the live gesture, kept with its tab between calls. */
  private pointer: {
    readonly gestureId: string
    selection: BackgroundSelection | null
    readonly state: GestureState
  } | null = null
  /** Worker executions by token, so concurrent exact retries join one dispatch. */
  private readonly workerSteps = new Map<string, Promise<StepAnswer>>()
  private operations: Promise<unknown> = Promise.resolve()
  private stateWrite: Promise<void> = Promise.resolve()
  private eventWrite: Promise<void> = Promise.resolve()
  private ready: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(api: BridgeApi, now: () => number = Date.now) {
    this.api = api
    this.background = new BackgroundInput({
      api,
      attachedTabs: this.attachedTabs,
      leases: this.leases,
      managed: () => this.managed,
    })
    this.pipes = new PipeAdmissions({
      background: this.background,
      blockRecovery: (message) => { this.blockRecovery(message) },
      leases: this.leases,
      storage: api.storage.session,
      assertSettled: () => { this.assertSettled() },
      targets: () => api.debugger.getTargets(),
    })
    this.gestures = new GestureAuthority({
      now,
      cancelling: (executor, gestureId) => {
        const clientId = [...this.serviceExecutors].find(([, bound]) => bound === executor)?.[0]
        if (clientId) this.connection.notify("gesture.cancel", { clientId, gestureId })
      },
      ended: (binding, gestureId) => { void this.finishGesture(binding, gestureId) },
      offer: (executor) => { this.offerCleanup(executor) },
      storage: api.storage.session,
    })
    this.inspections = new Inspections({
      api,
      attachedTabs: this.attachedTabs,
      gestures: this.gestures,
      isCurrent: (binding) => this.isCurrent(binding),
      isManaged: () => this.managed,
      leases: this.leases,
      assertSettled: () => { this.assertSettled() },
      assertTabAccess: (tabId) => { this.assertTabAccess(tabId) },
      notifyClosed: (client, tabId) => { this.connection.notify("tab.closed", { clientId: client, tabId }) },
    })
    this.connection = new NativeConnection(api, {
      disconnected: () => {
        this.pipes.orphanPipeInputs()
        this.serviceExecutors.clear()
        this.pipeBindings.clear()
        void this.gestures.clientLost(null)
      },
      hello: () => this.hello(),
      request: (request) => this.route(request),
    })
  }

  /**
   * Every request runs in the queue except the end of admitted pipe input, which the fence waits
   * for. Losing the executor during admission aborts that admission; losing it while input runs
   * leaves the operation reserved and the queue fenced, because the input may still be in flight.
   */
  private route(request: RpcRequest): Promise<unknown> {
    const queued = () =>
      this.serialized(async() => {
        await this.ready
        // Admitted while this request waited in the queue: refuse it before any effect.
        if (this.closing && !CLOSING_METHODS.has(request.method)) throw new Error(CLOSING_MESSAGE)
        return await this.handle(request)
      })
    if (this.closing && !CLOSING_METHODS.has(request.method)) {
      return Promise.reject(new Error(CLOSING_MESSAGE))
    }
    // Close never waits behind a fence: running or orphaned input refuses it at once.
    if (request.method === "bridge.close" && (this.pipes.fenceValue !== null || this.recoveryError !== null)) {
      return Promise.reject(new Error(this.recoveryError ?? "Managed browser input is running"))
    }
    if (request.method === "input.end") {
      return this.pipes.endPipeInput(tokenParam(request.params), clientId(request.params))
    }
    if (request.method === "input.uncertain") {
      return this.pipes.markPipeInputUncertain(tokenParam(request.params), clientId(request.params))
    }
    // Bounded read-only answers must diagnose an orphaned fence; mutating requests stay held.
    if (request.method === "bridge.status" || request.method === "client.status") {
      return this.ready.then(async() => await this.handle(request))
    }
    // Reads of another client's tab grant no control, so a fence or uncertain release never holds them.
    if (INSPECTION_METHODS.has(request.method)) {
      return this.ready.then(async() => await this.inspections.inspection(request))
    }
    if (GESTURE_METHODS.has(request.method)) {
      return this.ready.then(async() => await this.gesture(request))
    }
    const owner = request.method === "client.release" ? clientId(request.params) : undefined
    if (owner !== undefined) {
      // Departure must stop admission even when another request holds the ordinary queue.
      void this.ready.then(() => this.gestures.clientLost(owner, this.serviceExecutors.get(owner) ?? null))
    }
    const abandoned = owner === undefined ? null : this.pipes.abandon(owner)
    if (abandoned === "starting") {
      return this.pipes.fenceValue?.promise.then(queued) ?? queued()
    }
    if (abandoned === "orphaned") return Promise.resolve({ orphaned: true })
    return queued()
  }

  /** Register every listener synchronously, as MV3 requires, then restore state and connect. */
  start(): Promise<void> {
    this.stopped = false
    this.api.debugger.onEvent.addListener(this.onDebuggerEvent)
    this.api.debugger.onDetach.addListener(this.onDebuggerDetach)
    this.api.windows.onRemoved.addListener(this.onWindowRemoved)
    this.api.tabs.onRemoved.addListener(this.onTabRemoved)
    this.api.runtime.onMessage.addListener(this.onPopupMessage)
    this.connection.start()
    this.ready = Promise.all([this.restoreSessionState(), this.gestures.restore()]).then(() => undefined, (cause: unknown) => {
      this.recoveryError = `Session recovery failed: ${errorMessage(cause)}`
    })
    return this.ready.then(() => { this.connection.connect() })
  }

  /** Undo start(): remove listeners, stop the connection, and stop session recovery. */
  stop(): void {
    this.stopped = true
    this.api.debugger.onEvent.removeListener(this.onDebuggerEvent)
    this.api.debugger.onDetach.removeListener(this.onDebuggerDetach)
    this.api.windows.onRemoved.removeListener(this.onWindowRemoved)
    this.api.tabs.onRemoved.removeListener(this.onTabRemoved)
    this.api.runtime.onMessage.removeListener(this.onPopupMessage)
    this.connection.stop()
    this.gestures.stop()
  }

  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operations.then(async() => {
      let fence = this.pipes.fenceValue
      while (fence !== null) {
        await fence.promise
        fence = this.pipes.fenceValue
      }
      return await action()
    })
    this.operations = result.catch(() => undefined)
    return result
  }

  private hello(): ExtensionInfo {
    return {
      extensionId: this.api.runtime.id || EXTENSION_ID,
      extensionVersion: this.api.runtime.getManifest().version ?? "",
      name: "Chromex",
      protocolVersion: PROTOCOL_VERSION,
    }
  }

  /**
   * Record an event for the popup. Kept in session storage because MV3 suspends this worker after
   * ~30s idle, which would wipe an in-memory log. Appends are queued so concurrent events are not
   * lost, but never awaited: logging must not delay or fail a bridge operation.
   */
  private logEvent(kind: BridgeEventKind, entry: Partial<BridgeEvent> = {}): void {
    const event: BridgeEvent = { ...entry, kind, ts: Date.now() }
    if (event.clientId !== undefined && event.label === undefined) {
      const label = this.labels.get(event.clientId)
      if (label !== undefined) event.label = label
    }
    this.eventWrite = this.eventWrite
      .then(async() => {
        const events = await this.readEvents()
        await this.api.storage.session.set({ [EVENTS_KEY]: appendEvent(events, event) })
      })
      // A full or unavailable session store must not break browser control.
      .catch(() => undefined)
  }

  private async readEvents(): Promise<BridgeEvent[]> {
    try {
      return parseEvents((await this.api.storage.session.get(EVENTS_KEY))[EVENTS_KEY])
    } catch {
      return []
    }
  }

  private currentSessionState(): SessionState {
    const owners = new Set([
      ...this.labels.keys(),
      ...this.modes.keys(),
      ...this.windows.keys(),
      ...this.leases.values(),
    ])
    return {
      clients: [...owners].map((owner) => {
        const label = this.labels.get(owner)
        const mode = this.modes.get(owner)
        const windowId = this.windows.get(owner)
        return {
          clientId: owner,
          ...(label === undefined ? {} : { label }),
          ...(mode === undefined ? {} : { mode }),
          ...(windowId === undefined ? {} : { windowId }),
        }
      }),
      generation: this.generation,
      leases: [...this.leases.entries()].map(([tabId, owner]) => ({
        clientId: owner,
        desiredAttached: this.attachedTabs.has(tabId),
        tabId,
      })),
      version: SESSION_STATE_VERSION,
    }
  }

  private persistSessionState(): Promise<void> {
    const snapshot = this.currentSessionState()
    this.stateWrite = this.stateWrite
      .then(() => this.api.storage.session.set({ [SESSION_KEY]: snapshot }))
      .catch(() => undefined)
    return this.stateWrite
  }

  private persistObserveTabs(): Promise<void> {
    return this.api.storage.session.set({ observeTabs: [...this.observeTabs] })
  }

  private async restoreSessionState(): Promise<void> {
    let stored = emptySessionState()
    try {
      const value = await this.api.storage.session.get([
        SESSION_KEY,
        PIPE_KEY,
        "observeTabs",
        "managed",
        RELEASE_UNCERTAIN_KEY,
      ])
      stored = parseSessionState(value[SESSION_KEY])
      this.managed = value.managed === true
      this.pipes.restoreUncertain(value[RELEASE_UNCERTAIN_KEY] === true)
      const marker = value[PIPE_KEY]
      if (marker !== undefined && marker !== null) {
        const admission = parsePipeMarker(marker)
        if (admission) this.pipes.restoreOrphanedAdmission(admission)
        else this.blockRecovery("Malformed pipe admission record")
      }
      for (const id of Array.isArray(value.observeTabs) ? value.observeTabs : []) {
        const tabId = nonnegativeInteger(id)
        if (tabId !== undefined) this.observeTabs.add(tabId)
      }
    } catch(cause) {
      // A stored admission may exist. Fail closed rather than start clean and expose its target.
      this.blockRecovery(`Session recovery failed: ${errorMessage(cause)}`)
    }
    const [tabs, browserWindows] = await Promise.all([
      this.api.tabs.query({}),
      this.api.windows.getAll(),
    ])
    const reconciled = beginSessionGeneration(
      reconcileSessionState(stored, {
        tabIds: tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id])),
        windowIds: browserWindows.flatMap((window) => (window.id === undefined ? [] : [window.id])),
      }),
    )
    this.generation = reconciled.generation
    for (const client of reconciled.clients) {
      if (client.label !== undefined) this.labels.set(client.clientId, client.label)
      if (client.mode !== undefined) this.modes.set(client.clientId, client.mode)
      if (client.windowId !== undefined) this.windows.set(client.clientId, client.windowId)
    }
    for (const lease of reconciled.leases) {
      if (this.managed || this.observeTabs.has(lease.tabId)) {
        this.leases.set(lease.tabId, lease.clientId)
      }
    }

    const targets = await this.api.debugger.getTargets()
    for (const lease of reconciled.leases) {
      if (this.stopped) return
      if (!this.leases.has(lease.tabId) || !lease.desiredAttached) continue
      const target = targets.find((candidate) => candidate.tabId === lease.tabId)
      try {
        if (target?.attached === true) {
          await this.api.debugger.sendCommand({ tabId: lease.tabId }, "Runtime.enable", {})
        } else {
          await this.api.debugger.attach({ tabId: lease.tabId }, "1.3")
          // stop() ran while this attach was in flight; do not keep a debugger it no longer owns.
          // TypeScript keeps the pre-await narrowing of `stopped`; stop() can change it meanwhile.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (this.stopped) {
            await this.api.debugger.detach({ tabId: lease.tabId }).catch(() => undefined)
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see above.
        if (this.stopped) return
        this.attachedTabs.add(lease.tabId)
        this.attachmentEpochs.set(lease.tabId, (this.attachmentEpochs.get(lease.tabId) ?? 0) + 1)
      } catch {
        // DevTools or another debugger may own it; status exposes the detached lease for recovery.
      }
    }
    await this.persistSessionState()
    if (stored.generation > 0) {
      this.logEvent("worker.restarted", { detail: `generation ${this.generation}` })
    }
  }

  private requireLease(params: unknown): { client: string; tabId: number } {
    const client = clientId(params)
    this.assertSettled()
    const tabId = numberParam(params, "tabId")
    this.assertTabAccess(tabId)
    if (this.leases.get(tabId) !== client) {
      throw new Error(`Tab ${tabId} is not leased by this Codex client`)
    }
    return { client, tabId }
  }

  private assertTabAccess(tabId: number): void {
    if (!this.managed && !this.observeTabs.has(tabId))
      throw new Error(
        "Observe access disabled. Enable 'Allow agents on this tab' in the extension popup.",
      )
  }

  /**
   * Control stays blocked while an unanswered detach leaves a debugger state unknown. Inspection
   * and the end of already admitted pipe work do not check this: they grant no new control.
   */
  private assertSettled(): void {
    if (this.pipes.uncertain) throw new Error(RELEASE_UNCERTAIN_MESSAGE)
  }

  /**
   * Admit the Managed service to close its own browser only when nothing can be lost: no other
   * client, lease, input, inspection or unknown debugger state. Runs in the queue, and the flag it
   * sets refuses every later admission, so no request can slip in between the check and the close.
   */
  private admitClose(owner: string): void {
    if (this.closing) return
    if (!this.managed) throw new Error("Only a Managed browser can be closed")
    this.assertSettled()
    const busy = [
      this.pipes.orphaned === null ? null : "orphaned input",
      this.gestures.conflict() === null ? null : "a pointer gesture",
      this.pipes.size === 0 ? null : "reserved input",
      this.background.helperCount() === 0 ? null : "an input helper tab",
      this.leases.size === 0 ? null : "a controlled tab",
      this.inspections.busy() ? "an inspection" : null,
      this.currentSessionState().clients.some((client) => client.clientId !== owner) ? "another client" : null,
    ].filter((reason) => reason !== null)
    if (busy.length > 0) throw new Error(`Managed browser is in use (${busy.join(", ")}); release it first`)
    this.closing = true
  }

  private blockRecovery(message: string): void {
    this.recoveryError ??= message
    this.pipes.blockFence()
  }

  private async attach(tabId: number): Promise<void> {
    if (this.attachedTabs.has(tabId)) return
    await this.api.debugger.attach({ tabId }, "1.3")
    this.attachedTabs.add(tabId)
    this.attachmentEpochs.set(tabId, (this.attachmentEpochs.get(tabId) ?? 0) + 1)
    this.logEvent("debugger.attached", { clientId: this.leases.get(tabId), tabId })
    await this.persistSessionState()
  }

  private async detach(tabId: number): Promise<void> {
    if (!this.attachedTabs.delete(tabId)) return
    this.pageEvents.delete(tabId)
    this.attachmentEpochs.set(tabId, (this.attachmentEpochs.get(tabId) ?? 0) + 1)
    this.logEvent("debugger.detached", { clientId: this.leases.get(tabId), tabId })
    try {
      await this.api.debugger.detach({ tabId })
    } catch(cause) {
      // A clean not-attached/no-tab answer is expected. Anything else may still be in flight.
      if (!isCleanDetachError(cause)) await this.pipes.markReleaseUncertain()
    }
    await this.persistSessionState()
  }

  /** A tab with a reserved gesture keeps its lease and debugger until that gesture is settled. */
  private async releaseTab(tabId: number, owner?: string): Promise<void> {
    if (owner !== undefined && this.leases.get(tabId) !== owner) return
    if (this.gestures.holds(tabId)) return
    // Contexts issued under this lease never carry over to a later lease, even the same owner's.
    this.gestures.invalidateTab(tabId)
    // Admitted input already ended (the queue waits for it); unbegun reservations become invalid.
    this.pipes.dropTab(tabId)
    // Pending reads were admitted under this controller; a later controller needs new ones.
    this.inspections.dropTab(tabId)
    this.leases.delete(tabId)
    // Drop this executor's indicator before its debugger session goes away. Removal never delays a
    // release behind a slow in-flight command, and a late failure is harmless.
    if (this.attachedTabs.has(tabId)) {
      const removal = new AgentCursor((method, params) =>
        this.api.debugger.sendCommand({ tabId }, method, params),
      ).remove().catch(() => undefined)
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        removal,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 500) }),
      ])
      clearTimeout(timer)
    }
    await this.detach(tabId)
    await this.persistSessionState()
  }

  /**
   * Return the client's window, creating one if it has none or the user closed it. A newly created
   * window already contains one blank tab, which is returned so the caller can adopt it rather than
   * opening a second tab and stranding this one.
   */
  private async ensureWindow(
    owner: string,
    adoptExisting: boolean,
  ): Promise<{ tabId?: number; windowId: number }> {
    const existing = this.windows.get(owner)
    if (existing !== undefined) {
      try {
        await this.api.windows.get(existing)
        return { windowId: existing }
      } catch {
        this.windows.delete(owner)
        await this.persistSessionState()
      }
    }
    if (adoptExisting) {
      const browserWindows = await this.api.windows.getAll({
        populate: true,
        windowTypes: ["normal"],
      })
      const bootstrap = findBootstrapTab(browserWindows, [
        ...this.leases.keys(),
        ...this.background.helperIds(),
      ])
      if (bootstrap) {
        this.windows.set(owner, bootstrap.windowId)
        this.leases.set(bootstrap.tabId, owner)
        this.logEvent("tab.claimed", { clientId: owner, ...bootstrap })
        await this.persistSessionState()
        return bootstrap
      }
    }
    // Join the window another agent already works in instead of opening a second one.
    const sharedWindowId = await this.sharedWindow()
    if (sharedWindowId !== null) {
      const tab = await this.api.tabs.create({
        active: false,
        url: "about:blank",
        windowId: sharedWindowId,
      })
      if (tab.id === undefined) throw new Error("Chromium returned a tab without an ID")
      this.windows.set(owner, sharedWindowId)
      this.leases.set(tab.id, owner)
      this.logEvent("tab.opened", { clientId: owner, tabId: tab.id, windowId: sharedWindowId })
      await this.persistSessionState()
      return { tabId: tab.id, windowId: sharedWindowId }
    }
    // Not focused: an agent working in the background must not steal the user's focus.
    const created = await this.api.windows.create({ focused: false, url: "about:blank" })
    if (created?.id === undefined) throw new Error("Chromium returned a window without an ID")
    this.windows.set(owner, created.id)
    this.logEvent("window.created", { clientId: owner, windowId: created.id })
    await this.persistSessionState()
    const blankTabId = created.tabs?.find((tab) => tab.id !== undefined)?.id
    if (blankTabId === undefined) return { windowId: created.id }
    this.leases.set(blankTabId, owner)
    this.logEvent("tab.opened", { clientId: owner, tabId: blankTabId, windowId: created.id })
    await this.persistSessionState()
    return { tabId: blankTabId, windowId: created.id }
  }

  /**
   * Window to join: the window of any tab another client leases, else the first normal browser
   * window. Existing tabs are never claimed; the joining client gets a new inactive tab.
   */
  private async sharedWindow(): Promise<number | null> {
    for (const tab of await this.api.tabs.query({})) {
      if (tab.id !== undefined && this.leases.has(tab.id)) {
        return tab.windowId
      }
    }
    const [existing] = await this.api.windows.getAll({ windowTypes: ["normal"] })
    return existing?.id ?? null
  }

  private async releaseClient(owner: string): Promise<void> {
    this.inspections.dropInspection(owner)
    const executor = this.serviceExecutors.get(owner) ?? null
    this.serviceExecutors.delete(owner)
    // Its pipe tabs have no executor left; a reconnected session must bind them again.
    for (const [tabId, bound] of this.pipeBindings) {
      if (bound.executor !== executor) continue
      this.pipeBindings.delete(tabId)
      this.gestures.invalidateTab(tabId)
    }
    await this.gestures.clientLost(owner, executor)
    // A reservation that never began cannot outlive its owner. A running one keeps its fence.
    this.pipes.dropReserved(owner)
    const tabIds = [...this.leases.entries()]
      .filter(([, currentOwner]) => currentOwner === owner)
      .map(([tabId]) => tabId)
    await Promise.allSettled(tabIds.map((tabId) => this.releaseTab(tabId, owner)))
    const windowId = this.windows.get(owner)
    this.logEvent("client.disconnected", {
      clientId: owner,
      ...(windowId === undefined ? {} : { windowId }),
    })
    this.windows.delete(owner)
    this.labels.delete(owner)
    this.modes.delete(owner)
    await this.persistSessionState()
  }

  private async releaseAll(): Promise<void> {
    await Promise.allSettled([...this.leases.keys()].map((tabId) => this.releaseTab(tabId)))
  }

  private async handle(request: RpcRequest): Promise<unknown> {
    const params = request.params
    switch (request.method) {
      case "bridge.configure":
        this.managed = isRecord(params) && params.managed === true
        await this.api.storage.session.set({ managed: this.managed })
        return {}

      case "bridge.status":
        return {
          extensionId: this.api.runtime.id,
          extensionVersion: this.api.runtime.getManifest().version ?? "",
          generation: this.generation,
          leases: [...this.leases.entries()].map(([tabId, owner]) => ({
            attached: this.attachedTabs.has(tabId),
            owner,
            tabId,
          })),
          name: "Chromex",
          managed: this.managed,
          protocolVersion: PROTOCOL_VERSION,
          recoveryError: this.recoveryError,
          releaseUncertain: this.pipes.uncertain,
          closing: this.closing,
          gesture: this.gestures.conflict(),
          clients: this.currentSessionState().clients,
          orphanedInput: this.pipes.orphanedInputInfo(),
          windows: [...this.windows.entries()].map(([owner, windowId]) => ({ owner, windowId })),
        }

      case "client.status": {
        const owner = clientId(params)
        return {
          generation: this.generation,
          leases: [...this.leases.entries()]
            .filter(([, currentOwner]) => currentOwner === owner)
            .map(([tabId]) => ({ attached: this.attachedTabs.has(tabId), tabId })),
          mode: this.modes.get(owner) ?? null,
          orphanedInput: this.pipes.orphanedInputInfo(),
          recoveryError: this.recoveryError,
          releaseUncertain: this.pipes.uncertain,
          windowId: this.windows.get(owner) ?? null,
        }
      }

      case "tabs.list": {
        clientId(params)
        const tabs = await this.api.tabs.query({})
        return tabs.flatMap((tab) =>
          tab.id !== undefined && (this.managed || this.observeTabs.has(tab.id))
            ? [{ ...tabInfo(tab), controlled: this.leases.has(tab.id) }]
            : [],
        )
      }

      case "window.ensure": {
        const owner = clientId(params)
        this.assertSettled()
        if (!this.managed) throw new Error("Observe mode cannot create windows")
        return await this.ensureWindow(owner, isRecord(params) && params.adoptExisting === true)
      }

      case "tabs.create": {
        const owner = clientId(params)
        this.assertSettled()
        if (!this.managed) throw new Error("Observe mode cannot create tabs")
        const active = !isRecord(params) || params.active !== false
        const windowId =
          isRecord(params) && "windowId" in params ? numberParam(params, "windowId") : undefined
        const tab = tabInfo(
          await this.api.tabs.create({
            active,
            url: "about:blank",
            ...(windowId === undefined ? {} : { windowId }),
          }),
        )
        this.leases.set(tab.id, owner)
        this.logEvent("tab.opened", { clientId: owner, tabId: tab.id, windowId: tab.windowId })
        await this.persistSessionState()
        return tab
      }

      case "tabs.claim": {
        const owner = clientId(params)
        this.assertSettled()
        const tabId = numberParam(params, "tabId")
        this.assertTabAccess(tabId)
        const existing = this.leases.get(tabId)
        if (existing && existing !== owner) {
          throw new Error(`Tab ${tabId} is controlled by another client`)
        }
        if (this.background.hasHelper(tabId)) {
          throw new Error(`Tab ${tabId} is in use for background input; retry shortly`)
        }
        const tab = tabInfo(await this.api.tabs.get(tabId))
        // Re-claiming a tab this client already holds is a no-op refresh, not worth a feed line.
        if (existing !== owner) {
          this.logEvent("tab.claimed", { clientId: owner, tabId, windowId: tab.windowId })
        }
        this.leases.set(tabId, owner)
        this.inspections.dropInspection(owner)
        await this.persistSessionState()
        return tab
      }

      case "tabs.park": {
        const { tabId } = this.requireLease(params)
        this.assertNotReserved(tabId)
        await this.detach(tabId)
        return {}
      }

      case "tabs.release": {
        const { client, tabId } = this.requireLease(params)
        this.assertNotReserved(tabId)
        await this.releaseTab(tabId, client)
        return {}
      }

      case "tabs.close": {
        const { client, tabId } = this.requireLease(params)
        this.assertNotReserved(tabId)
        if (!this.managed) throw new Error("Observe mode cannot close tabs")
        // Closing Chromium's last tab exits its shared process. Leave an unleased bootstrap tab.
        if ((await this.api.tabs.query({})).length === 1) {
          const tab = await this.api.tabs.get(tabId)
          await this.api.tabs.create({ windowId: tab.windowId, url: "about:blank", active: false })
        }
        await this.api.tabs.remove(tabId)
        await this.releaseTab(tabId, client)
        this.logEvent("tab.closed", { clientId: client, tabId })
        return {}
      }

      case "client.hello": {
        const owner = clientId(params)
        const { label, mode } = isRecord(params) ? params : {}
        if (typeof label === "string" && label.length > 0) {
          this.labels.set(owner, label.slice(0, 120))
        }
        if (mode === "managed" || mode === "observe") this.modes.set(owner, mode)
        // Only the native host sets this, after checking the service key; each session gets a new generation.
        const { executorGeneration } = isRecord(params) ? params : {}
        if (typeof executorGeneration === "number" && Number.isSafeInteger(executorGeneration) && executorGeneration > 0) {
          this.serviceExecutors.set(owner, serviceExecutor(owner, executorGeneration))
        } else this.serviceExecutors.delete(owner)
        this.logEvent("client.connected", { clientId: owner })
        await this.persistSessionState()
        return {}
      }

      case "client.release":
        await this.releaseClient(clientId(params))
        return {}

      case "bridge.close":
        this.admitClose(clientId(params))
        return { closing: true }

      case "cdp.attach":
        await this.attach(this.requireLease(params).tabId)
        return {}

      case "cdp.detach": {
        const { tabId } = this.requireLease(params)
        this.assertNotReserved(tabId)
        await this.detach(tabId)
        return {}
      }

      // The managed service drives internal pages over its browser pipe by this target ID.
      case "tabs.target": {
        const { tabId } = this.requireLease(params)
        const target = (await this.api.debugger.getTargets()).find((t) => t.tabId === tabId)
        if (!target) throw new Error(`No debugger target for tab ${tabId}`)
        return { targetId: target.id }
      }

      case "cdp.command": {
        const { tabId } = this.requireLease(params)
        if (!this.attachedTabs.has(tabId))
          throw new Error(`Debugger is not attached to tab ${tabId}`)
        const { method, params: commandParams = {} } = isRecord(params) ? params : {}
        if (typeof method !== "string" || method.length === 0)
          throw new Error("Invalid CDP method")
        if (!isRecord(commandParams)) throw new Error("Invalid CDP params")
        if (!method.startsWith("Input.")) return await this.api.debugger.sendCommand({ tabId }, method, commandParams)
        // Raw input could press under a gesture, so it waits for none and holds gesture admission.
        this.assertNoGesture()
        return await this.background.legacyInput(() => this.api.debugger.sendCommand({ tabId }, method, commandParams))
      }

      case "input.run": {
        const { tabId } = this.requireLease(params)
        this.assertNoGesture()
        if (!this.attachedTabs.has(tabId)) {
          throw new Error(`Debugger is not attached to tab ${tabId}`)
        }
        const operation = this.background.readInputOperation(params)
        return { results: await this.background.legacyInput(() => this.background.runBackgroundInput(tabId, operation)) }
      }

      // Pipe input: the lease holder reserves the tab and operation; the Managed service runs it.
      case "input.reserve": {
        const kind = pipeKindParam(params)
        this.assertNoGesture()
        const token = crypto.randomUUID()
        if (kind === "profile") {
          const client = clientId(params)
          this.assertSettled()
          if (!this.managed) throw new Error("Profile fences require a Managed browser")
          this.pipes.reserve(token, {
            aborted: false,
            client,
            executor: null,
            kind,
            operation: null,
            phase: "reserved",
            profileOperation: readProfileOperation(params),
            selection: null,
            tabId: null,
          })
          return { token }
        }
        const { client, tabId } = this.requireLease(params)
        this.pipes.reserve(token, {
          aborted: false,
          client,
          executor: null,
          kind,
          operation:
            kind === "input" ? this.background.readInputOperation(params) : { commands: this.background.readCommands(params) },
          phase: "reserved",
          profileOperation: null,
          selection: null,
          tabId,
        })
        return { token }
      }

      case "input.begin":
        return await this.pipes.beginPipeInput(tokenParam(params), clientId(params))

      default:
        throw new Error(`Unsupported extension method: ${request.method}`)
    }
  }

  /**
   * Gesture admission for the tab's lease holder; an inspector is not an owner. The context binding
   * comes only from bridge state: lease holder, worker generation, the tab's document epoch and its
   * executor. An attached tab is executed by this worker; a pipe-driven tab only by the service
   * session that registered it. A tab with neither gets no context.
   *
   * Agents own status, reserve and cancel. A worker step runs here once reserved; a service step is
   * admitted, completed or marked uncertain only by its bound service session. The native host
   * injects the authenticated `clientId` and `executor` role; no caller can name the worker.
   */
  private async gesture(request: RpcRequest): Promise<unknown> {
    const params = request.params
    const client = clientId(params)
    const service = this.serviceExecutors.get(client) ?? null
    switch (request.method) {
      case "gesture.status": {
        const tabId = isRecord(params) && "tabId" in params ? numberParam(params, "tabId") : null
        // A live hold keeps its issued context: status must not reissue it against a replacement,
        // and the caller needs the same context/next sequence for its next step.
        if (tabId !== null && this.gestures.reservation()?.tabId === tabId) {
          const bound = this.gestures.contextFor(client, service)
          if (bound) return { ...this.gestures.status(client, service), context: bound }
        }
        const executor = tabId === null ? null : this.executorFor(tabId)
        const usable = tabId !== null && executor !== null && this.leases.get(tabId) === client && this.readable(tabId)
        let document: DocumentIdentity | null = null
        if (usable && executor === workerExecutor(this.generation)) {
          // Replacement and rewrite events are counted only once the Page domain is on, so it is on first.
          // With a gesture reserved or unreadable state, no new gesture can start, so no command is sent.
          if (this.gestures.conflict() === null) {
            await this.enablePageEvents(tabId)
            const epoch = this.documentEpochs.get(tabId) ?? 0
            document = await readDocument(
              (method, params) => this.api.debugger.sendCommand({ tabId }, method, params),
              () => this.documentEpochs.get(tabId) ?? epoch,
            ).catch(() => null)
          }
        } else if (usable) {
          document = this.pipeBindings.get(tabId)?.document ?? null
        }
        const context = usable && document !== null
          ? this.gestures.issue(this.bindingOf(tabId, client, executor, document))
          : null
        return { ...this.gestures.status(client, service), context }
      }
      case "gesture.reserve": {
        const { tabId } = this.requireLease(params)
        // Pipe input reserved earlier could begin under the gesture; one gesture per browser waits for it.
        if (this.pipes.hasInput()) {
          throw new GestureRefusal(RefusalCode.Busy, "Browser input is running; retry after it ends")
        }
        if (this.background.hasHelper(tabId)) throw new GestureRefusal(RefusalCode.Busy, `Tab ${tabId} is in use for background input`)
        this.background.assertNoLegacyInput()
        const receipt = await this.gestures.reserve(client, readStepRequest(params), (binding) => this.isCurrent(binding))
        // A worker step runs now; its receipt is the executor's answer. A service step waits for its executor.
        const pending = this.gestures.pendingStep()
        if (receipt.outcome !== "pending" || pending?.token !== receipt.token || pending.executor !== workerExecutor(this.generation)) {
          return receipt
        }
        const running = this.workerSteps.get(pending.token)
        if (running) {
          const answer = await running
          return { ...(answer.receipt as object), point: answer.point, warning: answer.warning }
        }
        const started = this.runWorkerStep(pending.token)
        this.workerSteps.set(pending.token, started)
        void started.then(
          () => this.workerSteps.delete(pending.token),
          () => this.workerSteps.delete(pending.token),
        )
        const answer = await started
        return { ...(answer.receipt as object), point: answer.point, warning: answer.warning }
      }
      case "gesture.admit":
        this.assertSettled()
        if (this.pipes.fenceValue !== null) throw new GestureRefusal(RefusalCode.Busy, "Browser input is running; retry after it ends")
        this.background.assertNoLegacyInput()
        return this.gestures.admit(this.requireService(service), tokenParam(params), (binding) => this.isCurrent(binding))
      case "gesture.complete": {
        const dispatched = isRecord(params) ? params.dispatched : undefined
        if (typeof dispatched !== "boolean") throw new Error("Invalid dispatched flag")
        const warning = isRecord(params) && typeof params.warning === "string" ? params.warning.slice(0, 500) : null
        return await this.gestures.complete(this.requireService(service), tokenParam(params), dispatched, pointParam(params), warning)
      }
      case "gesture.uncertain": {
        const warning = isRecord(params) && typeof params.warning === "string" ? params.warning.slice(0, 500) : null
        return await this.gestures.uncertain(this.requireService(service), tokenParam(params), warning, pointParam(params))
      }
      case "gesture.cancel": {
        const gestureId = isRecord(params) && typeof params.gestureId === "string" && params.gestureId.length > 0
          ? params.gestureId
          : undefined
        return await this.gestures.cancel(client, gestureId)
      }
      case "gesture.bind": {
        // The service registers a pipe-driven tab it executes, with the exact session and document
        // it will use. Contexts issued against another binding go stale.
        const executor = this.requireService(service)
        const tabId = numberParam(params, "tabId")
        const targetId = isRecord(params) && typeof params.targetId === "string" ? params.targetId : null
        const sessionId = isRecord(params) && typeof params.sessionId === "string" ? params.sessionId : null
        const raw = isRecord(params) && isRecord(params.document) ? params.document : null
        const epoch = raw === null ? undefined : nonnegativeInteger(raw.epoch)
        if (targetId === null || sessionId === null || raw === null || epoch === undefined ||
            typeof raw.frameId !== "string" || typeof raw.loaderId !== "string") {
          throw new Error("Invalid pipe document binding")
        }
        const document: DocumentIdentity = { epoch, frameId: raw.frameId, loaderId: raw.loaderId }
        const previous = this.pipeBindings.get(tabId)
        if (previous?.executor !== executor || previous.targetId !== targetId ||
            previous.sessionId !== sessionId || previous.document.frameId !== document.frameId ||
            previous.document.loaderId !== document.loaderId) {
          if (previous) await this.gestures.documentLost(tabId, REPLACED_WARNING)
          this.documentEpochs.set(tabId, (this.documentEpochs.get(tabId) ?? 0) + 1)
          this.pipeBindings.set(tabId, { document, executor, sessionId, targetId })
          this.gestures.invalidateTab(tabId)
        }
        return {}
      }
      case "gesture.edge": {
        // Select the measured helper for one press/release edge, then restore the target. The
        // service never selects tabs itself; an uncertain edge keeps its helper reserved.
        const executor = this.requireService(service)
        const tabId = numberParam(params, "tabId")
        const gestureId = isRecord(params) && typeof params.gestureId === "string" ? params.gestureId : ""
        const action = isRecord(params) ? params.action : undefined
        if (gestureId === "" || (action !== "begin" && action !== "end")) throw new Error("Invalid gesture edge")
        if (this.gestures.executorForGesture(gestureId) !== executor) {
          throw new GestureRefusal(RefusalCode.Foreign, "The gesture has another executor")
        }
        if (action === "begin") {
          await this.background.beginEdge(gestureId, tabId)
          return {}
        }
        await this.background.endEdge(gestureId)
        return {}
      }
      case "gesture.invalidate": {
        // The service saw the pipe page replaced, rewritten or detached.
        const executor = this.requireService(service)
        const tabId = numberParam(params, "tabId")
        if (this.pipeBindings.get(tabId)?.executor !== executor) throw new Error(`Tab ${tabId} is not bound to this executor`)
        const lost = isRecord(params) && params.detached === true
        // A replacement or detach ends this binding; a new context needs a fresh bind.
        this.pipeBindings.delete(tabId)
        this.documentEpochs.set(tabId, (this.documentEpochs.get(tabId) ?? 0) + 1)
        if (lost) await this.gestures.targetLost(tabId)
        else await this.gestures.documentLost(tabId, REPLACED_WARNING)
        return {}
      }
      default:
        throw new Error(`Unsupported extension method: ${request.method}`)
    }
  }

  /**
   * The executor a new context for this tab is bound to: the service session that registered it as
   * pipe-driven, else this worker for an attached tab, else none. A bound gesture keeps its executor.
   */
  private executorFor(tabId: number): string | null {
    return this.pipeBindings.get(tabId)?.executor ?? (this.attachedTabs.has(tabId) ? workerExecutor(this.generation) : null)
  }

  private async enablePageEvents(tabId: number): Promise<void> {
    if (this.pageEvents.has(tabId)) return
    await this.api.debugger.sendCommand({ tabId }, "Page.enable", {})
    this.pageEvents.add(tabId)
  }

  private requireService(executor: string | null): string {
    if (executor === null) throw new GestureRefusal(RefusalCode.Foreign, "Only the Managed service executes pipe gesture steps")
    return executor
  }

  private bindingOf(
    tabId: number,
    owner: string,
    executor: string,
    document: DocumentIdentity,
  ): GestureBinding {
    const pipe = this.pipeBindings.get(tabId)
    return {
      attachmentEpoch: this.attachmentEpochs.get(tabId) ?? 0,
      document,
      documentEpoch: this.documentEpochs.get(tabId) ?? document.epoch,
      executor,
      generation: this.generation,
      owner,
      sessionId: pipe?.sessionId ?? null,
      tabId,
      targetId: pipe?.targetId ?? null,
    }
  }

  /**
   * Run one reserved step as the worker executor over the tab's own debugger session. The bound
   * tab's document is checked before and after each event; a cleanup offer sends nothing.
   */
  private async runWorkerStep(token: string): Promise<StepAnswer> {
    const executor = workerExecutor(this.generation)
    const authority = {
      admit: (step: string) => Promise.resolve(this.gestures.admit(executor, step, (binding) => this.isCurrent(binding))),
      complete: (step: string, dispatched: boolean, point: Point | null, warning: string | null) =>
        this.gestures.complete(executor, step, dispatched, point, warning),
      uncertain: (step: string, warning: string, point: Point | null) =>
        this.gestures.uncertain(executor, step, warning, point),
    }
    return await executeStep(authority, token, (step) => this.dispatchWorkerStep(step))
  }

  private async dispatchWorkerStep(step: Admitted): Promise<Point> {
    const tabId = step.tabId
    if (!this.attachedTabs.has(tabId)) throw new StepRefused(`Tab ${tabId} is not attached`)
    let transient = false
    if (this.pointer?.gestureId !== step.gestureId) {
      if (step.kind === "move" && step.standalone) {
        transient = true
        this.pointer = {
          gestureId: step.gestureId,
          selection: null,
          state: { document: step.document, emulating: false, point: null, pressed: false },
        }
      } else if (step.kind === "down") {
        this.pointer = {
          gestureId: step.gestureId,
          selection: null,
          state: { document: step.document, emulating: false, point: null, pressed: false },
        }
      } else {
        throw new StepRefused("The worker lost this gesture's state; no release was sent")
      }
    }
    const current = this.pointer
    const send = (method: string, params: Record<string, unknown>) => this.api.debugger.sendCommand({ tabId }, method, params)
    const epoch = () => this.documentEpochs.get(tabId) ?? 0
    try {
      // Extension events and command replies are not ordered, so identity rereads the frame tree and epoch each time.
      return await runPointerStep(step.kind, step.args, current.state, {
        afterEdge: async() => {
          if (this.pointer !== current) return
          await this.background.finishBackgroundInput(current.selection)
          current.selection = null
        },
        beforeEdge: async() => {
          if (this.pointer !== current) throw new StepRefused("The worker lost this gesture's edge state")
          current.selection = await this.background.beginBackgroundInput(tabId, false)
        },
        cancelled: () => {
          const held = this.gestures.reservation()
          return held?.gestureId !== step.gestureId || held.cancelRequested
        },
        identity: () => readDocument(send, epoch),
        live: () => {
          if (this.gestures.reservation()?.gestureId !== step.gestureId) {
            return Promise.reject(new StepRefused("Pointer cleanup ended; no release was sent"))
          }
          return Promise.resolve()
        },
        send,
      })
    } finally {
      if (transient && this.pointer === current) this.pointer = null
    }
  }

  /** Deliver a cleanup offer to its own executor: the worker answers here, a service reads its status. */
  private offerCleanup(executor: string): void {
    if (executor !== workerExecutor(this.generation)) {
      const owner = [...this.serviceExecutors].find(([, bound]) => bound === executor)?.[0]
      if (owner) this.connection.notify("gesture.cleanup", { clientId: owner })
      return
    }
    // After the offer's own write, so the cleanup step is reserved for this executor.
    queueMicrotask(() => {
      const pending = this.gestures.pendingStep()
      if (pending?.kind !== "cancel" || pending.executor !== executor) return
      // Authority owns the bounded cleanup deadline when executor delivery fails.
      void this.runWorkerStep(pending.token).catch(() => undefined)
    })
  }

  /** Terminal gestures retain no helper selection, focus emulation or worker pointer state. */
  private async finishGesture(binding: GestureBinding, gestureId: string): Promise<void> {
    const pointer = this.pointer?.gestureId === gestureId ? this.pointer : null
    if (pointer) this.pointer = null
    const edge = this.background.takeEdge(gestureId)
    const selection = pointer?.selection ?? edge
    try {
      if (pointer?.state.emulating && this.attachedTabs.has(binding.tabId) &&
          binding.attachmentEpoch === (this.attachmentEpochs.get(binding.tabId) ?? 0)) {
        await this.api.debugger.sendCommand({ tabId: binding.tabId }, "Emulation.setFocusEmulationEnabled", { enabled: false })
      }
      await this.background.finishBackgroundInput(selection)
    } catch {
      // A closed target or window cannot have its prior selection restored.
    }
  }

  /** The binding still names this tab's lease holder, worker generation, document and access. */
  private isCurrent(binding: GestureBinding): boolean {
    if (!this.readable(binding.tabId) || this.leases.get(binding.tabId) !== binding.owner ||
        binding.generation !== this.generation) return false
    if (binding.executor.startsWith("service:")) {
      const pipe = this.pipeBindings.get(binding.tabId)
      return pipe?.executor === binding.executor && pipe.targetId === binding.targetId &&
        pipe.sessionId === binding.sessionId && binding.documentEpoch === (this.documentEpochs.get(binding.tabId) ?? 0) &&
        pipe.document.frameId === binding.document.frameId && pipe.document.loaderId === binding.document.loaderId
    }
    return this.attachedTabs.has(binding.tabId) &&
      binding.attachmentEpoch === (this.attachmentEpochs.get(binding.tabId) ?? 0) &&
      binding.documentEpoch === (this.documentEpochs.get(binding.tabId) ?? 0)
  }

  private readable(tabId: number): boolean {
    return this.managed || this.observeTabs.has(tabId)
  }

  private assertNoGesture(): void {
    const conflict = this.gestures.conflict()
    if (conflict) throw new GestureRefusal(RefusalCode.Reserved, conflict)
  }

  /** A reserved gesture keeps its tab: releasing the lease would hand a possibly held press to another client. */
  private assertNotReserved(tabId: number): void {
    const reserved = this.gestures.reservation()
    // An unreadable record may name any tab, so it holds every one.
    const blocked = reserved === null ? this.gestures.conflict() : null
    if (blocked) throw new GestureRefusal(RefusalCode.Blocked, blocked)
    if (reserved?.tabId === tabId) {
      throw new GestureRefusal(RefusalCode.Reserved, `Tab ${tabId} has a ${reserved.phase} pointer gesture; cancel it first`)
    }
  }

  private readonly onDebuggerEvent = (
    source: chrome.debugger.DebuggerSession,
    method: string,
    params?: { [name: string]: unknown },
  ): void => {
    if (source.tabId === undefined) return
    const tabId = source.tabId
    // A main-frame navigation or document.open() rewrite replaces the document: its contexts go stale,
    // and a held press may now be over the replacement.
    const frame = method === "Page.frameNavigated" && isRecord(params?.frame) ? params.frame : null
    const topLevel = frame !== null && frame.parentId === undefined
    if (replacesDocument(method, params ?? {})) {
      this.documentEpochs.set(tabId, (this.documentEpochs.get(tabId) ?? 0) + 1)
      void this.gestures.documentLost(tabId, REPLACED_WARNING)
    }
    const owner = this.leases.get(tabId)
    if (!owner) return
    for (const client of [owner, ...this.inspections.inspectorsOf(tabId)]) {
      this.connection.notify("cdp.event", { clientId: client, method, params, tabId })
    }
    // Only top-level navigations are worth a feed line; subframes fire constantly.
    if (!topLevel) return
    const { url } = frame
    if (typeof url !== "string") return
    this.logEvent("navigated", { clientId: owner, detail: shortUrl(url), tabId: source.tabId })
  }

  private readonly onDebuggerDetach = (
    source: chrome.debugger.Debuggee,
    reason: chrome.debugger.DetachReason,
  ): void => {
    if (source.tabId === undefined) return
    this.attachedTabs.delete(source.tabId)
    this.pageEvents.delete(source.tabId)
    this.attachmentEpochs.set(source.tabId, (this.attachmentEpochs.get(source.tabId) ?? 0) + 1)
    void this.gestures.targetLost(source.tabId)
    const owner = this.leases.get(source.tabId)
    if (owner) {
      this.connection.notify("cdp.detached", { clientId: owner, reason, tabId: source.tabId })
    }
    void this.persistSessionState()
  }

  private readonly onWindowRemoved = (windowId: number): void => {
    for (const [owner, id] of this.windows) {
      if (id !== windowId) continue
      this.windows.delete(owner)
      this.logEvent("window.closed", { clientId: owner, windowId })
    }
    void this.persistSessionState()
  }

  private readonly onTabRemoved = (tabId: number): void => {
    this.observeTabs.delete(tabId)
    this.background.dropTab(tabId)
    void this.persistObserveTabs().catch(() => undefined)
    const owner = this.leases.get(tabId)
    this.leases.delete(tabId)
    this.attachedTabs.delete(tabId)
    this.attachmentEpochs.set(tabId, (this.attachmentEpochs.get(tabId) ?? 0) + 1)
    if (owner) this.connection.notify("tab.closed", { clientId: owner, tabId })
    this.inspections.dropInspectors(tabId)
    void this.gestures.targetLost(tabId)
    void this.persistSessionState()
  }

  /** Only this extension's own popup page may change consent or read status. */
  private readonly onPopupMessage = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    respond: (result: PopupResult) => void,
  ): boolean => {
    if (sender.url !== this.api.runtime.getURL("popup.html")) return false
    const command = parsePopupCommand(message)
    if (!command) {
      respond({ ok: false, error: "Invalid popup command" })
      return false
    }
    void this.popupCommand(command).then(
      (status) => { respond({ ok: true, status }) },
      (cause: unknown) => { respond({ ok: false, error: errorMessage(cause) }) },
    )
    return true
  }

  /** Run a popup command and answer with the state the worker confirms afterwards. */
  private async popupCommand(command: PopupCommand): Promise<PopupStatus> {
    switch (command.type) {
      case "popup.status":
        break
      case "popup.observe":
        await this.serialized(() => this.setObserve(command.enabled))
        break
      case "popup.releaseAll":
        await this.serialized(() => this.releaseAll())
        break
    }
    return await this.popupStatus()
  }

  /** Grant or revoke agent access to the active tab. Revoking detaches and drops its lease. */
  private async setObserve(enabled: boolean): Promise<void> {
    await this.ready
    if (this.managed) throw new Error("Managed browser already permits agent tabs")
    const [tab] = await this.api.tabs.query({ active: true, currentWindow: true })
    if (tab?.id === undefined) throw new Error("No active tab")
    if (enabled) this.observeTabs.add(tab.id)
    else {
      this.observeTabs.delete(tab.id)
      // Access ends now; a reserved gesture keeps its lease until its cleanup is settled.
      this.gestures.invalidateTab(tab.id)
      const owner = this.leases.get(tab.id)
      if (owner) {
        this.connection.notify("tab.closed", { clientId: owner, tabId: tab.id })
        // Revoke is owner loss for this tab: release a held button through its own executor
        // before the debugger goes away. Cleanup stays admissible after the grant is gone.
        if (this.gestures.holds(tab.id)) await this.gestures.clientLost(owner)
      }
      this.inspections.dropInspectors(tab.id)
      await this.releaseTab(tab.id)
    }
    await this.persistObserveTabs()
  }

  private async popupStatus(): Promise<PopupStatus> {
    await this.ready
    const owners = new Set([
      ...this.leases.values(),
      ...this.windows.keys(),
      ...this.labels.keys(),
      ...this.modes.keys(),
    ])
    const tabsByOwner = new Map<string, number[]>()
    for (const [tabId, owner] of this.leases) {
      tabsByOwner.set(owner, [...(tabsByOwner.get(owner) ?? []), tabId])
    }
    const clients = await Promise.all(
      [...owners].map(async(owner) => {
        const tabIds = tabsByOwner.get(owner) ?? []
        return {
          attached: tabIds.filter((tabId) => this.attachedTabs.has(tabId)).length,
          clientId: owner,
          label: this.labels.get(owner) ?? null,
          mode: this.modes.get(owner) ?? null,
          tabs: await Promise.all(tabIds.map((tabId) => this.describeTab(tabId))),
          windowId: this.windows.get(owner) ?? null,
        }
      }),
    )
    const [active] = await this.api.tabs.query({ active: true, currentWindow: true })
    return {
      activeTabId: active?.id ?? null,
      clients,
      connected: this.connection.connected,
      events: await this.readEvents(),
      host: NATIVE_HOST_NAME,
      lastError: this.connection.lastError ?? this.recoveryError,
      leases: this.leases.size,
      managed: this.managed,
      observeEnabled: active?.id !== undefined && this.observeTabs.has(active.id),
    }
  }

  private async describeTab(tabId: number): Promise<{ id: number; title: string; url: string }> {
    try {
      const tab = await this.api.tabs.get(tabId)
      return { id: tabId, title: tab.title ?? "", url: tab.url ?? "" }
    } catch {
      return { id: tabId, title: "", url: "" }
    }
  }
}

