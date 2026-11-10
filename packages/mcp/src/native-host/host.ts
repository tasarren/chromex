import { chmod, rm } from "node:fs/promises"
import { createConnection, createServer, type Server, type Socket } from "node:net"
import {
  type ExtensionInfo,
  errorMessage,
  parseRpcRequest,
  parseRpcResponse,
  type RpcRequest,
} from "@chromex/protocol"
import { z } from "zod"
import {
  BrokerHelloSchema,
  BrokerRequestSchema,
  type BrokerStatus,
  ExtensionInfoSchema,
} from "../shared/schema.ts"
import type { BridgeConfig } from "../shared/config.ts"
import { encodeFrame, FrameDecoder } from "../shared/framing.ts"

const CHROME_MAX_OUTBOUND_BYTES = 1024 * 1024

/** Broker methods a client may forward to the extension; the host adds the client ID. */
const FORWARDED_METHODS = new Set([
  "bridge.status",
  "client.status",
  "window.ensure",
  "tabs.list",
  "tabs.create",
  "tabs.claim",
  "tabs.park",
  "tabs.target",
  "tabs.release",
  "tabs.close",
  "cdp.attach",
  "cdp.detach",
  "cdp.command",
  "cdp.ownerInspect",
  "input.run",
  "input.reserve",
  "input.begin",
  "input.end",
  "input.uncertain",
  "tabs.inspect",
  "tabs.uninspect",
  "cdp.inspect",
  "inspect.begin",
  "inspect.step",
  "inspect.end",
  "gesture.status",
  "gesture.reserve",
  "gesture.admit",
  "gesture.complete",
  "gesture.uncertain",
  "gesture.cancel",
  "gesture.bind",
  "gesture.edge",
  "gesture.invalidate",
  "bridge.close",
])

const ParamsSchema = z.record(z.string(), z.unknown())

type ClientRole = "agent" | "service"
type Client = {
  clientId: string | null
  decoder: FrameDecoder
  /** Assigned by the host from the private service key; a caller cannot choose it. */
  executorGeneration: number | null
  role: ClientRole | null
  socket: Socket
}

export type HostOptions = {
  /** Host-owned private credential that authenticates the detached Managed-service role. */
  serviceKey?: string | undefined
}

/** Where the host writes extension frames and its stderr diagnostics. */
export type HostIo = { write(frame: Buffer): void; log(message: string): void }

/** Brokers authenticated local clients to the one extension connection on stdio. */
export class NativeHost {
  private readonly callerOrigin: string
  private readonly clients = new Set<Client>()
  private readonly config: BridgeConfig
  private readonly extensionDecoder = new FrameDecoder()
  private readonly io: HostIo
  private readonly pending = new Map<string, { clientRequestId: string; client: Client }>()
  private readonly server: Server
  private readonly serviceKey: string | undefined
  private extension: ExtensionInfo | null = null
  private nextRequestId = 1
  private serviceGeneration = 0
  private stopping: Promise<void> | null = null

  constructor(config: BridgeConfig, callerOrigin: string, io: HostIo, options: HostOptions = {}) {
    this.config = config
    this.callerOrigin = callerOrigin
    this.io = io
    this.serviceKey = options.serviceKey
    this.server = createServer((socket) => { this.accept(socket) })
  }

