const HEADER_BYTES = 4;
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;

export function encodeFrame(value: unknown, maxBytes = DEFAULT_MAX_FRAME_BYTES): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > maxBytes) {
    throw new Error(`Frame is ${payload.length} bytes; maximum is ${maxBytes}`);
  }
  const frame = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, HEADER_BYTES);
  return frame;
}

export class FrameDecoder {
  private buffer = Buffer.alloc(0);

  constructor(private readonly maxBytes = DEFAULT_MAX_FRAME_BYTES) {}

  push(chunk: Buffer | Uint8Array): unknown[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const values: unknown[] = [];

    while (this.buffer.length >= HEADER_BYTES) {
      const length = this.buffer.readUInt32LE(0);
      if (length > this.maxBytes) {
        throw new Error(`Incoming frame is ${length} bytes; maximum is ${this.maxBytes}`);
      }
      if (this.buffer.length < HEADER_BYTES + length) break;

      const payload = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
      this.buffer = this.buffer.subarray(HEADER_BYTES + length);
      values.push(JSON.parse(payload.toString("utf8")));
    }

    return values;
  }

  get pendingBytes(): number {
    return this.buffer.length;
  }
}
