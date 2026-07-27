import { Buffer } from "node:buffer";
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { errorMessage } from "../protocol/schema.js";

const DEFAULT_CAPACITY_BYTES = 1024 * 1024;
const OUTPUT_ENTRY_CHARS = 256;
const FAILURE_TAIL_CHARS = 8 * 1024;
const URL_TOKEN = /\b(?:https?|file|chrome|chrome-extension):\/\/[^\s"'<>()[\]{}]+/giu;

export type ManagedProcessStream = "stdout" | "stderr";
export type ManagedProcessOutputStream = ManagedProcessStream | "all";
export type ManagedProcessState = "launching" | "running" | "failed" | "exited";

export type ManagedProcessOutputEntry = {
  cursor: number;
  stream: ManagedProcessStream;
  text: string;
};

export type ManagedProcessOutputQuery = {
  cursor?: number | undefined;
  maxChars: number;
  stream: ManagedProcessOutputStream;
};

export type ManagedProcessOutputPolicy = {
  isAllowed(value: string): boolean;
};

export type ManagedProcessOutputResult = {
  process: {
    args: string[];
    executable: string;
    exitCode: number | null;
    pid: number | null;
    signal: NodeJS.Signals | null;
    spawnError: string | null;
    state: ManagedProcessState;
  };
  output: {
    droppedBytes: number;
    entries: ManagedProcessOutputEntry[];
    firstCursor: number | null;
    lastCursor: number | null;
    olderCursor: number | null;
    retainedBytes: number;
    stream: ManagedProcessOutputStream;
    truncatedBefore: boolean;
  };
};

type StoredEntry = ManagedProcessOutputEntry & { bytes: number };

export interface ManagedProcessOutputSource {
  failureMessage(summary: string, policy?: ManagedProcessOutputPolicy): string;
  read(
    query: ManagedProcessOutputQuery,
    policy?: ManagedProcessOutputPolicy,
  ): ManagedProcessOutputResult;
}

export class ManagedProcessOutputCapture implements ManagedProcessOutputSource {
  private readonly entries: StoredEntry[] = [];
  private readonly pending = { stderr: "", stdout: "" };
  private droppedBytes = 0;
  private drained: Promise<void> = Promise.resolve();
  private exitCode: number | null = null;
  private nextCursor = 1;
  private pid: number | null = null;
  private retainedBytes = 0;
  private signal: NodeJS.Signals | null = null;
  private spawnError: string | null = null;
  private state: ManagedProcessState = "launching";

  constructor(
    private readonly executable: string,
    private readonly args: string[],
    private readonly secrets: string[],
    private readonly capacityBytes = DEFAULT_CAPACITY_BYTES,
  ) {}

  attach(child: ChildProcess): void {
    this.drained = new Promise((resolve) => child.once("close", () => resolve()));
    this.pid = child.pid ?? null;
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.ingest("stdout", chunk));
      child.stdout.once("end", () => this.flush("stdout"));
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => this.ingest("stderr", chunk));
      child.stderr.once("end", () => this.flush("stderr"));
    }
    child.once("spawn", () => {
      if (this.state === "launching") this.state = "running";
    });
    child.once("error", (cause) => {
      this.spawnError = errorMessage(cause);
      this.state = "failed";
    });
    child.once("exit", (code, signal) => {
      this.exitCode = code;
      this.signal = signal;
      if (this.state !== "failed") this.state = "exited";
    });
  }

  markFailed(): void {
    this.state = "failed";
  }

  get launchError(): string | null {
    return this.spawnError;
  }

  async waitForDrain(timeoutMs = 250): Promise<void> {
    await Promise.race([this.drained, delay(timeoutMs, undefined, { ref: false })]);
  }

  read(
    query: ManagedProcessOutputQuery,
    policy?: ManagedProcessOutputPolicy,
  ): ManagedProcessOutputResult {
    const upperCursor = query.cursor ?? this.nextCursor;
    const candidates = this.entries.filter(
      (entry) =>
        entry.cursor < upperCursor && (query.stream === "all" || entry.stream === query.stream),
    );
    const selected: StoredEntry[] = [];
    let selectedChars = 0;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const entry = candidates[index];
      if (!entry) continue;
      if (selected.length > 0 && selectedChars + entry.text.length > query.maxChars) break;
      selected.unshift(entry);
      selectedChars += entry.text.length;
    }
    const first = selected[0];
    const hasOlder = first ? candidates.some((entry) => entry.cursor < first.cursor) : false;
    return {
      process: {
        args: [...this.args],
        executable: this.executable,
        exitCode: this.exitCode,
        pid: this.pid,
        signal: this.signal,
        spawnError: this.spawnError,
        state: this.state,
      },
      output: {
        droppedBytes: this.droppedBytes,
        entries: visibleEntries(selected, policy),
        firstCursor: this.entries[0]?.cursor ?? null,
        lastCursor: this.entries.at(-1)?.cursor ?? null,
        olderCursor: hasOlder && first ? first.cursor : null,
        retainedBytes: this.retainedBytes,
        stream: query.stream,
        truncatedBefore: this.droppedBytes > 0,
      },
    };
  }

  failureMessage(summary: string, policy?: ManagedProcessOutputPolicy): string {
    const result = this.read({ maxChars: FAILURE_TAIL_CHARS, stream: "all" }, policy);
    const termination = [
      result.process.spawnError ? `spawn error: ${result.process.spawnError}` : null,
      result.process.exitCode === null ? null : `exit code ${result.process.exitCode}`,
      result.process.signal === null ? null : `signal ${result.process.signal}`,
    ].filter((value): value is string => value !== null);
    const heading = termination.length === 0 ? summary : `${summary} (${termination.join(", ")})`;
    if (result.output.entries.length === 0) return heading;
    let output = "";
    let previousStream: ManagedProcessStream | null = null;
    for (const entry of result.output.entries) {
      if (entry.stream !== previousStream) {
        if (output.length > 0 && !output.endsWith("\n")) output += "\n";
        output += `[${entry.stream}]\n`;
        previousStream = entry.stream;
      }
      output += entry.text;
    }
    return `${heading}\nChromium process output (tail):\n${output}\nUse chrome_process_output for retained diagnostics.`;
  }

  private append(stream: ManagedProcessStream, value: string): void {
    for (let offset = 0; offset < value.length; offset += OUTPUT_ENTRY_CHARS) {
      const text = value.slice(offset, offset + OUTPUT_ENTRY_CHARS);
      const bytes = Buffer.byteLength(text);
      this.entries.push({ bytes, cursor: this.nextCursor, stream, text });
      this.nextCursor += 1;
      this.retainedBytes += bytes;
    }
    while (this.retainedBytes > this.capacityBytes && this.entries.length > 0) {
      const removed = this.entries.shift();
      if (!removed) break;
      this.retainedBytes -= removed.bytes;
      this.droppedBytes += removed.bytes;
    }
  }

  private flush(stream: ManagedProcessStream): void {
    const value = this.pending[stream];
    this.pending[stream] = "";
    if (value.length > 0) this.append(stream, this.redactCompleteSecrets(value));
  }

  private ingest(stream: ManagedProcessStream, value: string): void {
    let pending = this.pending[stream] + value;
    let output = "";
    while (pending.length > 0) {
      let matchIndex = Number.POSITIVE_INFINITY;
      let matchedSecret = "";
      for (const secret of this.secrets) {
        if (secret.length === 0) continue;
        const index = pending.indexOf(secret);
        if (index >= 0 && index < matchIndex) {
          matchIndex = index;
          matchedSecret = secret;
        }
      }
      if (matchedSecret.length > 0) {
        output += `${pending.slice(0, matchIndex)}[REDACTED]`;
        pending = pending.slice(matchIndex + matchedSecret.length);
        continue;
      }
      let suffixLength = 0;
      for (const secret of this.secrets) {
        const limit = Math.min(secret.length - 1, pending.length);
        for (let length = limit; length > suffixLength; length -= 1) {
          if (secret.startsWith(pending.slice(-length))) {
            suffixLength = length;
            break;
          }
        }
      }
      output += pending.slice(0, pending.length - suffixLength);
      pending = pending.slice(pending.length - suffixLength);
      break;
    }
    this.pending[stream] = pending;
    if (output.length > 0) this.append(stream, output);
  }

  private redactCompleteSecrets(value: string): string {
    let output = value;
    for (const secret of this.secrets) {
      if (secret.length > 0) output = output.replaceAll(secret, "[REDACTED]");
    }
    return output;
  }
}

export function sanitizeManagedProcessOutput(
  value: string,
  policy?: ManagedProcessOutputPolicy,
): string {
  return value.replace(URL_TOKEN, (candidate) => {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return candidate;
    }
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.username = "";
      url.password = "";
      if (policy?.isAllowed(url.origin) === true) return url.href;
      return `${url.origin}/[redacted]`;
    }
    return `${url.protocol}//[redacted]`;
  });
}

function visibleEntries(
  entries: StoredEntry[],
  policy?: ManagedProcessOutputPolicy,
): ManagedProcessOutputEntry[] {
  const grouped: ManagedProcessOutputEntry[] = [];
  for (const entry of entries) {
    const previous = grouped.at(-1);
    if (previous?.stream === entry.stream) {
      previous.text += entry.text;
    } else {
      grouped.push({ cursor: entry.cursor, stream: entry.stream, text: entry.text });
    }
  }
  return grouped.map((entry) => ({
    ...entry,
    text: sanitizeManagedProcessOutput(entry.text, policy),
  }));
}
