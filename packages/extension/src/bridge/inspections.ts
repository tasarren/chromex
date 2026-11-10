import { type InspectRequest, parseInspection, runInspection, type RpcRequest } from "@chromex/protocol"
import { type GestureAuthority, type GestureBinding } from "../gesture-authority.ts"
import { isRecord } from "../session-state.ts"
import {
  MAX_PIPE_INSPECTIONS,
  PIPE_URL,
  clientId,
  numberParam,
  tabInfo,
  tokenParam,
  type BridgeApi,
  type PipeInspection,
} from "./params.ts"

type InspectionHost = {
  readonly api: BridgeApi
  readonly attachedTabs: ReadonlySet<number>
  readonly gestures: GestureAuthority
  readonly leases: ReadonlyMap<number, string>
  readonly isManaged: () => boolean
  readonly assertSettled: () => void
  readonly assertTabAccess: (tabId: number) => void
  readonly isCurrent: (binding: GestureBinding) => boolean
  readonly notifyClosed: (clientId: string, tabId: number) => void
}

/**
 * Owns tab inspection: the controller a client reads, pending pipe reads, and the count of reads
 * sending commands over a debugger session.
 */
export class Inspections {
  private readonly host: InspectionHost
  /** Client to the tab it reads without controlling; it receives that tab's debugger events. */
  private readonly inspectors = new Map<string, number>()
  /** Single-use reads of a pipe-driven tab, run by the Managed service, keyed by token. */
  private readonly inspections = new Map<string, PipeInspection>()
  /** Inspection reads currently sending commands over a controller's debugger session. */
  private reads = 0

  constructor(host: InspectionHost) {
    this.host = host
  }

  busy(): boolean {
    return this.inspectors.size > 0 || this.inspections.size > 0 || this.reads > 0
  }

  inspectorsOf(tabId: number): string[] {
    return [...this.inspectors].flatMap(([client, inspected]) => (inspected === tabId ? [client] : []))
  }

  /** End the client's inspection and invalidate its pending reads. */
  dropInspection(client: string): void {
    this.inspectors.delete(client)
    for (const [token, read] of this.inspections) {
      if (read.client === client) this.inspections.delete(token)
    }
  }

  dropTab(tabId: number): void {
    for (const [token, read] of this.inspections) {
      if (read.tabId === tabId) this.inspections.delete(token)
    }
  }

  /** The tab is gone or no longer granted: its readers lose it like its controller does. */
  dropInspectors(tabId: number): void {
    for (const client of this.inspectorsOf(tabId)) {
      this.inspectors.delete(client)
      this.host.notifyClosed(client, tabId)
    }
    this.dropTab(tabId)
  }

  /**
   * Read a tab another client controls. Reads use the fixed inspection set over the controller's
   * debugger session, or a single-use token the Managed service runs for a pipe-driven page. Every
   * command rechecks access and the controller, so a revoke or handoff stops the read midway.
   * ponytail: a tab without a controller cannot be inspected; claim it with chrome_use_tab instead.
   */
  async inspection(request: RpcRequest): Promise<unknown> {
    const params = request.params
    const client = clientId(params)
    switch (request.method) {
      case "tabs.inspect": {
        const tabId = numberParam(params, "tabId")
        // Re-admission replaces the client's earlier inspection and its pending reads.
        this.dropInspection(client)
        this.host.assertTabAccess(tabId)
        const controller = this.controllerOf(tabId)
        if (controller === client) throw new Error(`Tab ${tabId} is controlled by this client`)
        const tab = tabInfo(await this.host.api.tabs.get(tabId))
        // A claim, release, revoke or close can land while the tab is read; admit only an unchanged tab.
        this.assertReadable(tabId, controller)
        this.inspectors.set(client, tabId)
        return tab
      }
      case "tabs.uninspect":
        this.dropInspection(client)
        return {}
      case "cdp.ownerInspect": {
        const { client, tabId } = this.requireLease(params)
        const inspect = parseInspection(isRecord(params) ? params.request : undefined)
        const binding = this.host.gestures.inspectionBinding(client, tabId, (held) => this.host.isCurrent(held))
        if (this.host.attachedTabs.has(tabId)) {
          const result = await this.readAttached(tabId, inspect, client, client, true, binding)
          await this.host.gestures.renew(client, tabId, (held) => this.host.isCurrent(held))
          return result
        }
        // A pipe page has no extension debugger. The service reads through the exact target session
        // without reserving input, so owner inspection remains available while a button is held.
        if (!this.host.isManaged() || !PIPE_URL.test((await this.host.api.tabs.get(tabId)).url ?? "")) {
          throw new Error(`Debugger is not attached to tab ${tabId}`)
        }
        this.host.assertTabAccess(tabId)
        if (this.host.leases.get(tabId) !== client) throw new Error(`Tab ${tabId} changed controller during the read; retry it`)
        return this.issuePipeInspection(client, tabId, client, inspect, true, binding)
      }
      case "cdp.inspect": {
        const tabId = numberParam(params, "tabId")
        this.assertInspecting(client, tabId)
        const inspect = parseInspection(isRecord(params) ? params.request : undefined)
        const controller = this.controllerOf(tabId)
        if (this.host.attachedTabs.has(tabId)) {
          return await this.readAttached(tabId, inspect, client, controller, false)
        }
        // A parked ordinary tab has no debugger on purpose; only an internal page is read over the pipe.
        if (!this.host.isManaged() || !PIPE_URL.test((await this.host.api.tabs.get(tabId)).url ?? "")) {
          throw new Error(`Debugger is not attached to tab ${tabId}`)
        }
        this.assertInspecting(client, tabId)
        this.assertReadable(tabId, controller)
        return this.issuePipeInspection(client, tabId, controller, inspect)
      }
      case "inspect.begin": {
        const token = tokenParam(params)
        const read = this.checkInspection(token, "issued")
        read.phase = "beginning"
        try {
          const target = (await this.host.api.debugger.getTargets()).find((t) => t.tabId === read.tabId)
          if (!target) throw new Error(`No debugger target for tab ${read.tabId}`)
          if (read.binding && target.id !== read.binding.targetId) throw new Error("The held pointer target changed")
          // The target lookup awaited; recheck before the service may send a command to it.
          this.checkInspection(token, "beginning")
          read.phase = "begun"
          read.targetId = target.id
          return { request: read.request, ...(read.binding?.sessionId ? { sessionId: read.binding.sessionId } : {}), targetId: target.id }
        } catch(cause) {
          this.inspections.delete(token)
          throw cause
        }
      }
      // The service asks before each command and before it returns the result.
      case "inspect.step":
        this.checkInspection(tokenParam(params), "begun")
        return {}
      case "inspect.end": {
        const token = tokenParam(params)
        try {
          const read = this.checkInspection(token, "begun")
          // The target must still be this tab's page: a closed tab or swapped target fails the read.
          const target = (await this.host.api.debugger.getTargets()).find((t) => t.id === read.targetId)
          if (target?.tabId !== read.tabId) throw new Error(`Tab ${read.tabId} changed during the read; retry it`)
          this.checkInspection(token, "begun")
          if (read.owner) await this.host.gestures.renew(read.client, read.tabId, (held) => this.host.isCurrent(held))
          return {}
        } finally {
          this.inspections.delete(token)
        }
      }
      default:
        throw new Error(`Unsupported extension method: ${request.method}`)
    }
  }

