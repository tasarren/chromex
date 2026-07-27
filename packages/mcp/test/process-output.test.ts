import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import {
  ManagedProcessOutputCapture,
  sanitizeManagedProcessOutput,
} from "../src/mcp/process-output.js";

test("managed process output captures stdout, stderr, and termination metadata", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      'process.stdout.write("stdout line\\n"); process.stderr.write("stderr line\\n"); process.exit(23);',
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const capture = new ManagedProcessOutputCapture(process.execPath, ["fixture"], []);
  capture.attach(child);
  await once(child, "close");

  const result = capture.read({ maxChars: 20_000, stream: "all" });
  assert.equal(result.process.exitCode, 23);
  assert.equal(result.process.state, "exited");
  assert.equal(result.process.signal, null);
  assert.equal(
    result.output.entries
      .filter((entry) => entry.stream === "stdout")
      .map((entry) => entry.text)
      .join(""),
    "stdout line\n",
  );
  assert.equal(
    result.output.entries
      .filter((entry) => entry.stream === "stderr")
      .map((entry) => entry.text)
      .join(""),
    "stderr line\n",
  );
  assert.match(capture.failureMessage("launch failed"), /exit code 23/);
  assert.match(capture.failureMessage("launch failed"), /stderr line/);
});

test("managed process output redacts bridge secrets and origin-gates URLs", async () => {
  const secret = "0".repeat(64);
  const child = spawn(
    process.execPath,
    [
      "-e",
      `process.stderr.write(${JSON.stringify(secret.slice(0, 17))}); setTimeout(() => process.stderr.write(${JSON.stringify(
        `${secret.slice(17)} ${"x".repeat(235)} https://allowed.test/path?q=visible https://blocked.test/private?q=secret file:///home/user/private\n`,
      )}), 10);`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const capture = new ManagedProcessOutputCapture(process.execPath, [], [secret]);
  capture.attach(child);
  await once(child, "close");

  const result = capture.read(
    { maxChars: 20_000, stream: "stderr" },
    { isAllowed: (value) => value === "https://allowed.test" },
  );
  const output = result.output.entries.map((entry) => entry.text).join("");
  assert.doesNotMatch(output, new RegExp(secret));
  assert.match(output, /\[REDACTED\]/);
  assert.match(output, /https:\/\/allowed\.test\/path\?q=visible/);
  assert.match(output, /https:\/\/blocked\.test\/\[redacted\]/);
  assert.match(output, /file:\/\/\[redacted\]/);
});

test("managed process output is bounded and pages backward by cursor", async () => {
  const child = spawn(
    process.execPath,
    ["-e", `process.stdout.write(${JSON.stringify("x".repeat(2_000))});`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const capture = new ManagedProcessOutputCapture(process.execPath, [], [], 800);
  capture.attach(child);
  await once(child, "close");

  const newest = capture.read({ maxChars: 500, stream: "stdout" });
  assert.equal(newest.output.truncatedBefore, true);
  assert.ok(newest.output.droppedBytes > 0);
  assert.ok(newest.output.retainedBytes <= 800);
  assert.ok(newest.output.olderCursor);

  const older = capture.read({
    cursor: newest.output.olderCursor ?? undefined,
    maxChars: 500,
    stream: "stdout",
  });
  assert.ok(older.output.entries.length > 0);
  assert.ok(
    (older.output.entries.at(-1)?.cursor ?? Number.POSITIVE_INFINITY) <
      (newest.output.entries[0]?.cursor ?? 0),
  );
});

test("managed process URL sanitization defaults to origin-only output", () => {
  assert.equal(
    sanitizeManagedProcessOutput("failed at https://example.test/a?token=secret"),
    "failed at https://example.test/[redacted]",
  );
});
