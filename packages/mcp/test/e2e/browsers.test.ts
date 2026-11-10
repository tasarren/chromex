import { access, readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { afterAll, expect, inject, test } from "vitest"
import { FIXTURE, connect, expectLive, useAgent, workspace, type Agent } from "./client.ts"
import { post, services } from "./setup.ts"

const s = useAgent("browsers")
type Status = { managed: { browserId: string; joinedExisting: boolean; profile: string; temporary: boolean; workspace: string } }
type Tab = { id: number; url: string }
const agents: Agent[] = []
afterAll(async() => { await Promise.all(agents.map(async(agent) => await agent.close().catch(() => undefined))) })

async function start(cwd = s.workspace): Promise<Agent> {
  const agent = await connect(cwd)
  agents.push(agent)
  return agent
}

/** Main Chromium processes (no `--type=`) of one user-data directory, read from the process table. */
async function chromium(userDataDir: (dir: string) => boolean): Promise<{ pid: number; dir: string }[]> {
  const found: { pid: number; dir: string }[] = []
  for (const pid of (await readdir("/proc")).filter((name) => /^\d+$/.test(name))) {
    // Chromium rewrites its process title into one space-joined string; test paths hold no spaces.
    const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split(/[\0 ]/)
    const dir = argv.find((arg) => arg.startsWith("--user-data-dir="))?.slice(16)
    if (dir && userDataDir(dir) && !argv.some((arg) => arg.startsWith("--type="))) found.push({ pid: Number(pid), dir })
  }
  return found
}

/** Close one browser the way the last client does: its clients exit, then the service shuts down. */
async function shutdown(browserId: string, ...clients: Agent[]): Promise<void> {
  for (const client of clients) await client.close()
  const service = (await services(join(inject("root"), "data"))).find((item) => item.browserId === browserId && item.pid > 0)
  // The extension drops a closed client's record after its native host exits, not at once.
  await expect.poll(async() => await post(service!.socketPath, service!.token, "/shutdown").then(() => "closed", (error: unknown) => String(error)),
    { timeout: 10_000, interval: 500 }).toBe("closed")
}

test("the first status starts the default Managed browser of the workspace", async() => {
  expect(await s.a.json<Status>("chrome_status")).toMatchObject({
    extension: { extensionVersion: "0.1.3", protocolVersion: 3 },
    managed: { browserId: "default", profile: "default", temporary: false, workspace: expect.stringContaining("browsers-") },
  })
})

test("a second agent in the workspace joins the same browser", async() => {
  const b = await start()
  expect((await b.json<Status>("chrome_status")).managed).toMatchObject({ browserId: "default", joinedExisting: true })
})

test("another profile starts a second browser with its own tabs", async() => {
  const b = await start()
  await s.a.call("chrome_open", { url: `${FIXTURE}pages/second.html` })
  const opened = await b.json<Tab>("chrome_open", { url: `${FIXTURE}pages/form.html`, profile: "other" })
  expect((await b.json<Status>("chrome_status")).managed.browserId).toBe("other")
  expect((await s.a.json<Tab[]>("chrome_tabs")).map((tab) => tab.id)).not.toContain(opened.id)
  expect(await b.call("chrome_tabs")).not.toContain("second.html")
})

test("profile data persists across a browser restart", async() => {
  const home = await workspace("persist")
  const first = await start(home)
  await first.call("chrome_open", { url: `${FIXTURE}pages/storage.html?set=kept` })
  // ponytail: SIGTERM stands in for the service shutdown until TASK-03 fixes ISS-11.
  await restart(home, "SIGTERM", first)
  await first.call("chrome_open", { url: `${FIXTURE}pages/storage.html` })
  expect(await first.call("chrome_text")).toContain("stored kept")
})

test("a temporary browser is separate, joinable by browserId only in its workspace, and deleted on close", async() => {
  const owner = await start()
  const earlier = new Set((await chromium((dir) => dir.includes("/sessions/"))).map((item) => item.dir))
  await owner.call("chrome_open", { url: FIXTURE, temporary: true })
  const { managed } = await owner.json<Status>("chrome_status")
  expect(managed).toMatchObject({ temporary: true })
  expect(managed.browserId).not.toBe("default")
  const c = await start()
  expect((await c.json<Status>("chrome_status", { browserId: managed.browserId })).managed.joinedExisting).toBe(true)
  const stranger = await start(await workspace("stranger"))
  await expect(stranger.call("chrome_status", { browserId: managed.browserId })).rejects.toThrow()
  const [profile] = await chromium((dir) => dir.includes("/sessions/") && !earlier.has(dir))
  expect(profile).toBeDefined()
  await shutdown(managed.browserId, owner, c)
  await expect.poll(async() => await access(profile!.dir).then(() => "present", () => "gone")).toBe("gone")
})

test("when an agent exits its browser and tabs stay for the next agent", async() => {
  const leaver = await connect(s.workspace)
  const { id } = await leaver.json<Tab>("chrome_open", { url: `${FIXTURE}pages/wait.html` })
  await leaver.close()
  const next = await start()
  expect((await next.json<Tab[]>("chrome_tabs")).map((tab) => tab.id)).toContain(id)
})

test("the last client closes its own browser through the service shutdown", async() => {
  const home = await workspace("close-own")
  const agent = await start(home)
  await agent.call("chrome_open", { url: FIXTURE })
  const service = (await services(join(inject("root"), "data"))).find(
    (item) => item.workspace.root === home && item.browserId === "default",
  )
  expect(service).toBeDefined()
  await agent.close()
  await expect.poll(
    async() => await post(service!.socketPath, service!.token, "/shutdown").then(() => "closed", (error: unknown) => String(error)),
    { timeout: 10_000, interval: 500 },
  ).toBe("closed")
  const scope = `/${basename(home)}-`
  await expect.poll(async() => await chromium((dir) => dir.includes(scope)), { timeout: 10_000 }).toHaveLength(0)
})

test("two agents starting one profile at once share a single browser", async() => {
  const home = await workspace("race")
  const [a, b] = await Promise.all([start(home), start(home)])
  const managed = await Promise.all([a, b].map(async(agent) => (await agent.json<Status>("chrome_status")).managed))
  expect(managed.map((item) => item.joinedExisting).sort()).toEqual([false, true])
  expect(await chromium((dir) => dir.includes(`/${basename(home)}-`))).toHaveLength(1)
})

test("a Managed service killed during a hold leaves the browser usable for a new hold", async() => {
  const home = await workspace("service-kill")
  const agent = await start(home)
  await agent.call("chrome_open", { url: FIXTURE })
  await agent.call("chrome_mouse_down", { x: 100, y: 100 })
  const service = (await services(join(inject("root"), "data"))).find((item) => item.workspace.root === home)
  process.kill(service!.pid, "SIGKILL")
  // The first call after the loss may fail on the dead socket or the dropped tab; either is fine.
  await agent.call("chrome_mouse_move", { x: 120, y: 100 }).catch(() => undefined)
  await agent.call("chrome_open", { url: FIXTURE })
  expect(await agent.call("chrome_mouse_down", { x: 100, y: 100 })).toMatch(/ held left /)
  expect(await agent.call("chrome_mouse_up")).toMatch(/ held none /)
  expect((await agent.json<{ orphanedInput: unknown }>("chrome_status")).orphanedInput).toBeNull()
})

test("a Chromium killed from outside restarts on the same profile at the next status", async() => {
  await restart(s.workspace, "SIGKILL", s.a)
})

/** Signal the default Chromium of `home`; the agent's next status starts it again on the same profile. */
async function restart(home: string, signal: NodeJS.Signals, agent: Agent): Promise<void> {
  const scope = `/${basename(home)}-`
  const [before] = await chromium((dir) => dir.includes(scope) && dir.endsWith("/profiles/default"))
  if (!before) throw new Error(`No default Chromium for ${home}`)
  process.kill(before.pid, signal)
  await expect.poll(async() => await chromium((dir) => dir === before.dir), { timeout: 10_000 }).toHaveLength(0)
  await expect.poll(async() => {
    await agent.call("chrome_status").catch(() => undefined)
    return (await chromium((dir) => dir === before.dir)).length
  }, { timeout: 30_000 }).toBe(1)
  await expectLive(agent)
}
