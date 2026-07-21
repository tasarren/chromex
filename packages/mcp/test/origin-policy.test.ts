import assert from "node:assert/strict";
import { test } from "node:test";
import { isLocalOrigin, normalizeOrigin, OriginPolicy } from "../src/mcp/origin-policy.js";

test("normalizes to exact web origins", () => {
  assert.equal(normalizeOrigin("https://example.com/a?b=1"), "https://example.com");
  assert.equal(normalizeOrigin("https://example.com:8443/a"), "https://example.com:8443");
  assert.equal(normalizeOrigin("about:blank"), "about:blank");
  assert.throws(() => normalizeOrigin("file:///tmp/a"), /HTTP/);
});

test("only loopback origins are implicitly local", () => {
  assert.equal(isLocalOrigin("http://localhost:3000"), true);
  assert.equal(isLocalOrigin("http://127.0.0.1:8080"), true);
  assert.equal(isLocalOrigin("http://[::1]:8080"), true);
  assert.equal(isLocalOrigin("https://example.com"), false);
});

test("unsupported browser pages are denied instead of breaking tab listing", () => {
  const policy = new OriginPolicy();
  assert.equal(policy.isAllowed("chrome://newtab/"), false);
  assert.equal(policy.isAllowed("file:///tmp/private"), false);
});