  private controllerOf(tabId: number): string {
    const controller = this.host.leases.get(tabId)
    if (controller === undefined) {
      throw new Error(`Tab ${tabId} has no controlling agent to inspect; use chrome_use_tab to control it`)
    }
    return controller
  }

  private assertInspecting(client: string, tabId: number): void {
    if (this.inspectors.get(client) !== tabId) throw new Error(`Tab ${tabId} is not inspected by this client`)
  }

  /**
   * The pipe read is still admitted: its inspector, grant and controller are unchanged and it is in
   * the expected phase. Any failure invalidates the token, so a later step cannot revive it.
   */
  private checkInspection(token: string, phase: PipeInspection["phase"]): PipeInspection {
    const read = this.inspections.get(token)
    try {
      if (read?.phase !== phase) throw new Error("Unknown inspection")
      if (!read.owner) this.assertInspecting(read.client, read.tabId)
      this.assertReadable(read.tabId, read.controller)
      if (read.binding && !this.host.isCurrent(read.binding)) throw new Error("The held page document or session changed")
      return read
    } catch(cause) {
      this.inspections.delete(token)
      throw cause
    }
  }

  private async readAttached(
    tabId: number,
    inspect: InspectRequest,
    client: string,
    controller: string,
    owner: boolean,
    binding: GestureBinding | null = null,
  ): Promise<{ result: unknown }> {
    const readable = () => {
      if (owner) this.assertReadable(tabId, client)
      else {
        this.assertInspecting(client, tabId)
        this.assertReadable(tabId, controller)
      }
      if (!this.host.attachedTabs.has(tabId)) throw new Error(`Debugger is not attached to tab ${tabId}`)
      if (binding && !this.host.isCurrent(binding)) throw new Error("The held page document or session changed")
    }
    this.reads += 1
    try {
      const result = await runInspection(inspect, async(method, commandParams) => {
        readable()
        return await this.host.api.debugger.sendCommand({ tabId }, method, commandParams)
      })
      readable()
      return { result }
    } finally {
      this.reads -= 1
    }
  }

  private issuePipeInspection(client: string, tabId: number, controller: string, inspect: InspectRequest, owner = false, binding: GestureBinding | null = null): { token: string } {
    const pending = [...this.inspections].filter(([, read]) => read.client === client)
    for (const [token] of pending.slice(0, Math.max(0, pending.length - MAX_PIPE_INSPECTIONS + 1))) {
      this.inspections.delete(token)
    }
    const token = crypto.randomUUID()
    this.inspections.set(token, { binding, client, controller, owner, phase: "issued", request: inspect, tabId, targetId: null })
    return { token }
  }

  /** The tab is still granted and still controlled by the client the read was admitted under. */
  private assertReadable(tabId: number, controller: string): void {
    this.host.assertTabAccess(tabId)
    if (this.host.leases.get(tabId) !== controller) throw new Error(`Tab ${tabId} changed controller during the read; retry it`)
  }

  private requireLease(params: unknown): { client: string; tabId: number } {
    const client = clientId(params)
    this.host.assertSettled()
    const tabId = numberParam(params, "tabId")
    this.host.assertTabAccess(tabId)
    if (this.host.leases.get(tabId) !== client) {
      throw new Error(`Tab ${tabId} is not leased by this Codex client`)
    }
    return { client, tabId }
  }
}
