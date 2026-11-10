import { type ChildProcess, execFile, spawn } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { NATIVE_HOST_NAME } from "@chromex/protocol"
import { afterAll, beforeAll, expect, inject, onTestFinished, test, vi } from "vitest"
import { type Agent, connect, expectLive, FIXTURE, workspace } from "./client.ts"
import { refFor } from "./refs.ts"
import { DIST, services } from "./setup.ts"

// Observe drives the person's own browser: this file starts one with the extension and native host
// as `chromex setup` leaves them, and grants a tab by clicking the toggle in the real popup page.
const BROWSER = process.env.CHROMEX_BROWSER ?? "/usr/bin/chromium"
const run = promisify(execFile)
type Target = { type: string; url: string; webSocketDebuggerUrl: string }
let a: Agent
let ws: string
let browser: ChildProcess
let devtools: string
let granted: number
let other: number

/** Evaluate one expression in the first DevTools target that matches, over plain CDP. */
async function evaluate<T>(match: (target: Target) => boolean, expression: string): Promise<T> {
  const target = (await (await fetch(`${devtools}/json/list`)).json() as Target[]).find(match)
  if (!target) throw new Error("No matching DevTools target")
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  type Reply = { id?: number; error?: unknown; result?: { exceptionDetails?: unknown; result: { value: T } } }
  // Bounded: a target that closes mid-call must reject, so the caller's waitFor can retry.
  const reply = await new Promise<Reply>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`evaluate timed out on ${target.url}`)) }, 5_000)
    const fail = (reason: string) => () => { clearTimeout(timer); reject(new Error(`${reason} on ${target.url}`)) }
    socket.addEventListener("error", fail("socket error"))
    socket.addEventListener("close", fail("socket closed before the reply"))
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { awaitPromise: true, expression, returnByValue: true } }))
    }, { once: true })
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Reply
      if (message.id === 1) { clearTimeout(timer); resolve(message) }
    })
  }).finally(() => { socket.close() })
  if (!reply.result || reply.result.exceptionDetails) throw new Error(JSON.stringify(reply.error ?? reply.result?.exceptionDetails))
  return reply.result.result.value
}
const inWorker = <T>(expression: string) => evaluate<T>((t) => t.type === "service_worker", expression)
const activate = (tabId: number) => inWorker<void>(`chrome.tabs.update(${tabId}, { active: true }).then(() => null)`)

/** Open the real action popup on the active tab and set "Allow agents on this tab". */
async function popup(enabled: boolean): Promise<void> {
  const isPopup = (t: Target) => t.url.endsWith("/popup.html")
  // Under a loaded parallel run the first openPopup can be lost; reopen until the popup answers.
  await vi.waitFor(async() => {
    const open = (await (await fetch(`${devtools}/json/list`)).json() as Target[]).some(isPopup)
    if (!open) await inWorker("chrome.action.openPopup().then(() => null)")
    return await evaluate(isPopup, `(async () => {
    const toggle = document.getElementById("observe")
    // Done is the worker-confirmed state: enabled again after the answer and checked as asked.
    if (!toggle.disabled && toggle.checked !== ${enabled}) toggle.click()
    // Bounded: a popup that closes or never answers must fail this try so waitFor reopens it.
    for (let waited = 0; toggle.disabled || toggle.checked !== ${enabled}; waited += 50) {
      if (waited >= 3000) throw new Error("popup did not answer: message=" + JSON.stringify(document.getElementById("message").textContent) + " checked=" + toggle.checked + " disabled=" + toggle.disabled)
      await new Promise((r) => setTimeout(r, 50))
    }
    window.close()
  })()`)
  }, { interval: 250, timeout: 30_000 })
}
const pageLog = () => evaluate<string>((t) => t.url === FIXTURE, "document.getElementById('log').textContent")

