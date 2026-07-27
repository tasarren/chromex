import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BrokerClient } from "../src/mcp/broker-client.js";
import { PROTOCOL_VERSION } from "../src/protocol/schema.js";
import { encodeFrame, FrameDecoder } from "../src/shared/framing.js";

test("requests wait for authentication and immediate reconnect ignores old socket events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chromex-reconnect-"));
  const socketPath = join(directory, "bridge.sock");
  const configPath = join(directory, "config.json");
  const sockets = new Set<Socket>();
  let prematureRequest = false;
  let receivedHello: (() => void) | undefined;
  const helloReceived = new Promise<void>((resolve) => {
    receivedHello = resolve;
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const decoder = new FrameDecoder();
    let authenticated = false;
    socket.on("data", (chunk) => {
      for (const value of decoder.push(Buffer.from(chunk))) {
        const frame = value as { kind: string; id?: string };
        if (frame.kind === "hello") {
          receivedHello?.();
          setTimeout(() => {
            authenticated = true;
            if (!socket.destroyed)
              socket.write(encodeFrame({ kind: "hello", ok: true, extension: null }));
          }, 20);
        } else {
          if (!authenticated) prematureRequest = true;
          socket.write(encodeFrame({ kind: "response", id: frame.id, result: "ok" }));
        }
      }
    });
  });
  await writeFile(configPath, JSON.stringify({ socketPath, token: "x".repeat(32) }));
  server.listen(socketPath);
  await once(server, "listening");
  const client = new BrokerClient({ configPath });
  try {
    const first = client.request("broker.status");
    await helloReceived;
    const second = client.request("client.status");
    assert.deepEqual(await Promise.all([first, second]), ["ok", "ok"]);
    assert.equal(prematureRequest, false);
    for (let count = 0; count < 3; count += 1) {
      await client.close();
      assert.equal(await client.request("broker.status"), "ok");
    }
    await client.close();
    const pending = client.request("broker.status");
    await delay(5);
    await client.close();
    await assert.rejects(pending, /closed|disconnected/);
    assert.equal(await client.request("broker.status"), "ok");
  } finally {
    await client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { force: true, recursive: true });
  }
});

test("a protocol mismatch closes the broker connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chromex-broker-client-"));
  const socketPath = join(directory, "bridge.sock");
  const configPath = join(directory, "config.json");
  let connectionClosed: Promise<unknown> | undefined;
  let helloMode: unknown;
  const server = createServer((socket) => {
    connectionClosed = once(socket, "close");
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(Buffer.from(chunk))) {
        if ((frame as { kind?: unknown }).kind !== "hello") continue;
        helloMode = (frame as { mode?: unknown }).mode;
        socket.write(
          encodeFrame({
            extension: {
              extensionId: "test",
              extensionVersion: "0.0.0",
              name: "test",
              protocolVersion: PROTOCOL_VERSION - 1,
            },
            kind: "hello",
            ok: true,
          }),
        );
      }
    });
  });

  await writeFile(
    configPath,
    JSON.stringify({
      extensionOrigin: "chrome-extension://test/",
      socketPath,
      token: "x".repeat(32),
    }),
  );
  server.listen(socketPath);
  await once(server, "listening");

  const client = new BrokerClient({ configPath, mode: "managed" });
  try {
    await assert.rejects(client.request("broker.status"), /protocol mismatch/);
    assert.equal(helloMode, "managed");
    assert(connectionClosed);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        connectionClosed,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Broker connection remained open")), 500);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      server.close((cause) => (cause ? reject(cause) : resolve())),
    );
    await rm(directory, { force: true, recursive: true });
  }
});
