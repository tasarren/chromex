import { expect, test } from "vitest"
import { FIXTURE, connect, useAgent, workspace, type Agent } from "./client.ts"
import { refFor } from "./refs.ts"

const s = useAgent("tabs")
const form = `${FIXTURE}pages/form.html`
type Tab = { id: number; url: string; controlled?: boolean }
const tabs = async(agent: Agent) => await agent.json<Tab[]>("chrome_tabs")
const typeName = async(agent: Agent, text: string) =>
  await agent.call("chrome_type", { ref: refFor(await agent.call("chrome_snapshot"), "textbox", "Name"), text })

/** B joins A's browser in the same workspace; each test that needs B starts and closes its own. */
async function withB<T>(run: (b: Agent) => Promise<T>): Promise<T> {
  const b = await connect(s.workspace)
  try {
    return await run(b)
  } finally {
    await b.close()
  }
}

test("another agent sees A's tab as controlled, cannot claim it, and may inspect it read-only", async() => {
  const { id } = await s.a.json<Tab>("chrome_open", { url: form })
  await withB(async(b) => {
    expect((await tabs(b)).find((tab) => tab.id === id)).toMatchObject({ controlled: true })
    await expect(b.call("chrome_use_tab", { tabId: id })).rejects.toThrow("controlled by another client")
    await b.call("chrome_use_tab", { tabId: id, inspect: true })
    expect(await b.call("chrome_text")).toContain("Fixture form")
    expect(await b.call("chrome_snapshot")).toContain("textbox \"Name\"")
    expect((await b.raw("chrome_screenshot")).content).toContainEqual(expect.objectContaining({ type: "image" }))
    await expect(typeName(b, "B")).rejects.toThrow()
    await expect(b.call("chrome_click", { x: 10, y: 10 })).rejects.toThrow()
    await expect(b.call("chrome_navigate", { url: FIXTURE })).rejects.toThrow()
  })
})

test("after A releases, B claims and types; A's next input is refused", async() => {
  const { selectedTabId } = await s.a.json<{ selectedTabId: number }>("chrome_status")
  await s.a.call("chrome_release")
  await withB(async(b) => {
    await b.call("chrome_use_tab", { tabId: selectedTabId })
    await typeName(b, "from B")
    expect(await b.call("chrome_snapshot")).toContain("value=\"from B\"")
    await expect(s.a.call("chrome_click", { x: 10, y: 10 })).rejects.toThrow()
  })
})

test("A and B type in parallel into their own tabs of one browser", async() => {
  await s.a.call("chrome_open", { url: form })
  await withB(async(b) => {
    await b.call("chrome_open", { url: form })
    await Promise.all([typeName(s.a, "alpha text"), typeName(b, "beta text")])
    expect(await s.a.call("chrome_snapshot")).toContain("value=\"alpha text\"")
    expect(await b.call("chrome_snapshot")).toContain("value=\"beta text\"")
  })
})

test("A closes its own tab; closing a tab B claims is refused; the last close leaves a blank tab", async() => {
  await withB(async(b) => {
    const { id } = await b.json<Tab>("chrome_open", { url: `${FIXTURE}pages/second.html` })
    await s.a.call("chrome_use_tab", { tabId: id, inspect: true })
    await expect(s.a.call("chrome_close_tab")).rejects.toThrow()
    await b.call("chrome_close_tab")
    expect((await tabs(b)).map((tab) => tab.id)).not.toContain(id)
  })
  // A browser of its own, so the closed tab is the last one.
  const solo = await connect(await workspace("tabs-last"))
  try {
    await solo.call("chrome_open", { url: form })
    await solo.call("chrome_close_tab")
    const left = await tabs(solo)
    expect(left).toHaveLength(1)
    expect(left[0]!.url).toMatch(/^(about:blank|chrome:\/\/newtab)/)
  } finally {
    await solo.close()
  }
})

test("when A exits while controlling a tab, B can claim it", async() => {
  const a2 = await connect(s.workspace)
  const { id } = await a2.json<Tab>("chrome_open", { url: form })
  await a2.close()
  await withB(async(b) => {
    await b.call("chrome_use_tab", { tabId: id })
    expect(await b.call("chrome_text")).toContain("Fixture form")
  })
})

test("during A's hold B may inspect A's tab but a second hold in the browser is refused POINTER_BUSY", async() => {
  const { id } = await s.a.json<Tab>("chrome_open", { url: FIXTURE })
  await s.a.call("chrome_mouse_down", { ref: refFor(await s.a.call("chrome_snapshot"), "button", "Button target") })
  try {
    await withB(async(b) => {
      await b.call("chrome_use_tab", { tabId: id, inspect: true })
      expect(await b.call("chrome_text")).toContain("pointerdown")
      await b.call("chrome_open", { url: FIXTURE })
      await expect(b.call("chrome_mouse_down", { x: 200, y: 150 })).rejects.toThrow(/POINTER_BUSY/)
    })
  } finally {
    await s.a.call("chrome_mouse_cancel")
  }
})

test("when A exits during a hold the button is released and B can claim the tab", async() => {
  const a2 = await connect(s.workspace)
  const { id } = await a2.json<Tab>("chrome_open", { url: FIXTURE })
  const ref = refFor(await a2.call("chrome_snapshot"), "button", "Button target")
  await a2.call("chrome_mouse_down", { ref })
  await a2.close()
  await withB(async(b) => {
    await expect.poll(async() => {
      await b.call("chrome_use_tab", { tabId: id }).catch(() => undefined)
      return await b.call("chrome_text").catch(() => "")
    }, { timeout: 10_000 }).toMatch(/pointerup x=\d+ y=\d+ button=0 buttons=0 trusted=true/)
  })
})
