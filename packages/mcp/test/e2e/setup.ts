import { access, mkdir, mkdtemp, readdir, readFile } from "node:fs/promises"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import type { TestProject } from "vitest/node"
import { serveFixture } from "../../../extension/dev/serve.ts"

declare module "vitest" {
  interface ProvidedContext {
    /** Fixture server origin with a trailing slash. */
    fixture: string
    /** Disposable root of this run: data home and workspaces. */
    root: string
  }
}

export const DIST = fileURLToPath(new URL("../../../plugin/dist/chromex/dist/", import.meta.url))

/** Disposable fixtures. Set CHROMEX_TMP to choose the folder; the system temp folder is the default. */
export function getTmpDir(): string {
  return process.env.CHROMEX_TMP ?? tmpdir()
}

/** Start the fixture and one disposable root; teardown closes every browser the run started. */
export default async function setup(project: TestProject) {
  for (const file of ["extension/manifest.json", "mcp-server.mjs"]) {
    await access(join(DIST, file)).catch(() => { throw new Error(`Run pnpm build first: ${file} missing`) })
  }
  // Headless unless a person asks to watch with CHROMEX_HEADLESS=0: a window takes desktop focus.
  process.env.CHROMEX_HEADLESS ??= "1"
  await mkdir(getTmpDir(), { recursive: true })
  const root = await mkdtemp(join(getTmpDir(), "run-"))
  const fixture = await serveFixture()
  project.provide("fixture", fixture.url)
  project.provide("root", root)
  return async() => {
    await fixture.close()
    await shutdownServices(join(root, "data"))
    await assertNoOwnedProcess(root)
  }
}

/** Close each Managed browser through its service's admitted `/shutdown`, as the last client would. */
async function shutdownServices(dataHome: string): Promise<void> {
  for (const service of await services(dataHome)) {
    if (service.pid > 0) await post(service.socketPath, service.token, "/shutdown").catch(() => undefined)
  }
}

/** Service descriptor written by the Managed service; the e2e oracle for browsers and profiles. */
export type Service = { browserId: string; configPath: string; pid: number; socketPath: string; token: string; workspace: { root: string } }

export async function services(dataHome: string): Promise<Service[]> {
  const workspaces = join(dataHome, "chromex/workspaces")
  const found: Service[] = []
  for (const scope of await readdir(workspaces).catch(() => [])) {
    const directory = join(workspaces, scope, "services")
    for (const name of (await readdir(directory).catch(() => [])).filter((file) => file.endsWith(".json"))) {
      found.push(JSON.parse(await readFile(join(directory, name), "utf8")) as Service)
    }
  }
  return found
}

export function post(socketPath: string, token: string, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    request({ headers: { authorization: `Bearer ${token}` }, method: "POST", path, socketPath }, (res) => {
      let body = ""
      res.setEncoding("utf8").on("data", (chunk: string) => { body += chunk })
      res.on("end", () => { if (res.statusCode === 200) resolve(); else reject(new Error(`${path} ${res.statusCode} ${body}`)) })
    }).on("error", reject).end("{}")
  })
}

/** Every Chromium and service of this run names the root in its argv; none may outlive teardown. */
async function assertNoOwnedProcess(root: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const owned = await processesMentioning(root)
    if (owned.length === 0) return
    if (attempt === 49) throw new Error(`Processes outlived the e2e run (${root}): ${owned.join(", ")}`)
    await delay(200)
  }
}

async function processesMentioning(text: string): Promise<number[]> {
  const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name))
  const argv = await Promise.all(pids.map((pid) => readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")))
  return pids.filter((_, index) => argv[index]?.includes(text)).map(Number)
}
