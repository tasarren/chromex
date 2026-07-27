import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BrokerClient } from "../src/mcp/broker-client.js";
import { EXTENSION_ORIGIN, PROTOCOL_VERSION } from "../src/protocol/schema.js";
import { encodeFrame, FrameDecoder } from "../src/shared/framing.js";

test("native host refuses broker configuration and ignores spoofed Managed mode", {
  timeout: 10_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "chromex-native-mode-"));
  const configPath = join(directory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      extensionOrigin: EXTENSION_ORIGIN,
      socketPath: join(directory, "bridge.sock"),
      token: "x".repeat(32),
    }),
  );
  const env: NodeJS.ProcessEnv = { ...process.env, CHROME_BROWSER_BRIDGE_CONFIG: configPath };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/native-host/index.ts", EXTENSION_ORIGIN],
    { cwd: packageRoot, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const decoder = new FrameDecoder();
  const messages: { method: string; params: { mode?: string; managed?: boolean } }[] = [];
  child.stdout.on("data", (chunk: Buffer) =>
    messages.push(...(decoder.push(chunk) as typeof messages)),
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk;
  });
  const broker = new BrokerClient({ configPath, mode: "managed" });
  try {
    while (!stderr.includes("Listening on")) await once(child.stderr, "data");
    child.stdin.write(
      encodeFrame({
        jsonrpc: "2.0",
        method: "bridge.hello",
        params: {
          extensionId: "test",
          extensionVersion: "1",
          name: "test",
          protocolVersion: PROTOCOL_VERSION,
        },
      }),
    );
    while (!messages.some((message) => message.method === "bridge.configure"))
      await once(child.stdout, "data");
    await broker.request("broker.status");
    for (const method of ["bridge.configure", "client.hello", "client.release", "popup.observe"]) {
      await assert.rejects(broker.request(method, { managed: true }), /Unsupported broker method/);
    }
    assert.equal(
      messages.find((message) => message.method === "bridge.configure")?.params.managed,
      false,
    );
    assert.equal(
      messages.find((message) => message.method === "client.hello")?.params.mode,
      "observe",
    );
    assert.equal(messages.filter((message) => message.method === "bridge.configure").length, 1);
  } finally {
    await broker.close();
    child.stdin.end();
    await once(child, "exit");
    await rm(directory, { force: true, recursive: true });
  }
});

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("native host handles Chromium closing its output pipe during client cleanup", {
  timeout: 10_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "chromex-native-exit-"));
  const socketPath = join(directory, "bridge.sock");
  const configPath = join(directory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({ extensionOrigin: EXTENSION_ORIGIN, socketPath, token: "x".repeat(32) }),
  );
  const env: NodeJS.ProcessEnv = { ...process.env, CHROME_BROWSER_BRIDGE_CONFIG: configPath };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/native-host/index.ts", EXTENSION_ORIGIN],
    {
      cwd: packageRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = once(child, "exit");
  let socket: ReturnType<typeof createConnection> | undefined;
  try {
    while (!stderr.includes("Listening on")) await once(child.stderr, "data");
    socket = createConnection(socketPath);
    await once(socket, "connect");
    child.stdout.destroy();
    socket.write(encodeFrame({ kind: "hello", clientId: "exit-test", token: "x".repeat(32) }));
    socket.resume();
    const [code, signal] = await exited;
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, stderr);
    assert.doesNotMatch(stderr, /Unhandled|EPIPE/);
  } finally {
    socket?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { force: true, recursive: true });
  }
});

test("the MCP server exits when its stdio client closes", { timeout: 10_000 }, async () => {
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--import", "tsx", "src/mcp/server.ts"], {
    cwd: packageRoot,
    env: childEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "lifecycle-test", version: "1" },
          protocolVersion: "2025-11-25",
        },
      })}\n`,
    );
    await once(child.stdout, "data");
    child.stdin.end();
    const [code, signal] = await once(child, "exit");
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, stderr);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
