export type AxNode = {
  backendDOMNodeId?: number | undefined;
  childIds?: string[] | undefined;
  ignored?: boolean | undefined;
  name?: { value: unknown } | undefined;
  nodeId: string;
  role?: { value: unknown } | undefined;
  value?: { value: unknown } | undefined;
};

export type PageContext = {
  scrollY: number;
  scrollHeight: number;
  title: string;
  url: string;
  viewportHeight: number;
};

export type SnapshotOptions = {
  context?: PageContext | undefined;
  filter?: "interactive" | "all" | undefined;
};

/** Roles an agent can act on. Only these receive a ref. */
const ACTIONABLE = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

/** Roles that orient the agent without being clickable. */
const STRUCTURAL = new Set([
  "alert",
  "alertdialog",
  "article",
  "banner",
  "complementary",
  "contentinfo",
  "dialog",
  "form",
  "heading",
  "list",
  "main",
  "navigation",
  "region",
  "search",
  "status",
  "table",
]);

/**
 * Render an accessibility tree as indented text, keeping only nodes worth acting on or navigating
 * by. Dropped nodes hoist their children, so wrapper `div` chains collapse to a single line.
 */
export function renderSnapshot(
  nodes: AxNode[],
  options: SnapshotOptions = {},
): { refs: Map<string, number>; text: string } {
  const all = options.filter === "all";
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const children = new Set(nodes.flatMap((node) => node.childIds ?? []));
  const roots = nodes.filter((node) => !children.has(node.nodeId));
  const refs = new Map<string, number>();
  const lines: string[] = [];
  let index = 1;

  const walk = (node: AxNode, depth: number): void => {
    const role = text(node.role);
    const name = text(node.name);
    const value = text(node.value);
    const actionable = ACTIONABLE.has(role) && node.backendDOMNodeId !== undefined;
    const keep =
      !node.ignored &&
      (all ? Boolean(role || name || value) : actionable || STRUCTURAL.has(role) || role === "");
    // A bare-role node only earns a line when it carries text of its own.
    const show =
      keep && (all || actionable || STRUCTURAL.has(role) ? Boolean(role) : Boolean(name));

    if (show) {
      let line = `${"  ".repeat(depth)}`;
      if (actionable) {
        const ref = `e${index++}`;
        refs.set(ref, node.backendDOMNodeId as number);
        line += `[${ref}] `;
      }
      line += role || "text";
      if (name) line += ` ${JSON.stringify(name)}`;
      if (value) line += ` value=${JSON.stringify(value)}`;
      lines.push(line);
    }

    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) walk(child, show ? depth + 1 : depth);
    }
  };

  for (const root of roots) walk(root, 0);

  const header = options.context ? [describe(options.context), ""] : [];
  const body = lines.length > 0 ? lines : ["(no accessible nodes)"];
  return { refs, text: [...header, ...body].join("\n") };
}

function describe(context: PageContext): string {
  const below = context.scrollHeight - context.scrollY - context.viewportHeight;
  const position =
    context.scrollY <= 0 && below <= 1
      ? "fully visible"
      : `scrolled ${Math.round(context.scrollY)}px, ${Math.max(0, Math.round(below))}px below`;
  return `${context.url} — ${JSON.stringify(context.title)} (${position})`;
}

function text(field: { value: unknown } | undefined): string {
  return String(field?.value ?? "").trim();
}
