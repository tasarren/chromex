import { errorMessage } from "@chromex/protocol"
import { loadBridgeConfig } from "../shared/config.ts"
import { SERVICE_KEY_ENV } from "../shared/env.ts"
import { bridgeConfigPath } from "../shared/paths.ts"
import { NativeHost } from "./host.ts"

const config = await loadBridgeConfig(bridgeConfigPath())
const callerOrigin = process.argv[2] ?? ""
if (callerOrigin !== config.extensionOrigin) {
  fail(`Rejected native-messaging caller ${JSON.stringify(callerOrigin)}`)
}

const host = new NativeHost(config, callerOrigin, {
  write: (frame) => {
    if (!process.stdout.destroyed) process.stdout.write(frame)
  },
  log,
}, process.env[SERVICE_KEY_ENV] === undefined ? {} : { serviceKey: process.env[SERVICE_KEY_ENV] })
await host.listen()

process.stdin.on("data", (chunk: Buffer) => {
  try {
    host.receive(chunk)
  } catch(cause) {
    fail(`Invalid message from extension: ${errorMessage(cause)}`)
  }
})
process.stdin.on("end", () => void exit(0))
process.stdin.on("error", (cause) => fail(`Chrome stdin error: ${errorMessage(cause)}`))
process.stdout.on("error", (cause: NodeJS.ErrnoException) => {
  const closed = cause.code === "EPIPE"
  if (!closed) log(`Chrome stdout error: ${errorMessage(cause)}`)
  void exit(closed ? 0 : 1)
})
process.on("SIGINT", () => void exit(0))
process.on("SIGTERM", () => void exit(0))

async function exit(code: number): Promise<void> {
  await host.shutdown()
  process.exit(code)
}

function log(message: string): void {
  process.stderr.write(`[chromex] ${message}\n`)
}

function fail(message: string): never {
  log(message)
  process.exit(1)
}
