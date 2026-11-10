import { Buffer } from "node:buffer"
import { expect, test } from "vitest"
import { encodeFrame, FrameDecoder } from "../../src/shared/framing.ts"

test("decodes fragmented and adjacent frames", () => {
  const first = encodeFrame({ value: 1 })
  const second = encodeFrame(["two"])
  const decoder = new FrameDecoder()
  expect(decoder.push(first.subarray(0, 3))).toEqual([])
  expect(decoder.push(Buffer.concat([first.subarray(3), second]))).toEqual([
    { value: 1 },
    ["two"],
  ])
  expect(decoder.pendingBytes).toBe(0)
})

test("rejects oversized incoming frames", () => {
  const decoder = new FrameDecoder(2)
  const header = Buffer.alloc(4)
  header.writeUInt32LE(3)
  expect(() => decoder.push(header)).toThrow(/maximum is 2/)
})
