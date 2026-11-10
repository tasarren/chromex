import type { ExtensionInfo, TabInfo } from "@chromex/protocol"
import { z } from "zod"

// Node-side validation of the shared wire types plus the MCP-only broker socket frames.

export const ExtensionInfoSchema = z.object({
  extensionId: z.string(),
  extensionVersion: z.string(),
  name: z.string(),
  protocolVersion: z.number().int(),
}) satisfies z.ZodType<ExtensionInfo>

/** The native host's own `broker.status` answer. */
export const BrokerStatusSchema = z.object({
  callerOrigin: z.string(),
  extension: ExtensionInfoSchema.nullable(),
  socketPath: z.string(),
})
export type BrokerStatus = z.infer<typeof BrokerStatusSchema>

export const TabInfoSchema = z.object({
  controlled: z.boolean().optional(),
  active: z.boolean(),
  id: z.number().int().nonnegative(),
  title: z.string(),
  url: z.string(),
  windowId: z.number().int(),
}) satisfies z.ZodType<TabInfo>

export const BrokerHelloSchema = z.object({
  kind: z.literal("hello"),
  clientId: z.string().min(1),
  // Optional so an older MCP server still authenticates; shown only in the extension popup.
  label: z.string().max(120).optional(),
  mode: z.enum(["managed", "observe"]).optional(),
  /** Present only on the detached Managed service; the native host authenticates its role. */
  serviceKey: z.string().min(32).optional(),
  token: z.string().min(32),
})

export const BrokerHelloResultSchema = z.object({
  kind: z.literal("hello"),
  ok: z.boolean(),
  extension: ExtensionInfoSchema.nullable().optional(),
  error: z.string().optional(),
})

export const BrokerRequestSchema = z.object({
  kind: z.literal("request"),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
})

export const BrokerResponseSchema = z.object({
  kind: z.literal("response"),
  id: z.string().min(1),
  result: z.unknown().optional(),
  error: z.string().optional(),
})

export const BrokerNotificationSchema = z.object({
  kind: z.literal("notification"),
  method: z.string().min(1),
  params: z.unknown().optional(),
})
