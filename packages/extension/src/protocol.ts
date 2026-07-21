export const PROTOCOL_VERSION = 1;
export const NATIVE_HOST_NAME = "io.codex.chrome_bridge";
export const EXTENSION_ID = "enbcklgjkjddndpkedgfhoeagcbogfdb";

export type RpcRequest = {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
};

export type TabInfo = {
  active: boolean;
  id: number;
  title: string;
  url: string;
  windowId: number;
};

export function parseRpcRequest(value: unknown): RpcRequest | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Partial<RpcRequest>;
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return null;
  if (
    request.id !== undefined &&
    typeof request.id !== "string" &&
    typeof request.id !== "number"
  ) {
    return null;
  }
  return request as RpcRequest;
}

export function rpcResult(id: string | number, result: unknown) {
  return { id, jsonrpc: "2.0" as const, result };
}

export function rpcError(id: string | number, message: string, code = -32000) {
  return { error: { code, message }, id, jsonrpc: "2.0" as const };
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