  /** Listen on the configured socket; refuses a socket another live bridge still answers. */
  async listen(): Promise<void> {
    const socketPath = this.config.socketPath
    if (await answers(socketPath))
      throw new Error(`Another Chromium bridge is already active at ${socketPath}`)
    await rm(socketPath, { force: true })
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject)
      this.server.listen(socketPath, resolve)
    })
    await chmod(socketPath, 0o600)
    this.io.log(`Listening on ${socketPath}`)
  }

  /** Bytes from the extension. Throws on a message that is not JSON-RPC. */
  receive(chunk: Buffer): void {
    for (const value of this.extensionDecoder.push(chunk)) {
      const request = parseRpcRequest(value)
      if (request) {
        this.fromExtension(request)
        continue
      }
      const response = parseRpcResponse(value)
      if (!response) throw new Error("Extension sent an invalid JSON-RPC message")
      const id = String(response.id)
      const match = this.pending.get(id)
      if (!match) continue
      this.pending.delete(id)
      this.send(match.client, {
        kind: "response",
        id: match.clientRequestId,
        ...(response.error ? { error: response.error.message } : { result: response.result }),
      })
    }
  }

  shutdown(): Promise<void> {
    this.stopping ??= (async() => {
      for (const client of this.clients) client.socket.destroy()
      await new Promise<void>((resolve) => this.server.close(() => { resolve() }))
      await rm(this.config.socketPath, { force: true })
    })()
    return this.stopping
  }

  private accept(socket: Socket): void {
    const client: Client = {
      clientId: null,
      decoder: new FrameDecoder(),
      executorGeneration: null,
      role: null,
      socket,
    }
    this.clients.add(client)
    socket.on("data", (chunk) => {
      try {
        for (const value of client.decoder.push(Buffer.from(chunk))) this.fromClient(client, value)
      } catch(cause) {
        // A bad frame ends only this client's connection.
        this.send(client, { kind: "response", id: "invalid", error: errorMessage(cause) })
        socket.destroy()
      }
    })
    socket.on("close", () => { this.drop(client) })
    socket.on("error", (cause) => { this.io.log(`Client socket error: ${errorMessage(cause)}`) })
  }

  private fromClient(client: Client, value: unknown): void {
    if (client.socket.destroyed) return
    if (client.clientId === null) {
      const hello = BrokerHelloSchema.safeParse(value)
      if (!hello.success || hello.data.token !== this.config.token) {
        this.failClient(client, "Authentication failed")
        return
      }
      // A service key is a role claim, not an alternative token: a configured host accepts only the
      // exact host-owned value, and a host without one accepts no service claim at all.
      const claimed = hello.data.serviceKey
      if (claimed !== undefined && claimed !== this.serviceKey) {
        this.failClient(client, "Authentication failed")
        return
      }
      if ([...this.clients].some((live) => live !== client && live.clientId === hello.data.clientId)) {
        this.failClient(client, "Client ID is already connected")
        return
      }
      client.clientId = hello.data.clientId
      client.role = claimed === undefined ? "agent" : "service"
      client.executorGeneration = client.role === "service" ? ++this.serviceGeneration : null
      this.send(client, { kind: "hello", ok: true, extension: this.extension })
      // Tell the extension who this client is, so the popup can name it. The role and generation
      // are host-derived; no caller-supplied value survives the forwarding below.
      this.toExtension("hello", "client.hello", {
        clientId: client.clientId,
        clientRole: client.role,
        label: hello.data.label,
        mode: this.config.managed ? "managed" : "observe",
        ...(client.executorGeneration === null ? {} : { executorGeneration: client.executorGeneration }),
      })
      return
    }

    const request = BrokerRequestSchema.parse(value)
    if (request.method === "broker.status") {
      const status: BrokerStatus = {
        callerOrigin: this.callerOrigin,
        extension: this.extension,
        socketPath: this.config.socketPath,
      }
      this.send(client, { kind: "response", id: request.id, result: status })
      return
    }
    if (!FORWARDED_METHODS.has(request.method)) {
      this.send(client, { kind: "response", id: request.id, error: "Unsupported broker method" })
      return
    }
    // Host-derived identity replaces every caller-supplied authority field.
    const params = ParamsSchema.safeParse(request.params)
    const forwarded: Record<string, unknown> = params.success ? { ...params.data } : { value: request.params }
    delete forwarded.clientId
    delete forwarded.clientRole
    delete forwarded.executorGeneration
    forwarded.clientId = client.clientId
    forwarded.clientRole = client.role
    if (client.executorGeneration !== null) forwarded.executorGeneration = client.executorGeneration
    const hostRequestId = this.toExtension("host", request.method, forwarded)
    this.pending.set(hostRequestId, { clientRequestId: request.id, client })
  }

  private fromExtension(request: RpcRequest): void {
    if (request.method === "bridge.hello") {
      this.toExtension("configure", "bridge.configure", { managed: this.config.managed })
      this.extension = ExtensionInfoSchema.parse(request.params)
      this.io.log(
        `Extension connected: ${this.extension.extensionId} v${this.extension.extensionVersion} protocol ${this.extension.protocolVersion}`,
      )
      this.broadcast({ kind: "notification", method: "bridge.connected", params: this.extension })
      return
    }
    const params = ParamsSchema.safeParse(request.params)
    const target = params.success && typeof params.data.clientId === "string"
    this.broadcast(
      { kind: "notification", method: request.method, params: request.params },
      target ? String(params.data.clientId) : null,
    )
  }

  private drop(client: Client): void {
    if (!this.clients.delete(client)) return
    for (const [id, request] of this.pending) {
      if (request.client === client) this.pending.delete(id)
    }
    if (client.clientId)
      this.toExtension("cleanup", "client.release", { clientId: client.clientId })
  }

  private failClient(client: Client, message: string): void {
    this.send(client, { kind: "hello", ok: false, error: message })
    client.socket.destroy()
  }

  private send(client: Client, value: unknown): void {
    if (!client.socket.destroyed) client.socket.write(encodeFrame(value))
  }

  private broadcast(value: unknown, targetClient: string | null = null): void {
    for (const client of this.clients) {
      if (client.clientId === null) continue
      if (targetClient && client.clientId !== targetClient) continue
      this.send(client, value)
    }
  }

  /** Send one request to the extension and return its ID. */
  private toExtension(prefix: string, method: string, params: unknown): string {
    const id = `${prefix}-${this.nextRequestId++}`
    if (!this.stopping)
      this.io.write(encodeFrame({ jsonrpc: "2.0", id, method, params }, CHROME_MAX_OUTBOUND_BYTES))
    return id
  }
}

function answers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(socketPath)
    probe.once("connect", () => {
      probe.destroy()
      resolve(true)
    })
    probe.once("error", () => { resolve(false) })
  })
}
