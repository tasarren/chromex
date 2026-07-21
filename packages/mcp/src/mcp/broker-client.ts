import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import {
  BrokerHelloResultSchema,
  BrokerNotificationSchema,
  BrokerResponseSchema,
  errorMessage,
} from "../protocol/schema.js";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { type BridgeConfig, bridgeConfigPath } from "../shared/paths.js";

type Pending = {
  reject(cause: Error): void;
  resolve(value: unknown): void;
  timer: ReturnType<typeof setTimeout>;
};

export class BrokerClient {
  readonly clientId = randomUUID();
  private config: BridgeConfig | null = null;
  private connected: Promise<void> | null = null;
  private decoder = new FrameDecoder();
  private pending = new Map<string, Pending>();
  private sequence = 1;
  private socket: Socket | null = null;

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
    const socket = this.socket;
    this.socket = null;
    this.connected = null;
    socket?.destroy();
    this.rejectAll(new Error("Chromium bridge client closed"));
  }

  private async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connected) return await this.connected;
    this.connected = this.open();
    try {
      await this.connected;
    } finally {
      this.connected = null;
    }
  }

  private async open(): Promise<void> {
    this.config = JSON.parse(await readFile(bridgeConfigPath(), "utf8")) as BridgeConfig;
    this.decoder = new FrameDecoder();
    const socket = createConnection(this.config.socketPath);
    this.socket = socket;
    socket.on("data", (chunk) => this.onData(Buffer.from(chunk)));
    socket.on("error", (cause) => this.disconnect(new Error(errorMessage(cause))));
    socket.on("close", () => this.disconnect(new Error("Chromium bridge disconnected")));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(encodeFrame({ kind: "hello", clientId: this.clientId, token: this.config.token }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Chromium bridge authentication timed out")),
        5_000,
      );
      const onHello = (value: unknown) => {
        const hello = BrokerHelloResultSchema.safeParse(value);
        if (!hello.success) return false;
        clearTimeout(timer);
        hello.data.ok ? resolve() : reject(new Error(hello.data.error ?? "Authentication failed"));
        return true;
      };
      (socket as Socket & { __hello?: (value: unknown) => boolean }).__hello = onHello;
    });
  }

  private onData(chunk: Buffer): void {
    try {
      for (const value of this.decoder.push(chunk)) {
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
        BrokerNotificationSchema.parse(value);
      }
    } catch (cause) {
      this.disconnect(new Error(`Invalid bridge response: ${errorMessage(cause)}`));
    }
  }

  private disconnect(cause: Error): void {
    const socket = this.socket;
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
