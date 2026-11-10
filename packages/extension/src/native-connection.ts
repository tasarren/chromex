import {
  type ExtensionInfo,
  errorMessage,
  NATIVE_HOST_NAME,
  parseRpcRequest,
  type RpcRequest,
  rpcError,
  rpcResult,
} from "@chromex/protocol"

/** The listener half of a Chromium event, which is all the bridge uses. */
export type Listened<E extends { addListener: unknown; removeListener: unknown }> = Pick<
  E,
  "addListener" | "removeListener"
>

/** The port calls the connection makes; its listeners ignore the port argument. */
export type NativePort = Pick<chrome.runtime.Port, "disconnect" | "postMessage"> & {
  onDisconnect: { addListener(listener: () => void): void };
  onMessage: { addListener(listener: (message: unknown) => void): void };
}

export type ConnectionApi = {
  alarms: {
    clear(name: string): Promise<boolean>;
    create(name: string, info: chrome.alarms.AlarmCreateInfo): Promise<void>;
    onAlarm: Listened<typeof chrome.alarms.onAlarm>;
  };
  runtime: {
    connectNative(application: string): NativePort;
    lastError?: { message?: string } | undefined;
  };
}

type ConnectionHandlers = {
  /** The native host went away; its clients cannot report completion of their work. */
  disconnected?(): void;
  hello(): ExtensionInfo;
  request(request: RpcRequest): Promise<unknown>;
}

const RECONNECT_ALARM = "bridge-reconnect"

/**
 * Owns the native-messaging port: connect, hello, request/reply routing, and reconnect backoff.
 * It knows nothing about tabs, leases, or consent; requests go to the handler given once here.
 */
export class NativeConnection {
  private readonly api: ConnectionApi
  private readonly handlers: ConnectionHandlers
  private port: NativePort | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private running = false
  private error: string | null = null

  constructor(api: ConnectionApi, handlers: ConnectionHandlers) {
    this.api = api
    this.handlers = handlers
  }

  get connected(): boolean {
    return this.port !== null
  }

  get lastError(): string | null {
    return this.error
  }

  /** Register the reconnect alarm. MV3 only wakes a worker for listeners added at startup. */
  start(): void {
    this.running = true
    this.api.alarms.onAlarm.addListener(this.onAlarm)
    void this.api.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 })
  }

  stop(): void {
    this.running = false
    this.api.alarms.onAlarm.removeListener(this.onAlarm)
    void this.api.alarms.clear(RECONNECT_ALARM)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    const port = this.port
    this.port = null
    port?.disconnect()
  }

  connect(): void {
    if (!this.running || this.port) return
    try {
      const port = this.api.runtime.connectNative(NATIVE_HOST_NAME)
      this.port = port
      this.error = null
      port.onMessage.addListener((message: unknown) => void this.receive(port, message))
      port.onDisconnect.addListener(() => { this.disconnected(port) })
      port.postMessage({ jsonrpc: "2.0", method: "bridge.hello", params: this.handlers.hello() })
      this.attempt = 0
    } catch(cause) {
      this.port = null
      this.error = errorMessage(cause)
      this.scheduleReconnect()
    }
  }

  notify(method: string, params: unknown): void {
    this.post(this.port, { jsonrpc: "2.0", method, params })
  }

  private readonly onAlarm = (alarm: chrome.alarms.Alarm): void => {
    if (alarm.name === RECONNECT_ALARM) this.connect()
  }

  private async receive(port: NativePort, message: unknown): Promise<void> {
    const request = parseRpcRequest(message)
    if (!request || request.id === undefined || this.port !== port) return
    let reply: unknown
    try {
      reply = rpcResult(request.id, await this.handlers.request(request))
    } catch(cause) {
      reply = rpcError(request.id, errorMessage(cause))
    }
    // A reply belongs to the port that asked; a reconnected host never sent this request ID.
    if (this.port === port) this.post(port, reply)
  }

  private post(port: NativePort | null, message: unknown): void {
    try {
      port?.postMessage(message)
    } catch {
      // The port closed underneath us; its onDisconnect schedules the reconnect.
    }
  }

  private disconnected(port: NativePort): void {
    if (this.port !== port) return
    this.port = null
    this.error = this.api.runtime.lastError?.message ?? "Native host disconnected"
    this.handlers.disconnected?.()
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.attempt, 6))
    this.attempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }
}
