import type { TabInfo } from "@chromex/protocol"
import { z } from "zod"
import { BrokerClient } from "../shared/broker-client.ts"
import { BrowserController } from "./browser-controller.ts"
import { applyConfiguredExtensions } from "../shared/extension-list.ts"
import type { ManagedProcessOutputQuery, ManagedProcessOutputResult } from "../shared/process-output.ts"
import { SharedBrowser } from "./shared-browser.ts"
import type { Workspace } from "../shared/workspace.ts"

/** MCP tool inputs that select a Managed browser. */
export const sessionOptions = {
  browserId: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,180}$/)
    .optional(),
  profile: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .optional(),
  temporary: z.boolean().optional(),
}
export const connectionOptions = { ...sessionOptions, observe: z.boolean().optional() }
export type BrowserOptions = z.infer<z.ZodObject<typeof connectionOptions>>
const sessionKeys = z.object(sessionOptions).keyof().options

export class SessionBrowser {
  private activeController: BrowserController | null = null
  private managed: SharedBrowser | null = null
  private options: BrowserOptions = {}
  private observing = false
  private closed = false
  private pending: Promise<BrowserController> | null = null
  /** True when this client attached to a browser that was already running. */
  private joinedExisting = false
  /** An explicit selection failed; a later call without selectors must not fall back to the default. */
  private selectionFailed = false
  private readonly defaultProfile: string | undefined
  /** Configured `--extension`/`CHROMEX_EXTENSIONS` directories not yet installed in this profile. */
  private configuredExtensions: string[]
  private readonly resolveWorkspace: () => Promise<Workspace>
  private workspace: Workspace | undefined

  /**
   * `resolveWorkspace` runs on the first Managed request only; a failure refuses that request while
   * Observe and diagnostics keep working. The first success binds this server for its lifetime.
   */
  constructor(
    resolveWorkspace: () => Promise<Workspace>,
    defaultProfile?: string,
    configuredExtensions: readonly string[] = [],
  ) {
    this.resolveWorkspace = resolveWorkspace
    this.defaultProfile = defaultProfile
    this.configuredExtensions = [...configuredExtensions]
  }

  async controller(options: BrowserOptions = {}): Promise<BrowserController> {
    // Serialize connection changes, including simultaneous first-use calls.
    const previous = this.pending
    const pending = (async() => {
      await previous?.catch(() => undefined)
      if (this.closed) throw new Error("Browser session closed")
      const hasManagedOptions = sessionKeys.some((name) => options[name] !== undefined)
      if (options.observe && hasManagedOptions)
        throw new Error("Observe cannot select a Managed browser or profile")
      const observe = options.observe ?? (hasManagedOptions ? false : this.observing)
      const changed =
        observe !== this.observing ||
        sessionKeys.some(
          (name) => options[name] !== undefined && options[name] !== this.options[name],
        )
      if (changed) {
        await this.activeController?.close().catch(() => undefined)
        await this.managed?.close()
        this.activeController = null
        this.managed = null
        // Remembered only after a connection succeeds, so a refused selector is not retried later.
        this.options = {}
      }
      this.observing = observe
      if (observe) {
        this.selectionFailed = false
        if (!this.activeController) {
          this.activeController = new BrowserController(new BrokerClient({ mode: "observe" }))
        }
        return this.activeController
      }
      if (this.managed) {
        try {
          const same = await this.managed.ensure()
          if (!same) this.joinedExisting = false
          await this.applyConfiguredExtensions()
          if (same && this.activeController) return this.activeController
          this.activeController = new BrowserController(this.managed.broker, true, this.managed)
          return this.activeController
        } catch(cause) {
          const code = cause instanceof Error && "code" in cause ? cause.code : undefined
          if (code !== "ENOENT" && code !== "ECONNREFUSED") throw cause
        }
        await this.managed.close()
        this.managed = null
        this.activeController = null
      }
      if (this.selectionFailed && !hasManagedOptions) {
        throw new Error("The last Managed browser selection failed; pass browserId, profile or temporary to choose one")
      }
      const selected = { ...this.options, ...options }
      this.workspace ??= await this.resolveWorkspace()
      // With a browser ID, only selectors the caller gave must match it; the server default does not.
      const profile = selected.browserId === undefined ? selected.profile ?? this.defaultProfile : selected.profile
      try {
        this.managed = await SharedBrowser.connect(
          { profile, temporary: selected.temporary, workspace: this.workspace },
          selected.browserId,
        )
      } catch(cause) {
        if (hasManagedOptions) this.selectionFailed = true
        throw cause
      }
      this.selectionFailed = false
      this.options = {
        profile: this.managed.record.profile,
        temporary: this.managed.record.temporary,
        browserId: this.managed.record.browserId,
      }
      // A service that already runs a browser keeps its bridge config across ensure().
      this.joinedExisting = await this.managed.ensure()
      await this.applyConfiguredExtensions()
      this.activeController = new BrowserController(this.managed.broker, true, this.managed)
      return this.activeController
    })()
    this.pending = pending
    try {
      return await pending
    } finally {
      if (this.pending === pending) this.pending = null
    }
  }

