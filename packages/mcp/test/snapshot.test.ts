import assert from "node:assert/strict";
import { test } from "node:test";
import { type AxNode, renderSnapshot } from "../src/mcp/snapshot.js";

function node(
  nodeId: string,
  role: string,
  extra: Partial<AxNode> & { name?: { value: unknown } } = {},
): AxNode {
  return { nodeId, role: { value: role }, ...extra };
}

/** A heading and a button, each buried under a chain of generic wrappers. */
const tree: AxNode[] = [
  node("1", "RootWebArea", { childIds: ["2", "5"], name: { value: "Test page" } }),
  node("2", "generic", { childIds: ["3"] }),
  node("3", "generic", { childIds: ["4"] }),
  node("4", "heading", { name: { value: "Welcome" } }),
  node("5", "generic", { childIds: ["6", "7", "8"] }),
  node("6", "button", { backendDOMNodeId: 42, name: { value: "Submit" } }),
  node("7", "generic", { ignored: true, name: { value: "hidden" } }),
  node("8", "textbox", {
    backendDOMNodeId: 43,
    name: { value: "Email" },
    value: { value: "a@b.co" },
  }),
];

test("wrapper chains collapse and children hoist to the kept parent", () => {
  const { text } = renderSnapshot(tree);
  assert.equal(
    text,
    ['heading "Welcome"', '[e1] button "Submit"', '[e2] textbox "Email" value="a@b.co"'].join("\n"),
  );
});

test("refs are assigned only to actionable nodes", () => {
  const { refs } = renderSnapshot(tree);
  assert.deepEqual(
    [...refs],
    [
      ["e1", 42],
      ["e2", 43],
    ],
  );
});

test("ignored nodes are dropped", () => {
  assert.ok(!renderSnapshot(tree).text.includes("hidden"));
});

test("filter 'all' keeps generic nodes and nests them", () => {
  const { text } = renderSnapshot(tree, { filter: "all" });
  assert.ok(text.includes("RootWebArea"));
  assert.ok(text.includes("  generic"));
  assert.ok(text.includes('    heading "Welcome"'));
});

test("the header reports url, title, and remaining scroll", () => {
  const context = {
    scrollHeight: 2000,
    scrollY: 100,
    title: "Test page",
    url: "https://example.com/",
    viewportHeight: 800,
  };
  const { text } = renderSnapshot(tree, { context });
  assert.equal(
    text.split("\n")[0],
    'https://example.com/ — "Test page" (scrolled 100px, 1100px below)',
  );
  assert.equal(
    renderSnapshot(tree, { context: { ...context, scrollHeight: 800, scrollY: 0 } }).text.split(
      "\n",
    )[0],
    'https://example.com/ — "Test page" (fully visible)',
  );
});

test("an empty tree reports no accessible nodes", () => {
  assert.equal(renderSnapshot([]).text, "(no accessible nodes)");
});