beforeAll(async() => {
  ws = await workspace("observe")
  const home = await mkdtemp(join(inject("root"), "observe-home-"))
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_RUNTIME_DIR: join(home, "run") }
  // Empty PATH: setup finds no agent CLI to register, and CHROMEX_BROWSER names the browser.
  await run(process.execPath, [join(DIST, "../../cli.mjs"), "setup", "--no-open"], {
    env: { ...env, CHROMEX_BROWSER: BROWSER, PATH: "" },
  })
  const profile = join(home, "profile")
  // A custom --user-data-dir reads native hosts from the profile, not from XDG_CONFIG_HOME.
  const manifest = `${NATIVE_HOST_NAME}.json`
  await mkdir(join(profile, "NativeMessagingHosts"), { recursive: true })
  await copyFile(join(env.XDG_CONFIG_HOME, "chromium/NativeMessagingHosts", manifest), join(profile, "NativeMessagingHosts", manifest))
  const headless = process.env.CHROMEX_HEADLESS === "1"
  browser = spawn(BROWSER, [
    `--user-data-dir=${profile}`,
    `--load-extension=${join(home, "plugins/chromex/dist/extension")}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    ...(headless ? ["--headless"] : []),
    ...(headless && process.env.CI ? ["--no-sandbox"] : []),
    FIXTURE,
  ], { env: { ...process.env, ...env }, stdio: "ignore" })
  let port: string | undefined
  while (!port) {
    await delay(100)
    port = (await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "")).split("\n")[0]
  }
  devtools = `http://127.0.0.1:${port}`
  granted = await vi.waitFor(() => inWorker<number>("chrome.tabs.query({ active: true }).then(([tab]) => tab.id)"), { timeout: 10_000 })
  await popup(true)
  // A second, ungranted tab: it is refused, and selecting it puts the granted tab in the background.
  other = await inWorker<number>(`chrome.tabs.create({ url: ${JSON.stringify(`${FIXTURE}pages/second.html`)} }).then((tab) => tab.id)`)
  a = await connect(ws, ["--workspace", ws], env)
  await a.call("chrome_status", { observe: true })
  await expectLive(a)
})

afterAll(async() => {
  browser.kill() // first: a failed beforeAll leaves no agent but must not leave the browser
  await a.close()
})

test("only granted tabs are listed; an ungranted tab is refused", async() => {
  const tabs = await a.json<{ id: number }[]>("chrome_tabs", { observe: true })
  expect(tabs.map((tab) => tab.id)).toEqual([granted])
  await expect(a.call("chrome_use_tab", { tabId: other })).rejects.toThrow("Observe access disabled")
  await a.call("chrome_use_tab", { tabId: granted })
})

test("the granted tab takes input while it is the selected tab (DEC-86)", async() => {
  await activate(granted)
  onTestFinished(() => activate(other))
  const ref = refFor(await a.call("chrome_snapshot"), "button", "Button target")
  expect(await a.call("chrome_click", { ref })).toMatch(/^cursor \d+,\d+ held none /)
  await vi.waitFor(async() => { expect(await pageLog()).toMatch(/click x=\d+ y=\d+ button=0 buttons=0 trusted=true/) })
})

test("pointer tools, the cursor and the screenshot line work on the granted tab", async() => {
  const ref = refFor(await a.call("chrome_snapshot"), "button", "Button target")
  expect(await a.call("chrome_click", { ref })).toMatch(/^cursor \d+,\d+ held none viewport \d+x\d+ scroll 0,0$/)
  expect(await a.call("chrome_click", { ref, button: "right" })).toMatch(/held none/)
  expect(await a.call("chrome_text")).toMatch(/click x=\d+ y=\d+ button=0 buttons=0 trusted=true[\s\S]*contextmenu x=\d+ y=\d+ button=2/)
  expect(await a.call("chrome_mouse_move", { x: 200, y: 150 })).toMatch(/^cursor 200,150 held none /)
  const measured = await a.json<{ elements: { element: { rect: { x: number; y: number } } | null }[] }>("chrome_measure", { selectors: ["chromex-cursor"] })
  expect(measured.elements[0]?.element?.rect).toMatchObject({ x: 200, y: 150 })
  const shot = await a.raw("chrome_screenshot")
  expect((shot.content as { text?: string }[])[1]?.text).toMatch(/^png \d+x\d+ css \d+x\d+ scale [\d.]+ scroll 0,0 cursor 200,150 held none$/)
})

test("revoke during a hold releases the button; no Managed browser started", async() => {
  const ref = refFor(await a.call("chrome_snapshot"), "button", "Button target")
  expect(await a.call("chrome_mouse_down", { ref })).toMatch(/held left/)
  await activate(granted)
  await popup(false)
  await vi.waitFor(async() => { expect(await pageLog()).toMatch(/pointerup x=\d+ y=\d+ button=0 buttons=0 trusted=true/) }, { timeout: 10_000 })
  expect(await a.json("chrome_tabs", { observe: true })).toEqual([])
  expect((await services(join(inject("root"), "data"))).filter((service) => service.workspace.root === ws)).toEqual([])
})
