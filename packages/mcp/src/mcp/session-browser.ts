import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TabInfo } from "../protocol/schema.js";
import { BrokerClient } from "./broker-client.js";
import { BrowserController } from "./browser-controller.js";
import { OriginPolicy } from "./origin-policy.js";
import type { ManagedProcessOutputQuery, ManagedProcessOutputResult } from "./process-output.js";
import { SharedBrowser } from "./shared-browser.js";

type Root = { uri: string };
export type BrowserOptions = {
  browserId?: string | undefined;
  profile?: string | undefined;
  project?: string | undefined;
  temporary?: boolean | undefined;
  observe?: boolean | undefined;
};

export class SessionBrowser {
  readonly policy = new OriginPolicy();
  private activeController: BrowserController | null = null;
  private managed: SharedBrowser | null = null;
  private options: BrowserOptions = {};
  private observing = false;
  private closed = false;
  private pending: Promise<BrowserController> | null = null;

  constructor(private readonly listRoots: () => Promise<{ roots: Root[] }>) {}

  async initialize(): Promise<void> {
    await this.policy.load();
  }

  async controller(options: BrowserOptions = {}): Promise<BrowserController> {
    // Serialize connection changes, including simultaneous first-use calls.
    const previous = this.pending;
    const pending = (async () => {
      await previous?.catch(() => undefined);
      if (this.closed) throw new Error("Browser session closed");
      const hasManagedOptions = [
        options.browserId,
        options.project,
        options.profile,
        options.temporary,
      ].some((value) => value !== undefined);
      if (options.observe && hasManagedOptions)
        throw new Error("Observe cannot select a Managed browser or profile");
      const observe = options.observe ?? (hasManagedOptions ? false : this.observing);
      const changed =
        observe !== this.observing ||
        ["browserId", "profile", "project", "temporary"].some((key) => {
          const name = key as keyof BrowserOptions;
          return options[name] !== undefined && options[name] !== this.options[name];
        });
      if (changed) {
        await this.activeController?.close().catch(() => undefined);
        await this.managed?.close();
        this.activeController = null;
        this.managed = null;
        this.options = options;
      }
      this.observing = observe;
      if (observe) {
        if (!this.activeController) {
          this.activeController = new BrowserController(
            new BrokerClient({ mode: "observe" }),
            this.policy,
          );
          await this.activeController.initialize();
        }
        return this.activeController;
      }
      if (this.managed) {
        try {
          const same = await this.managed.ensure();
          if (same && this.activeController) return this.activeController;
          this.activeController = new BrowserController(this.managed.broker, this.policy, true);
          await this.activeController.initialize();
          return this.activeController;
        } catch (cause) {
          if (!["ENOENT", "ECONNREFUSED"].includes((cause as NodeJS.ErrnoException).code ?? ""))
            throw cause;
        }
        await this.managed.close();
        this.managed = null;
        this.activeController = null;
      }
      const selected = { ...this.options, ...options };
      const projectPath = await resolveManagedProject(
        selected.project,
        selected.project || selected.browserId
          ? []
          : (await this.listRoots().catch(() => ({ roots: [] }))).roots,
      );
      this.managed = await SharedBrowser.connect(
        { projectPath, profile: selected.profile, temporary: selected.temporary },
        selected.browserId,
      );
      this.options = {
        project: this.managed.record.projectPath,
        profile: this.managed.record.profile,
        temporary: this.managed.record.temporary,
        browserId: this.managed.record.browserId,
      };
      await this.managed.ensure();
      this.activeController = new BrowserController(this.managed.broker, this.policy, true);
      await this.activeController.initialize();
      return this.activeController;
    })();
    this.pending = pending;
    try {
      return await pending;
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }

  async status(options: BrowserOptions = {}): Promise<unknown> {
    const controller = await this.controller(options);
    return {
      ...((await controller.status()) as Record<string, unknown>),
      mode: this.observing ? "observe" : "managed",
      ...(this.managed
        ? {
            managed: {
              browserId: this.managed.record.browserId,
              profile: this.managed.record.profile,
              project: this.managed.record.projectPath,
              temporary: this.managed.record.temporary,
            },
          }
        : {}),
    };
  }

  async tabs(options: BrowserOptions = {}): Promise<TabInfo[]> {
    return await (await this.controller(options)).tabs();
  }

  async useTab(tabId: number, options: BrowserOptions = {}): Promise<TabInfo> {
    return await (await this.controller(options)).useTab(tabId);
  }

  async open(url: string, options: BrowserOptions = {}): Promise<TabInfo> {
    this.policy.assertAllowed(url);
    return await (await this.controller({ ...options, observe: false })).open(url);
  }

  async processOutput(query: ManagedProcessOutputQuery): Promise<ManagedProcessOutputResult> {
    if (!this.managed) throw new Error("No Managed Chromium process diagnostics are available");
    return await this.managed.output(query, this.policy.list());
  }

  async release(): Promise<void> {
    await this.activeController?.release();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.pending?.catch(() => undefined);
    try {
      await this.activeController?.close();
    } finally {
      await this.managed?.close();
    }
  }
}

export async function resolveManagedProject(
  explicit: string | undefined,
  roots: Root[],
): Promise<string> {
  if (explicit !== undefined)
    return await realpath(
      resolve(explicit.startsWith("file:") ? fileURLToPath(explicit) : explicit),
    );
  const paths = roots.flatMap((root) => {
    try {
      const url = new URL(root.uri);
      return url.protocol === "file:" ? [fileURLToPath(url)] : [];
    } catch {
      return [];
    }
  });
  const canonical = [...new Set(await Promise.all(paths.map((path) => realpath(path))))];
  if (canonical.length > 1)
    throw new Error("Managed mode found multiple MCP roots; pass project explicitly");
  return canonical[0] ?? (await realpath(process.cwd()));
}
