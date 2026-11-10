// JSON-RPC wire contract between the extension worker and the native host.

export const PROTOCOL_VERSION = 3
export const NATIVE_HOST_NAME = "io.tasarren.chromex"
export const EXTENSION_ID = "enbcklgjkjddndpkedgfhoeagcbogfdb"
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`
/** Store item ID. Unknown until the owner creates the store item. */
export const STORE_EXTENSION_ID: string | null = null

export type RpcId = string | number

export type RpcRequest = {
  jsonrpc: "2.0";
  id?: RpcId;
  method: string;
  params?: unknown;
}

export type RpcResponse = {
  jsonrpc: "2.0";
  id: RpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** `bridge.hello` params the extension sends when it connects. */
export type ExtensionInfo = {
  extensionId: string;
  extensionVersion: string;
  name: string;
  protocolVersion: number;
}

export type TabInfo = {
  active: boolean;
  controlled?: boolean | undefined;
  id: number;
  title: string;
  url: string;
  windowId: number;
}

type Fields = Record<string, unknown>

export function isObject(value: unknown): value is Fields {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isId(value: unknown): value is RpcId {
  return typeof value === "string" || Number.isFinite(value)
}

/** Returns the request, or null when the value is not a JSON-RPC 2.0 request. */
export function parseRpcRequest(value: unknown): RpcRequest | null {
  if (!isObject(value) || value.jsonrpc !== "2.0") return null
  const { id, method, params } = value
  if (typeof method !== "string" || method === "") return null
  if (id !== undefined && !isId(id)) return null
  return {
    jsonrpc: "2.0",
    method,
    ...(id === undefined ? {} : { id }),
    ...("params" in value ? { params } : {}),
  }
}

/** Returns the response, or null when the value is not a JSON-RPC 2.0 response. */
export function parseRpcResponse(value: unknown): RpcResponse | null {
  if (!isObject(value) || value.jsonrpc !== "2.0" || !isId(value.id)) return null
  const { error } = value
  if (error !== undefined) {
    if (
      !isObject(error) ||
      typeof error.code !== "number" ||
      !Number.isFinite(error.code) ||
      typeof error.message !== "string"
    )
      return null
    return {
      jsonrpc: "2.0",
      id: value.id,
      error: {
        code: error.code,
        message: error.message,
        ...("data" in error ? { data: error.data } : {}),
      },
      ...("result" in value ? { result: value.result } : {}),
    }
  }
  return { jsonrpc: "2.0", id: value.id, ...("result" in value ? { result: value.result } : {}) }
}

export function rpcResult(id: RpcId, result: unknown): RpcResponse {
  return { id, jsonrpc: "2.0", result }
}

export function rpcError(id: RpcId, message: string, code = -32000): RpcResponse {
  return { error: { code, message }, id, jsonrpc: "2.0" }
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
