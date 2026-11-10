import { readFile } from "node:fs/promises"
import { z } from "zod"

// Written by `chromex setup` (no `managed`) and by Managed launches (`managed: true`).
const BridgeConfigSchema = z.object({
  extensionOrigin: z.string(),
  managed: z.boolean().default(false),
  socketPath: z.string().min(1),
  token: z.string().min(32),
})
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>

/** Reads and validates the bridge config; the path is resolved by the caller. */
export async function loadBridgeConfig(path: string): Promise<BridgeConfig> {
  const text = await readFile(path, "utf8")
  try {
    return BridgeConfigSchema.parse(JSON.parse(text))
  } catch(cause) {
    throw new Error(`Invalid bridge config: ${path}`, { cause })
  }
}
