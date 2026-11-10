import { setTimeout as sleep } from "node:timers/promises"
import { expect, test } from "vitest"
import { FIXTURE, useAgent } from "./client.ts"

const s = useAgent("expiry")

// Any inspection renews the idle deadline, so the test stays silent for the whole wait.
test("a hold with no further call is released after 120 s", { timeout: 180_000 }, async() => {
  await s.a.call("chrome_open", { url: FIXTURE })
  const ref = (await s.a.call("chrome_snapshot")).match(/\[(e\d+)\] button "Button target"/)![1]
  await s.a.call("chrome_mouse_down", { ref })
  expect(await s.a.call("chrome_text")).not.toContain("pointerup")
  await sleep(125_000)
  expect(await s.a.call("chrome_text")).toMatch(/pointerup x=\d+ y=\d+ button=0 buttons=0 trusted=true/)
})
