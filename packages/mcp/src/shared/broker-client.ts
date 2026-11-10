import { randomUUID } from "node:crypto"
import { createConnection, type Socket } from "node:net"
import { basename } from "node:path"
import { errorMessage, PROTOCOL_VERSION } from "@chromex/protocol"
import {
  BrokerHelloResultSchema,
  BrokerNotificationSchema,
  BrokerResponseSchema,
} from "./schema.ts"
import { loadBridgeConfig } from "./config.ts"
import { encodeFrame, FrameDecoder } from "./framing.ts"
import { bridgeConfigPath } from "./paths.ts"

type Pending = {
  reject(cause: Error): void;
  resolve(value: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

type BrokerClientOptions = {
  configPath?: string | undefined;
  mode?: "managed" | "observe" | undefined;
  /** Private Managed-service credential; the native host never gives it to an agent client. */
  serviceKey?: string | undefined;
}

/** The bridge answered with an error: the request reached it and was refused, not lost. */
export class BrokerRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BrokerRefusal"
  }
}

/** The authentication in progress on one socket; it settles exactly once. */
type Handshake = { socket: Socket; finish(cause?: Error): void }

export class BrokerClient {
  readonly clientId = randomUUID()
  private readonly configPath: string
  private readonly label: string
  private readonly mode: "managed" | "observe" | undefined
  private readonly serviceKey: string | undefined
  private closed = false
  private connected: Promise<void> | null = null
  private generation = 0
  private handshake: Handshake | null = null
  private notificationHandler: ((method: string, params: unknown) => void) | null = null
  private pending = new Map<string, Pending>()
  private sequence = 1
  private socket: Socket | null = null

  constructor(options: BrokerClientOptions = {}) {
    this.configPath = options.configPath ?? bridgeConfigPath()
    this.mode = options.mode
    this.serviceKey = options.serviceKey
    this.label = clientLabel()
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler
  }

  /** Send one broker request. The result is unchecked JSON; the caller validates it. */
  async request(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<unknown> {
    await this.connect()
    const socket = this.socket
    if (this.closed) throw new Error("Chromium bridge client closed")
    if (!socket) throw new Error("Chromium bridge is not connected")
    const id = `${this.clientId}-${this.sequence++}`
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Chromium bridge request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { reject, resolve, timer })
      socket.write(encodeFrame({ id, kind: "request", method, params }))
    })
  }

  /**
   * Final: a closed client never reconnects, so its client ID cannot re-register after the host
   * released it. Transport loss without `close()` still reconnects on the next request. Closing is
   * synchronous; the promise keeps the shared owner `close()` shape.
   */
  close(): Promise<void> {
    this.closed = true
    this.generation += 1
    this.connected = null
    const socket = this.socket
    if (socket) this.disconnect(socket, new Error("Chromium bridge client closed"))
    return Promise.resolve()
  }

  private async connect(): Promise<void> {
    if (this.closed) throw new Error("Chromium bridge client closed")
    if (this.connected) {
      await this.connected
      return
    }
    if (this.socket && !this.socket.destroyed) return
    const connected = this.open()
    this.connected = connected
    try {
      await connected
    } finally {
      if (this.connected === connected) this.connected = null
    }
  }

  private async open(): Promise<void> {
    const generation = this.generation
    const config = await loadBridgeConfig(this.configPath)
    if (generation !== this.generation) throw new Error("Chromium bridge client closed")
    const decoder = new FrameDecoder()
    const socket = createConnection(config.socketPath)
    this.socket = socket
    const authenticated = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => { this.disconnect(socket, new Error("Chromium bridge authentication timed out")) },
        5_000,
      )
      this.handshake = {
        socket,
        finish: (cause) => {
          clearTimeout(timer)
          if (this.handshake?.socket === socket) this.handshake = null
          if (cause) reject(cause)
          else resolve()
        },
      }
    })
    socket.on("data", (chunk) => { this.onData(socket, decoder, Buffer.from(chunk)) })
    socket.on("error", (cause) => { this.disconnect(socket, new Error(errorMessage(cause))) })
    socket.on("close", () => { this.disconnect(
      socket,
      new Error(
        this.handshake?.socket === socket
          ? "Chromium bridge disconnected during authentication"
          : "Chromium bridge disconnected",
      ),
    ) },
    )
    socket.once("connect", () => {
      socket.write(
        encodeFrame({
          kind: "hello",
          clientId: this.clientId,
          label: this.label,
          ...(this.mode === undefined ? {} : { mode: this.mode }),
          ...(this.serviceKey === undefined ? {} : { serviceKey: this.serviceKey }),
          token: config.token,
        }),
      )
    })
    await authenticated
  }

  private onData(socket: Socket, decoder: FrameDecoder, chunk: Buffer): void {
    if (this.socket !== socket) return
    try {
      for (const value of decoder.push(chunk)) {
        if (this.socket !== socket) return
        if (this.handshake?.socket === socket) {
          this.authenticate(socket, value)
          continue
        }
        const response = BrokerResponseSchema.safeParse(value)
        if (response.success) {
          const match = this.pending.get(response.data.id)
          if (!match) continue
          this.pending.delete(response.data.id)
          clearTimeout(match.timer)
          if (response.data.error) match.reject(new BrokerRefusal(response.data.error))
          else match.resolve(response.data.result)
          continue
        }
        const notification = BrokerNotificationSchema.parse(value)
        this.notificationHandler?.(notification.method, notification.params)
      }
    } catch(cause) {
      this.disconnect(socket, new Error(`Invalid bridge response: ${errorMessage(cause)}`))
    }
  }

  /** The first frame on a socket must be the broker's hello answer. */
  private authenticate(socket: Socket, value: unknown): void {
    const hello = BrokerHelloResultSchema.parse(value)
    if (!hello.ok) {
      this.disconnect(socket, new Error(hello.error ?? "Authentication failed"))
      return
    }
    const extensionProtocol = hello.extension?.protocolVersion
    if (extensionProtocol !== undefined && extensionProtocol !== PROTOCOL_VERSION) {
      this.disconnect(
        socket,
        new Error(
          `Chromex protocol mismatch: MCP expects ${PROTOCOL_VERSION}, extension reports ${extensionProtocol}. Rebuild and reload the extension.`,
        ),
      )
      return
    }
    this.handshake?.finish()
  }

  /** Drop one socket: settle its handshake, reject every pending request once, clear timers. */
  private disconnect(socket: Socket, cause: Error): void {
    if (this.handshake?.socket === socket) this.handshake.finish(cause)
    if (this.socket !== socket) return
    this.socket = null
    socket.destroy()
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(cause)
    }
    this.pending.clear()
  }
}

/** A name the user can recognize in the extension popup, e.g. "chromex (pid 4821)". */
function clientLabel(): string {
  const override = process.env.CHROMEX_LABEL?.trim()
  if (override) return override.slice(0, 120)
  return `${basename(process.cwd())} (pid ${process.pid})`
}
