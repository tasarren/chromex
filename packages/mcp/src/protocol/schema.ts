import { z } from "zod";

export const PROTOCOL_VERSION = 3;
export const NATIVE_HOST_NAME = "io.codex.chrome_bridge";
export const EXTENSION_ID = "enbcklgjkjddndpkedgfhoeagcbogfdb";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;

export const JsonRpcIdSchema = z.union([z.string(), z.number()]);

export const RpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema.optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export const RpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema,
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});

export type RpcRequest = z.infer<typeof RpcRequestSchema>;
export type RpcResponse = z.infer<typeof RpcResponseSchema>;

export const ExtensionInfoSchema = z.object({
  extensionId: z.string(),
  extensionVersion: z.string(),
  name: z.string(),
  protocolVersion: z.number().int(),
});
export type ExtensionInfo = z.infer<typeof ExtensionInfoSchema>;

export const TabInfoSchema = z.object({
  controlled: z.boolean().optional(),
  active: z.boolean(),
  id: z.number().int().nonnegative(),
  title: z.string(),
  url: z.string(),
  windowId: z.number().int(),
});
export type TabInfo = z.infer<typeof TabInfoSchema>;

export const BrokerHelloSchema = z.object({
  kind: z.literal("hello"),
  clientId: z.string().min(1),
  // Optional so an older MCP server still authenticates; shown only in the extension popup.
  label: z.string().max(120).optional(),
  mode: z.enum(["managed", "observe"]).optional(),
  token: z.string().min(32),
});

export const BrokerHelloResultSchema = z.object({
  kind: z.literal("hello"),
  ok: z.boolean(),
  extension: ExtensionInfoSchema.nullable().optional(),
  error: z.string().optional(),
});

export const BrokerRequestSchema = z.object({
  kind: z.literal("request"),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export const BrokerResponseSchema = z.object({
  kind: z.literal("response"),
  id: z.string().min(1),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

export const BrokerNotificationSchema = z.object({
  kind: z.literal("notification"),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export const BrokerFrameSchema = z.union([
  BrokerHelloSchema,
  BrokerHelloResultSchema,
  BrokerRequestSchema,
  BrokerResponseSchema,
  BrokerNotificationSchema,
]);

export type BrokerHello = z.infer<typeof BrokerHelloSchema>;
export type BrokerHelloResult = z.infer<typeof BrokerHelloResultSchema>;
export type BrokerRequest = z.infer<typeof BrokerRequestSchema>;
export type BrokerResponse = z.infer<typeof BrokerResponseSchema>;
export type BrokerNotification = z.infer<typeof BrokerNotificationSchema>;
export type BrokerFrame = z.infer<typeof BrokerFrameSchema>;

export function rpcResult(id: string | number, result: unknown): RpcResponse {
  return { id, jsonrpc: "2.0", result };
}

export function rpcError(id: string | number, message: string, code = -32000): RpcResponse {
  return { error: { code, message }, id, jsonrpc: "2.0" };
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
