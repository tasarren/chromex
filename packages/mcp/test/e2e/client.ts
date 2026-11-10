import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { afterAll, beforeAll, expect, inject } from "vitest"
import { DIST } from "./setup.ts"

export const FIXTURE = inject("fixture")

/** One agent: a real built MCP server over stdio, as OpenCode starts one per session. */
export class Agent {
  readonly client = new Client({ name: "e2e", version: "0" })

  /** Text of a tool result; a tool error throws its text. */
  async call(name: string, args: object = {}): Promise<string> {
    const result = await this.client.callTool({ name, arguments: { ...args } })
    const text = (result.content as { type: string; text?: string }[]).map((item) => item.text ?? "").join("\n")
    if (result.isError) throw new Error(text)
    return text
  }

  /** Parsed JSON result of a tool that answers JSON. */
  async json<T = Record<string, unknown>>(name: string, args: object = {}): Promise<T> {
    return JSON.parse(await this.call(name, args)) as T
  }

  /** Raw MCP result, for image content. */
  async raw(name: string, args: object = {}) {
    return await this.client.callTool({ name, arguments: { ...args } })
  }

  async close(): Promise<void> {
    await this.client.close()
  }
}

/** A fresh Git worktree under the run root, so each test file gets its own browsers and locks. */
export async function workspace(name: string): Promise<string> {
  const directory = await mkdtemp(join(inject("root"), `${name}-`))
  execFileSync("git", ["init", "-q"], { cwd: directory })
  return directory
}

/** Start an agent in `cwd`; `--workspace` is added unless `args` is given explicitly. `env` overrides. */
export async function connect(cwd: string, args: string[] = ["--workspace", cwd], env: Record<string, string> = {}): Promise<Agent> {
  const data = join(inject("root"), "data")
  await mkdir(data, { recursive: true })
  const agent = new Agent()
  await agent.client.connect(new StdioClientTransport({
    args: [join(DIST, "mcp-server.mjs"), ...args],
    command: process.execPath,
    cwd,
    env: { ...process.env as Record<string, string>, XDG_DATA_HOME: data, ...env },
    stderr: "inherit",
  }))
  return agent
}

/**
 * The usual file shape: one workspace, agent A connected, the extension proven live before the
 * first test. Returns a holder filled in `beforeAll`.
 */
export function useAgent(name: string): { a: Agent; workspace: string } {
  const holder = {} as { a: Agent; workspace: string }
  beforeAll(async() => {
    holder.workspace = await workspace(name)
    holder.a = await connect(holder.workspace)
    await expectLive(holder.a)
  })
  afterAll(async() => { await holder.a.close() })
  return holder
}

/** The file never runs against a bare browser: the extension must answer with this release. */
export async function expectLive(agent: Agent): Promise<void> {
  const status = await agent.json<{ extension: { extensionVersion: string; protocolVersion: number } | null }>("chrome_status")
  expect(status.extension).toMatchObject({ extensionVersion: "0.1.3", protocolVersion: 3 })
}
