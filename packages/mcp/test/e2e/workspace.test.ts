import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, inject, onTestFinished, test } from "vitest"
import { connect, expectLive, workspace, type Agent } from "./client.ts"

const agents: Agent[] = []
const start = async(...args: Parameters<typeof connect>) => {
  const agent = await connect(...args)
  agents.push(agent)
  return agent
}
afterAll(async() => { await Promise.all(agents.map(async(agent) => { await agent.close() })) })

test("a server inside a Git worktree without --workspace uses that worktree (ISS-01)", async() => {
  const root = await workspace("ws-cwd")
  const nested = join(root, "src")
  await mkdir(nested)
  const agent = await start(nested, [])
  await expectLive(agent)
  expect((await agent.json<{ managed: { workspace: string } }>("chrome_status")).managed.workspace).toBe(await realpath(root))
})

test("a non-Git directory without --workspace refuses Managed and still allows Observe", async() => {
  // The local temp root sits inside this repository's worktree, so a non-Git directory must live elsewhere.
  const plain = await mkdtemp(join(tmpdir(), "chromex-plain-"))
  onTestFinished(async() => { await rm(plain, { force: true, recursive: true }) })
  const agent = await start(plain, [])
  await expect(agent.call("chrome_status")).rejects.toThrow(/No trusted workspace/)
  // No person's browser here, so Observe may fail to connect, but never for the workspace.
  const observe = await agent.call("chrome_status", { observe: true }).catch((error: unknown) => String(error))
  expect(observe).not.toMatch(/workspace/i)
})

test("two workspaces get two separate default browsers", async() => {
  const [one, two] = await Promise.all([workspace("ws-one"), workspace("ws-two")])
  const [a, b] = await Promise.all([start(one), start(two)])
  await Promise.all([expectLive(a), expectLive(b)])
  type Status = { managed: { workspace: string } }
  const [sa, sb] = await Promise.all([a.json<Status>("chrome_status"), b.json<Status>("chrome_status")])
  expect(sa.managed.workspace).not.toBe(sb.managed.workspace)
  // browserId is the profile name ("default") in both, so the separate tab lists are the proof.
  await a.call("chrome_open", { url: `${inject("fixture")}pages/second.html` })
  expect(await b.call("chrome_tabs")).not.toContain("second.html")
})
