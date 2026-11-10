import { expect, test } from "vitest"
import {
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  NATIVE_HOST_NAME,
  PROTOCOL_VERSION,
  parseRpcRequest,
  parseRpcResponse,
  rpcError,
  rpcResult,
} from "../../src/index.ts"

test("wire identities stay fixed", () => {
  expect(PROTOCOL_VERSION).toBe(3)
  expect(NATIVE_HOST_NAME).toBe("io.tasarren.chromex")
  expect(EXTENSION_ID).toBe("enbcklgjkjddndpkedgfhoeagcbogfdb")
  expect(EXTENSION_ORIGIN).toBe("chrome-extension://enbcklgjkjddndpkedgfhoeagcbogfdb/")
})

test("requests keep only declared fields and reject malformed envelopes", () => {
  expect(parseRpcRequest({ jsonrpc: "2.0", id: 1, method: "tabs.list", extra: true })).toEqual({
    jsonrpc: "2.0",
    id: 1,
    method: "tabs.list",
  })
  expect(parseRpcRequest({ jsonrpc: "2.0", method: "bridge.hello", params: { a: 1 } })).toEqual({
    jsonrpc: "2.0",
    method: "bridge.hello",
    params: { a: 1 },
  })
  for (const value of [
    null,
    [],
    "x",
    { jsonrpc: "1.0", method: "m" },
    { jsonrpc: "2.0" },
    { jsonrpc: "2.0", method: "" },
    { jsonrpc: "2.0", method: "m", id: null },
    { jsonrpc: "2.0", method: "m", id: {} },
  ]) {
    expect(parseRpcRequest(value), JSON.stringify(value)).toBeNull()
  }
})

test("responses round-trip the helpers and reject malformed errors", () => {
  expect(parseRpcResponse(rpcResult("a", { ok: true }))).toEqual(rpcResult("a", { ok: true }))
  expect(parseRpcResponse(rpcError(7, "nope"))).toEqual({
    jsonrpc: "2.0",
    id: 7,
    error: { code: -32000, message: "nope" },
  })
  expect(parseRpcResponse({ jsonrpc: "2.0", id: 1 })).toEqual({ jsonrpc: "2.0", id: 1 })
  for (const value of [
    { jsonrpc: "2.0", result: 1 },
    { jsonrpc: "2.0", id: 1, error: "nope" },
    { jsonrpc: "2.0", id: 1, error: { code: "1", message: "x" } },
    { jsonrpc: "2.0", id: 1, error: { code: 1 } },
  ]) {
    expect(parseRpcResponse(value), JSON.stringify(value)).toBeNull()
  }
})

test("ids and error codes that overflow to Infinity in JSON are rejected", () => {
  for (const raw of [
    "{\"jsonrpc\":\"2.0\",\"id\":1e400,\"method\":\"m\"}",
    "{\"jsonrpc\":\"2.0\",\"id\":-1e400,\"result\":1}",
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":1e400,\"message\":\"x\"}}",
  ]) {
    const value: unknown = JSON.parse(raw)
    expect(parseRpcRequest(value) ?? parseRpcResponse(value), raw).toBeNull()
  }
})
