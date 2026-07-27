import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { basename } from "node:path";
import {
  BrokerHelloResultSchema,
  BrokerNotificationSchema,
  BrokerResponseSchema,
  errorMessage,
  PROTOCOL_VERSION,
} from "../protocol/schema.js";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { type BridgeConfig, bridgeConfigPath } from "../shared/paths.js";

/** A name the user can recognize in the extension popup, e.g. "chromex (pid 4821)". */
function clientLabel(): string {
  const override = process.env.CHROMEX_LABEL?.trim();
  if (override) return override.slice(0, 120);
  return `${basename(process.cwd())} (pid ${process.pid})`;
}

type Pending = {
  reject(cause: Error): void;
  resolve(value: unknown): void;
  timer: ReturnType<typeof setTimeout>;
};

type BrokerClientOptions = {
  configPath?: string | undefined;
  mode?: "managed" | "observe" | undefined;
};

export class BrokerClient {
  readonly clientId = randomUUID();
  private connected: Promise<void> | null = null;
  private generation = 0;
  private notificationHandler: ((method: string, params: unknown) => void) | null = null;
  private pending = new Map<string, Pending>();
  private sequence = 1;
  private socket: Socket | null = null;

  constructor(private readonly options: BrokerClientOptions = {}) {}

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  async request<T = unknown>(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<T> {
    await this.connect();
    const socket = this.socket;
    if (!socket) throw new Error("Chromium bridge is not connected");
    const id = `${this.clientId}-${this.sequence++}`;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chromium bridge request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        reject,
        resolve: (value) => resolve(value as T),
        timer,
      });
      socket.write(encodeFrame({ id, kind: "request", method, params }));
    });
  }

  async close(): Promise<void> {
    this.generation += 1;
    const socket = this.socket;
    this.socket = null;
    this.connected = null;
    socket?.destroy();
    this.rejectAll(new Error("Chromium bridge client closed"));
  }

  private async connect(): Promise<void> {
    if (this.connected) return await this.connected;
    if (this.socket && !this.socket.destroyed) return;
    const connected = this.open();
    this.connected = connected;
    try {
      await connected;
    } finally {
      if (this.connected === connected) this.connected = null;
    }
  }

  private async open(): Promise<void> {
    const generation = this.generation;
    const config = JSON.parse(
      await readFile(this.options.configPath ?? bridgeConfigPath(), "utf8"),
    ) as BridgeConfig;
    if (generation !== this.generation) throw new Error("Chromium bridge client closed");
    const decoder = new FrameDecoder();
    const socket = createConnection(config.socketPath);
    this.socket = socket;
    socket.on("data", (chunk) => this.onData(socket, decoder, Buffer.from(chunk)));
    socket.on("error", (cause) => this.disconnect(socket, new Error(errorMessage(cause))));
    socket.on("close", () => this.disconnect(socket, new Error("Chromium bridge disconnected")));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error("Chromium bridge authentication timed out")),
        5_000,
      );
      const onClose = () => finish(new Error("Chromium bridge disconnected during authentication"));
      const onError = (cause: Error) => finish(cause);
      const finish = (cause?: Error) => {
        clearTimeout(timer);
        socket.off("close", onClose);
        socket.off("error", onError);
        if (cause) {
          this.disconnect(socket, cause);
          reject(cause);
        } else resolve();
      };
      socket.once("close", onClose);
      socket.once("error", onError);
      const onHello = (value: unknown) => {
        const hello = BrokerHelloResultSchema.safeParse(value);
        if (!hello.success) return false;
        if (!hello.data.ok) {
          finish(new Error(hello.data.error ?? "Authentication failed"));
          return true;
        }
        const extensionProtocol = hello.data.extension?.protocolVersion;
        if (extensionProtocol !== undefined && extensionProtocol !== PROTOCOL_VERSION) {
          finish(
            new Error(
              `Chromex protocol mismatch: MCP expects ${PROTOCOL_VERSION}, extension reports ${extensionProtocol}. Rebuild and reload the extension.`,
            ),
          );
          return true;
        }
        finish();
        return true;
      };
      (socket as Socket & { __hello?: (value: unknown) => boolean }).__hello = onHello;
      socket.once("connect", () => {
        socket.write(
          encodeFrame({
            kind: "hello",
            clientId: this.clientId,
            label: clientLabel(),
            ...(this.options.mode === undefined ? {} : { mode: this.options.mode }),
            token: config.token,
          }),
        );
      });
    });
  }

  private onData(connection: Socket, decoder: FrameDecoder, chunk: Buffer): void {
    if (this.socket !== connection) return;
    try {
      for (const value of decoder.push(chunk)) {
        const socket = this.socket as (Socket & { __hello?: (value: unknown) => boolean }) | null;
        if (socket?.__hello?.(value)) {
          delete socket.__hello;
          continue;
        }
        const response = BrokerResponseSchema.safeParse(value);
        if (response.success) {
          const match = this.pending.get(response.data.id);
          if (!match) continue;
          this.pending.delete(response.data.id);
          clearTimeout(match.timer);
          response.data.error
            ? match.reject(new Error(response.data.error))
            : match.resolve(response.data.result);
          continue;
        }
        const notification = BrokerNotificationSchema.parse(value);
        this.notificationHandler?.(notification.method, notification.params);
      }
    } catch (cause) {
      this.disconnect(connection, new Error(`Invalid bridge response: ${errorMessage(cause)}`));
    }
  }

  private disconnect(socket: Socket, cause: Error): void {
    if (this.socket !== socket) return;
    this.socket = null;
    socket?.destroy();
    this.rejectAll(cause);
  }

  private rejectAll(cause: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(cause);
    }
    this.pending.clear();
  }
}
