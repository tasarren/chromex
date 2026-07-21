import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFrame, FrameDecoder } from "../src/shared/framing.js";

test("decodes fragmented and adjacent frames", () => {
  const first = encodeFrame({ value: 1 });
  const second = encodeFrame(["two"]);
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(first.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(Buffer.concat([first.subarray(3), second])), [
    { value: 1 },
    ["two"],
  ]);
  assert.equal(decoder.pendingBytes, 0);
});

test("rejects oversized incoming frames", () => {
  const decoder = new FrameDecoder(2);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(3);
  assert.throws(() => decoder.push(header), /maximum is 2/);
});
