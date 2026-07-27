import assert from "node:assert/strict";
import { test } from "node:test";
import { PageActivity } from "../src/mcp/buffers.js";

function request(activity: PageActivity, id: string, url: string, at = 0): void {
  activity.record(
    "Network.requestWillBeSent",
    { request: { method: "GET", url }, requestId: id },
    at,
  );
}

test("console entries capture level, text, and source frame", () => {
  const activity = new PageActivity();
  activity.record(
    "Runtime.consoleAPICalled",
    {
      args: [
        { type: "string", value: "hello" },
        { type: "number", value: 42 },
      ],
      stackTrace: { callFrames: [{ lineNumber: 12, url: "https://example.com/app.js" }] },
      type: "warning",
    },
    1000,
  );
  assert.deepEqual(activity.console("all"), [
    {
      level: "warning",
      line: 12,
      source: "https://example.com/app.js",
      text: "hello 42",
      ts: 1000,
    },
  ]);
});

test("object arguments are described, not walked", () => {
  const activity = new PageActivity();
  activity.record(
    "Runtime.consoleAPICalled",
    {
      args: [{ className: "HTMLDivElement", description: "div#root", type: "object" }],
      type: "log",
    },
    0,
  );
  assert.equal(activity.console("all")[0]?.text, "div#root");
});

test("exceptions and log entries land in the console buffer", () => {
  const activity = new PageActivity();
  activity.record(
    "Runtime.exceptionThrown",
    {
      exceptionDetails: {
        exception: { description: "TypeError: x is not a function" },
        lineNumber: 3,
        url: "https://example.com/a.js",
      },
    },
    0,
  );
  activity.record("Log.entryAdded", { entry: { level: "error", text: "CSP violation" } }, 0);
  assert.deepEqual(
    activity.console("error").map((entry) => entry.text),
    ["TypeError: x is not a function", "CSP violation"],
  );
});

test("console level filters narrow the buffer", () => {
  const activity = new PageActivity();
  for (const type of ["log", "warning", "error"])
    activity.record("Runtime.consoleAPICalled", { args: [{ value: type }], type }, 0);
  assert.deepEqual(activity.console("all").length, 3);
  assert.deepEqual(
    activity.console("warn").map((entry) => entry.level),
    ["warning", "error"],
  );
  assert.deepEqual(
    activity.console("error").map((entry) => entry.level),
    ["error"],
  );
});

test("responses correlate to their request by id", () => {
  const activity = new PageActivity();
  request(activity, "r1", "https://example.com/api", 100);
  activity.record(
    "Network.responseReceived",
    { requestId: "r1", response: { status: 404 }, type: "XHR" },
    350,
  );
  assert.deepEqual(activity.network("all"), [
    { method: "GET", ms: 250, status: 404, type: "XHR", url: "https://example.com/api" },
  ]);
});

test("a failed request is kept without a response", () => {
  const activity = new PageActivity();
  request(activity, "r1", "https://example.com/gone", 0);
  activity.record("Network.loadingFailed", { errorText: "net::ERR_FAILED", requestId: "r1" }, 50);
  const [entry] = activity.network("failed");
  assert.equal(entry?.failure, "net::ERR_FAILED");
  assert.equal(entry?.status, undefined);
});

test("the failed filter hides successful requests", () => {
  const activity = new PageActivity();
  request(activity, "ok", "https://example.com/ok");
  activity.record("Network.responseReceived", { requestId: "ok", response: { status: 200 } }, 0);
  request(activity, "bad", "https://example.com/bad");
  activity.record("Network.responseReceived", { requestId: "bad", response: { status: 500 } }, 0);
  assert.deepEqual(
    activity.network("failed").map((entry) => entry.url),
    ["https://example.com/bad"],
  );
  assert.equal(activity.network("all").length, 2);
});

test("buffers evict oldest entries at capacity", () => {
  const activity = new PageActivity();
  for (let index = 0; index < 250; index++) {
    activity.record("Runtime.consoleAPICalled", { args: [{ value: `m${index}` }], type: "log" }, 0);
    request(activity, `r${index}`, `https://example.com/${index}`);
  }
  const entries = activity.console("all");
  assert.equal(entries.length, 200);
  assert.equal(entries[0]?.text, "m50");
  const network = activity.network("all");
  assert.equal(network.length, 200);
  assert.equal(network[0]?.url, "https://example.com/50");
});

test("clear empties both buffers", () => {
  const activity = new PageActivity();
  activity.record("Runtime.consoleAPICalled", { args: [{ value: "x" }], type: "log" }, 0);
  request(activity, "r1", "https://example.com/");
  activity.clear();
  assert.deepEqual(activity.console("all"), []);
  assert.deepEqual(activity.network("all"), []);
});

test("unknown events and unmatched responses are ignored", () => {
  const activity = new PageActivity();
  activity.record("Page.frameNavigated", { frame: {} }, 0);
  activity.record(
    "Network.responseReceived",
    { requestId: "missing", response: { status: 200 } },
    0,
  );
  assert.deepEqual(activity.network("all"), []);
  assert.deepEqual(activity.console("all"), []);
});