  /** True while this session controls Observe tabs; mouse gestures are Managed-only (DEC-65). */
  get observe(): boolean {
    return this.observing
  }

  async status(options: BrowserOptions = {}) {
    const controller = await this.controller(options)
    return {
      ...(await controller.status()),
      mode: this.observing ? "observe" : "managed",
      ...(this.managed
        ? {
          managed: {
            browserId: this.managed.record.browserId,
            joinedExisting: this.joinedExisting,
            profile: this.managed.record.profile,
            temporary: this.managed.record.temporary,
            workspace: this.managed.record.workspace.root,
          },
        }
        : {}),
    }
  }

  async tabs(options: BrowserOptions = {}): Promise<TabInfo[]> {
    return await (await this.controller(options)).tabs()
  }

  async useTab(tabId: number, inspect: boolean, options: BrowserOptions = {}): Promise<TabInfo> {
    const controller = await this.controller(options)
    return inspect ? await controller.inspectTab(tabId) : await controller.useTab(tabId)
  }

  async open(
    url: string,
    options: BrowserOptions = {},
  ): Promise<TabInfo & { joinedExisting: boolean }> {
    const tab = await (await this.controller({ ...options, observe: false })).open(url)
    return { ...tab, joinedExisting: this.joinedExisting }
  }

  /**
   * Install configured extension directories through the profile's service. This covers a browser
   * that is already running, and the service stays the only writer of the profile's launch list.
   * A directory that fails to install is reported and skipped; the session keeps working.
   */
  private async applyConfiguredExtensions(): Promise<void> {
    if (this.configuredExtensions.length === 0 || !this.managed) return
    const { profile, temporary } = this.managed.record
    if (temporary || profile !== (this.defaultProfile ?? "default")) return
    const managed = this.managed
    this.configuredExtensions = [
      ...(await applyConfiguredExtensions(
        this.configuredExtensions,
        async(paths) => await managed.configureExtensions(paths),
        (message) => process.stderr.write(`${message}\n`),
      )),
    ]
  }

  /** Run an unpacked-extension method in this session's Managed browser service. */
  async extension<Method extends "extensionInstall" | "extensionList" | "extensionRemove">(
    method: Method,
    params: { id?: string | undefined; path?: string | undefined },
    options: BrowserOptions = {},
  ) {
    await this.controller({ ...options, observe: false })
    if (!this.managed) throw new Error("Managed browser is not connected")
    return await this.managed.extension(method, params)
  }

  async processOutput(query: ManagedProcessOutputQuery): Promise<ManagedProcessOutputResult> {
    if (!this.managed) throw new Error("No Managed Chromium process diagnostics are available")
    return await this.managed.output(query)
  }

  async release(): Promise<void> {
    await this.activeController?.release()
  }

  async close(): Promise<void> {
    this.closed = true
    await this.pending?.catch(() => undefined)
    try {
      await this.activeController?.close()
    } finally {
      await this.managed?.close()
    }
  }
}
