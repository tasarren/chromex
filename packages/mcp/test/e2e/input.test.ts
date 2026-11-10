import { expect, test } from "vitest"
import { FIXTURE, useAgent } from "./client.ts"
import { refFor } from "./refs.ts"

const s = useAgent("input")
const form = `${FIXTURE}pages/form.html`

test("type replaces and clear false appends", async() => {
  await s.a.call("chrome_open", { url: form })
  const name = refFor(await s.a.call("chrome_snapshot"), "textbox", "Name")
  await s.a.call("chrome_type", { ref: name, text: "first" })
  expect(await s.a.call("chrome_snapshot")).toContain("value=\"first\"")
  await s.a.call("chrome_type", { ref: name, text: " second", clear: false })
  expect(await s.a.call("chrome_snapshot")).toContain("value=\"first second\"")
})

test("press Enter submits the form", async() => {
  await s.a.call("chrome_navigate", { url: form })
  const name = refFor(await s.a.call("chrome_snapshot"), "textbox", "Name")
  await s.a.call("chrome_type", { ref: name, text: "Ada" })
  await s.a.call("chrome_press", { key: "Enter" })
  expect(await s.a.call("chrome_text")).toContain("submitted name=Ada choice=alpha submit=submit")
})

test("select chooses by value and by label", async() => {
  await s.a.call("chrome_navigate", { url: form })
  const choice = refFor(await s.a.call("chrome_snapshot"), "combobox", "Choice")
  const submit = refFor(await s.a.call("chrome_snapshot"), "button", "Submit")
  await s.a.call("chrome_select", { ref: choice, value: "beta" })
  await s.a.call("chrome_click", { ref: submit })
  expect(await s.a.call("chrome_text")).toContain("choice=beta")
  await s.a.call("chrome_select", { ref: choice, value: "Gamma" })
  await s.a.call("chrome_click", { ref: submit })
  expect(await s.a.call("chrome_text")).toContain("choice=gamma")
})
