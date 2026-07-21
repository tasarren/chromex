import { chmod, readFile, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import {
  BrokerHelloSchema,
  BrokerRequestSchema,
  type ExtensionInfo,
  ExtensionInfoSchema,
  errorMessage,
  type RpcRequest,
  RpcRequestSchema,
  RpcResponseSchema,
} from "../protocol/schema.js";
import { encodeFrame, FrameDecoder } from "../shared/framing.js";
import { type BridgeConfig, bridgeConfigPath } from "../shared/paths.js";

const CHROME_MAX_OUTBOUND_BYTES = 1024 * 1024;

type ClientState = {
  authenticated: boolean;
  clientId: string | null;
  decoder: FrameDecoder;
  socket: Socket;
};

type PendingRequest = {
  clientRequestId: string;
  state: ClientState;
};

const config = await loadConfig();
const callerOrigin = process.argv[2] ?? "";
if (callerOrigin !== config.extensionOrigin) {
  fail(`Rejected native-messaging caller ${JSON.stringify(callerOrigin)}`);
}

let extensionInfo: ExtensionInfo | null = null;
let nextHostRequestId = 1;
const clients = new Set<ClientState>();
const pending = new Map<string, PendingRequest>();
const chromeDecoder = new FrameDecoder();

await ensureSocketIsAvailable(config.socketPath);

const server = createServer((socket) => {
  const state: ClientState = {
    authenticated: false,
    clientId: null,
    decoder: new FrameDecoder(),
    socket,
  };
  clients.add(state);
  socket.on("data", (chunk) => {
    try {
      for (const value of state.decoder.push(Buffer.from(chunk)))
        void handleClientFrame(state, value);
    } catch (cause) {
      sendClient(state, { kind: "response", id: "invalid", error: errorMessage(cause) });
      socket.destroy();
    }
  });
  socket.on("close", () => disconnectClient(state));
  socket.on("error", (cause) => log(`Client socket error: ${errorMessage(cause)}`));
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.socketPath, resolve);
});
await chmod(config.socketPath, 0o600);
log(`Listening on ${config.socketPath}`);

process.stdin.on("data", (chunk: Buffer) => {
  try {
    for (const value of chromeDecoder.push(chunk)) handleChromeFrame(value);
  } catch (cause) {
    fail(`Invalid message from extension: ${errorMessage(cause)}`);
  }
});
process.stdin.on("end", () => void shutdown(0));
process.stdin.on("error", (cause) => fail(`Chrome stdin error: ${errorMessage(cause)}`));
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

async function loadConfig(): Promise<BridgeConfig> {
  const path = bridgeConfigPath();
  const raw = JSON.parse(await readFile(path, "utf8")) as Partial<BridgeConfig>;
  if (
    typeof raw.extensionOrigin !== "string" ||
    typeof raw.socketPath !== "string" ||
    typeof raw.token !== "string" ||
    raw.token.length < 32
  ) {
    throw new Error(`Invalid bridge config: ${path}`);
  }
  return raw as BridgeConfig;
}

async function ensureSocketIsAvailable(socketPath: string): Promise<void> {
  const occupied = await new Promise<boolean>((resolve) => {
    const probe = createConnection(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
  if (occupied) throw new Error(`Another Chromium bridge is already active at ${socketPath}`);
  await rm(socketPath, { force: true });
}

async function handleClientFrame(state: ClientState, value: unknown): Promise<void> {
  if (!state.authenticated) {
    const hello = BrokerHelloSchema.safeParse(value);
    if (!hello.success || hello.data.token !== config.token) {
      sendClient(state, { kind: "hello", ok: false, error: "Authentication failed" });
      state.socket.destroy();
      return;
    }
    state.authenticated = true;
    state.clientId = hello.data.clientId;
    sendClient(state, { kind: "hello", ok: true, extension: extensionInfo });
    return;
  }

  const request = BrokerRequestSchema.parse(value);
  if (!state.clientId) throw new Error("Authenticated client is missing an ID");

  if (request.method === "broker.status") {
    sendClient(state, {
      kind: "response",
      id: request.id,
      result: { callerOrigin, extension: extensionInfo, socketPath: config.socketPath },
    });
    return;
  }

  const hostRequestId = `host-${nextHostRequestId++}`;
  const params =
    request.params && typeof request.params === "object" && !Array.isArray(request.params)
      ? { ...(request.params as Record<string, unknown>), clientId: state.clientId }
      : { clientId: state.clientId, value: request.params };
  pending.set(hostRequestId, { clientRequestId: request.id, state });
  writeChrome({ jsonrpc: "2.0", id: hostRequestId, method: request.method, params });
}

function handleChromeFrame(value: unknown): void {
  const request = RpcRequestSchema.safeParse(value);
  if (request.success) {
    handleExtensionRequest(request.data);
    return;
  }

  const response = RpcResponseSchema.safeParse(value);
  if (!response.success) throw new Error("Extension sent an invalid JSON-RPC message");
  const requestId = String(response.data.id);
  const match = pending.get(requestId);
  if (!match) return;
  pending.delete(requestId);
  sendClient(match.state, {
    kind: "response",
    id: match.clientRequestId,
    ...(response.data.error
      ? { error: response.data.error.message }
      : { result: response.data.result }),
  });
}

function handleExtensionRequest(request: RpcRequest): void {
  if (request.method === "bridge.hello") {
    extensionInfo = ExtensionInfoSchema.parse(request.params);
    log(
      `Extension connected: ${extensionInfo.extensionId} v${extensionInfo.extensionVersion} protocol ${extensionInfo.protocolVersion}`,
    );
    broadcast({ kind: "notification", method: "bridge.connected", params: extensionInfo });
    return;
  }

  const params = request.params as { clientId?: unknown } | undefined;
  const targetClient = typeof params?.clientId === "string" ? params.clientId : null;
  broadcast({ kind: "notification", method: request.method, params: request.params }, targetClient);
}

function disconnectClient(state: ClientState): void {
  if (!clients.delete(state)) return;
  for (const [id, request] of pending) {
    if (request.state === state) pending.delete(id);
  }
  if (state.clientId) {
    writeChrome({
      jsonrpc: "2.0",
      id: `cleanup-${nextHostRequestId++}`,
      method: "client.release",
      params: { clientId: state.clientId },
    });
  }
}

function sendClient(state: ClientState, value: unknown): void {
  if (!state.socket.destroyed) state.socket.write(encodeFrame(value));
}

function broadcast(value: unknown, targetClient: string | null = null): void {
  for (const state of clients) {
    if (!state.authenticated) continue;
    if (targetClient && state.clientId !== targetClient) continue;
    sendClient(state, value);
  }
}

function writeChrome(value: unknown): void {
  process.stdout.write(encodeFrame(value, CHROME_MAX_OUTBOUND_BYTES));
}

async function shutdown(code: number): Promise<void> {
  for (const client of clients) client.socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(config.socketPath, { force: true });
  process.exit(code);
}

function log(message: string): void {
  process.stderr.write(`[chrome-browser-bridge] ${message}\n`);
}

function fail(message: string): never {
  log(message);
  process.exit(1);
}
