export type ConsoleEntry = {
  level: string;
  line?: number | undefined;
  source?: string | undefined;
  text: string;
  ts: number;
}

export type NetworkEntry = {
  failure?: string | undefined;
  method: string;
  ms?: number | undefined;
  status?: number | undefined;
  type?: string | undefined;
  url: string;
}

const CAPACITY = 200
const MAX_TEXT = 2_000

/**
 * Buffers console and network activity for the controlled tab. Fixed capacity: a chatty page must
 * not grow this without bound.
 */
export class PageActivity {
  private consoleEntries: ConsoleEntry[] = []
  private networkEntries = new Map<string, NetworkEntry & { startedAt: number }>()
  private order: string[] = []

  clear(): void {
    this.consoleEntries = []
    this.networkEntries.clear()
    this.order = []
  }

  console(level: "error" | "warn" | "all" = "all"): ConsoleEntry[] {
    if (level === "all") return [...this.consoleEntries]
    const wanted = level === "error" ? ["error", "assert"] : ["error", "assert", "warning", "warn"]
    return this.consoleEntries.filter((entry) => wanted.includes(entry.level))
  }

  network(status: "failed" | "all" = "failed"): NetworkEntry[] {
    const entries = this.order
      .map((id) => this.networkEntries.get(id))
      .filter((entry): entry is NetworkEntry & { startedAt: number } => entry !== undefined)
      .map(({ startedAt: _startedAt, ...entry }) => entry)
    return status === "all"
      ? entries
      : entries.filter(
        (entry) =>
          entry.failure !== undefined || entry.status === undefined || entry.status >= 400,
      )
  }

  /** Record one CDP event. Unrecognized methods are ignored. */
  record(method: string, params: unknown, now: number): void {
    const data = record(params)
    switch (method) {
      case "Runtime.consoleAPICalled":
        this.pushConsole({
          level: stringOrUndefined(data.type) ?? "log",
          text: describeArgs(data.args),
          ts: now,
          ...frameOf(data.stackTrace),
        })
        return

      case "Runtime.exceptionThrown": {
        const details = record(data.exceptionDetails)
        const thrown = record(details.exception)
        this.pushConsole({
          level: "error",
          line: numberOrUndefined(details.lineNumber),
          source: stringOrUndefined(details.url),
          text: truncate(
            stringOrUndefined(thrown.description) ??
              stringOrUndefined(details.text) ??
              "Uncaught exception",
          ),
          ts: now,
        })
        return
      }

      case "Log.entryAdded": {
        const entry = record(data.entry)
        this.pushConsole({
          level: stringOrUndefined(entry.level) ?? "log",
          line: numberOrUndefined(entry.lineNumber),
          source: stringOrUndefined(entry.url),
          text: truncate(stringOrUndefined(entry.text) ?? ""),
          ts: now,
        })
        return
      }

      case "Network.requestWillBeSent": {
        const id = stringOrUndefined(data.requestId)
        const request = record(data.request)
        if (!id) return
        if (!this.networkEntries.has(id)) this.order.push(id)
        this.networkEntries.set(id, {
          method: stringOrUndefined(request.method) ?? "GET",
          startedAt: now,
          type: stringOrUndefined(data.type),
          url: stringOrUndefined(request.url) ?? "",
        })
        this.evictNetwork()
        return
      }

      case "Network.responseReceived": {
        const existing = this.existing(data.requestId)
        if (!existing) return
        const response = record(data.response)
        existing.ms = now - existing.startedAt
        existing.status = numberOrUndefined(response.status)
        existing.type = stringOrUndefined(data.type) ?? existing.type
        return
      }

      case "Network.loadingFailed": {
        const existing = this.existing(data.requestId)
        if (!existing) return
        existing.failure =
          stringOrUndefined(data.errorText) ??
          (data.canceled === true ? "canceled" : "Request failed")
        existing.ms = now - existing.startedAt
        return
      }

      default:
        return
    }
  }

  private existing(requestId: unknown): (NetworkEntry & { startedAt: number }) | undefined {
    const id = stringOrUndefined(requestId)
    return id === undefined ? undefined : this.networkEntries.get(id)
  }

  private pushConsole(entry: ConsoleEntry): void {
    this.consoleEntries.push(entry)
    if (this.consoleEntries.length > CAPACITY) this.consoleEntries.shift()
  }

  private evictNetwork(): void {
    while (this.order.length > CAPACITY) {
      const oldest = this.order.shift()
      if (oldest !== undefined) this.networkEntries.delete(oldest)
    }
  }
}

/**
 * Summarize console arguments from their CDP RemoteObject previews. Object graphs are described,
 * never walked — a logged DOM tree must not become the whole response.
 */
function describeArgs(args: unknown): string {
  if (!Array.isArray(args)) return ""
  return truncate(
    args
      .map((argument) => {
        const object = record(argument)
        const { value } = object
        // Primitives print as values. Objects use CDP's short description, never a serialized graph.
        switch (typeof value) {
          case "string":
            return value
          case "number":
          case "boolean":
            return String(value)
        }
        if (value === null) return "null"
        return (
          stringOrUndefined(object.description) ??
          stringOrUndefined(object.className) ??
          stringOrUndefined(object.subtype) ??
          stringOrUndefined(object.type) ??
          ""
        )
      })
      .join(" "),
  )
}

function frameOf(stackTrace: unknown): { line?: number; source?: string } {
  const frames: unknown = record(stackTrace).callFrames
  const top = record(Array.isArray(frames) ? frames[0] : undefined)
  const line = numberOrUndefined(top.lineNumber)
  const source = stringOrUndefined(top.url)
  return { ...(line === undefined ? {} : { line }), ...(source === undefined ? {} : { source }) }
}

function truncate(value: string): string {
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value
}

/** CDP event payloads are arbitrary JSON; read them as records without trusting their shape. */
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? { ...value } : {}
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}
