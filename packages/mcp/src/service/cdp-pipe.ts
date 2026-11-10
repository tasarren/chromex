import type { ChildProcess } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import { z } from "zod"

const MessageSchema = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.object({ sessionId: z.string().optional() }).loose().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ message: z.string() }).optional(),
  sessionId: z.string().optional(),
})

type Pending = { resolve: (result: Record<string, unknown>) => void; reject: (cause: Error) => void }
/** A CDP event; `sessionId` names the page session it came from, absent for browser-level events. */
export type CdpEvent = { method: string; params: Record<string, unknown>; sessionId: string | undefined }

/** Chromium answered the command with an error, so its outcome is known; timeouts and pipe loss are not. */
export class CdpCommandError extends Error {
  override name = "CdpCommandError"
}

/** Browser-level CDP over Chromium's `--remote-debugging-pipe` (fd 3 in, fd 4 out, NUL-framed). */
export class CdpPipe {
  private readonly input: Writable
  private readonly pending = new Map<number, Pending>()
  /** Flattened page sessions by target ID; Chromium reports when one ends. */
  private readonly sessions = new Map<string, Promise<string>>()
  /** Target of each attached session, so a detach by session ID evicts the right cache entry. */
  private readonly targets = new Map<string, string>()
  private readonly listeners = new Set<(event: CdpEvent) => void>()
  private buffer = ""
  private closed: Error | null = null
  private next = 0

  constructor(child: ChildProcess) {
    const input = child.stdio[3] as Writable | null | undefined
    const output = child.stdio[4] as Readable | null | undefined
    if (!input || !output) throw new Error("Chromium was started without a CDP pipe")
    this.input = input
    input.on("error", (cause) => { this.fail(cause) })
    output.setEncoding("utf8")
    output.on("data", (chunk: string) => { this.receive(chunk) })
    output.on("error", (cause) => { this.fail(cause) })
    output.once("close", () => { this.fail(new Error("Chromium CDP pipe closed")) })
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(this.closed)
    const id = ++this.next
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out`))
      }, 10_000)
      timer.unref()
      this.pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result) },
        reject: (cause) => { clearTimeout(timer); reject(cause) },
      })
      this.input.write(`${JSON.stringify({ id, method, params, sessionId })}\0`)
    })
  }

  /** Attach once to a page target and reuse the session, so object IDs stay valid across calls. */
  async session(targetId: string): Promise<string> {
    let session = this.sessions.get(targetId)
    if (!session) {
      session = this.send("Target.attachToTarget", { targetId, flatten: true }).then((result) => {
        const { sessionId } = z.object({ sessionId: z.string() }).parse(result)
        this.targets.set(sessionId, targetId)
        return sessionId
      })
      this.sessions.set(targetId, session)
      void session.catch(() => this.sessions.delete(targetId))
    }
    return await session
  }

  /** Observe events in arrival order, before the replies that follow them are resolved. */
  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    for (let end = this.buffer.indexOf("\0"); end !== -1; end = this.buffer.indexOf("\0")) {
      const message = MessageSchema.safeParse(JSON.parse(this.buffer.slice(0, end)))
      this.buffer = this.buffer.slice(end + 1)
      if (!message.success) continue
      const { id, method, params } = message.data
      if (id === undefined) {
        if (method === undefined) continue
        // `sessionId` is required on detach; the deprecated `targetId` may be absent.
        if (method === "Target.detachedFromTarget" && params?.sessionId) this.forget(params.sessionId)
        if (method === "Target.targetDestroyed" && typeof params?.targetId === "string") {
          this.sessions.delete(params.targetId)
          for (const [session, target] of this.targets) {
            if (target === params.targetId) this.targets.delete(session)
          }
        }
        const event = { method, params: params ?? {}, sessionId: message.data.sessionId }
        for (const listener of this.listeners) listener(event)
        continue
      }
      const waiter = this.pending.get(id)
      if (!waiter) continue
      this.pending.delete(id)
      if (message.data.error) waiter.reject(new CdpCommandError(message.data.error.message))
      else waiter.resolve(message.data.result ?? {})
    }
  }

  private forget(sessionId: string): void {
    const targetId = this.targets.get(sessionId)
    this.targets.delete(sessionId)
    if (targetId !== undefined) this.sessions.delete(targetId)
  }

  private fail(cause: Error): void {
    this.closed ??= cause
    for (const waiter of this.pending.values()) waiter.reject(cause)
    this.pending.clear()
  }
}
