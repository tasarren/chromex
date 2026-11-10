import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { FIXTURE, useAgent } from "./client.ts"

const s = useAgent("screenshot")
const page = `${FIXTURE}pages/screenshot.html`
type Content = { type: string; data?: string; text?: string }

async function shot(args: { path?: string; clean?: boolean } = {}) {
  const content = (await s.a.raw("chrome_screenshot", args)).content as Content[]
  const data = content.find((item) => item.type === "image")?.data ?? ""
  return { data, line: content.find((item) => item.type === "text")?.text ?? "", png: Buffer.from(data, "base64") }
}

describe.each([390, 1440, 1920])("at %i px", (width) => {
  test("the line maps a pixel to a click point and clean hides only the cursor", async() => {
    await s.a.call("chrome_open", { url: page })
    await s.a.call("chrome_viewport", { width, height: 900 })
    const bare = await shot()
    // Managed forces device scale 1 (ISS-17): an image pixel is a click point.
    const match = new RegExp(`^png (\\d+)x(\\d+) css ${width}x900 scale 1 scroll 0,0 cursor none held none$`).exec(bare.line)
    expect(match).not.toBeNull()
    expect([Number(match![1]), Number(match![2])]).toEqual([bare.png.readUInt32BE(16), bare.png.readUInt32BE(20)])
    const result = await s.a.call("chrome_click", { x: 80, y: 125 })
    expect(await s.a.call("chrome_text")).toContain("click 80,125")
    expect(result).toMatch(/^cursor 80,125 held none /)
    await s.a.call("chrome_mouse_move", { x: 300, y: 300 })
    const clean = await shot({ clean: true })
    expect(clean.line).toMatch(/ cursor 300,300 held none$/)
    expect(clean.data).not.toBe((await shot()).data)
  })
})

test("a path writes a new file and an existing path is refused", async() => {
  await s.a.call("chrome_navigate", { url: page })
  const path = join(s.workspace, "shot.png")
  const { line } = await shot({ path })
  const bytes = (await stat(path)).size
  expect(line).toMatch(new RegExp(` path ${path} bytes ${bytes}$`))
  expect((await readFile(path)).subarray(1, 4).toString()).toBe("PNG")
  await expect(s.a.raw("chrome_screenshot", { path })).resolves.toMatchObject({ isError: true })
})
