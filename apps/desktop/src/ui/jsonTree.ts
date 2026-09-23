/**
 * The tree view of a JSON result: expandable nodes, each carrying the path that
 * addresses it, bounded so a large document cannot lock the pane.
 *
 * Two properties matter more than the markup. A node is expanded **lazily**, so
 * opening a 200 MB document costs the top level and nothing more. And the render
 * is **bounded per container**: a 100,000-element array shows the first slice and
 * says how many are left, rather than building 100,000 rows and freezing the
 * window that is supposed to be showing you a result.
 */

import { JsonNumber } from "./losslessJson.ts";
import { pathSegment as segment } from "./jsonPath.ts";

export interface TreeOptions {
  /** Children rendered per container before a "show more" row. */
  pageSize?: number;
  /** Paths to mark as matches, from a query. */
  highlight?: ReadonlySet<string>;
  /** Called when a node's Copy path control is used. */
  onCopyPath?: (path: string) => void;
}

/** A JSON object: plain, from JSON.parse. Not an array, and not a kept number. */
const isObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};



/** What a value is, in one word, for the badge beside a node. */
export function describeValue(value: unknown): { type: string; summary: string; expandable: boolean } {
  if (value === null) return { type: "null", summary: "null", expandable: false };
  // The result's own digits, not the double they round to.
  if (value instanceof JsonNumber) return { type: "number", summary: value.lexeme, expandable: false };
  if (Array.isArray(value))
    return { type: "array", summary: value.length === 1 ? "1 item" : `${value.length} items`, expandable: value.length > 0 };
  if (isObject(value)) {
    const keys = Object.keys(value);
    return { type: "object", summary: keys.length === 1 ? "1 key" : `${keys.length} keys`, expandable: keys.length > 0 };
  }
  if (typeof value === "string")
    return { type: "string", summary: value.length > 80 ? `${JSON.stringify(value.slice(0, 80))}…` : JSON.stringify(value), expandable: false };
  return { type: typeof value, summary: String(value), expandable: false };
}

/** The entries of a container, as [key, value] pairs in document order. */
const entriesOf = (value: unknown): [string | number, unknown][] =>
  Array.isArray(value)
    ? value.map((item, index) => [index, item])
    : isObject(value)
      ? Object.entries(value)
      : [];

function row(key: string | number | null, value: unknown, path: string, depth: number, options: TreeOptions): HTMLElement {
  const { type, summary, expandable } = describeValue(value);
  const node = document.createElement("div");
  node.className = "tree-node";
  node.dataset.path = path;
  if (options.highlight?.has(path)) node.classList.add("tree-match");

  const line = document.createElement("div");
  line.className = "tree-line";
  line.style.paddingInlineStart = `${depth * 14}px`;

  const twisty = document.createElement("button");
  twisty.type = "button";
  twisty.className = "tree-twisty";
  twisty.textContent = expandable ? "▸" : "";
  twisty.disabled = !expandable;
  twisty.setAttribute("aria-label", expandable ? `Expand ${path}` : path);
  twisty.setAttribute("aria-expanded", "false");

  const label = document.createElement("span");
  label.className = "tree-key";
  label.textContent = key === null ? "$" : typeof key === "number" ? `${key}` : key;

  const badge = document.createElement("span");
  badge.className = `tree-type tree-type-${type}`;
  badge.textContent = type;

  const preview = document.createElement("span");
  preview.className = "tree-summary";
  preview.textContent = summary;

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "tree-copy";
  copy.textContent = "path";
  copy.title = `Copy ${path}`;
  copy.onclick = (event) => {
    event.stopPropagation();
    options.onCopyPath?.(path);
  };

  line.append(twisty, label, badge, preview, copy);
  node.append(line);

  if (!expandable) return node;

  const children = document.createElement("div");
  children.className = "tree-children";
  children.hidden = true;
  node.append(children);

  let built = false;
  const toggle = () => {
    const open = children.hidden;
    if (open && !built) {
      built = true;
      appendChildren(children, value, path, depth + 1, options);
    }
    children.hidden = !open;
    twisty.textContent = open ? "▾" : "▸";
    twisty.setAttribute("aria-expanded", String(open));
    twisty.setAttribute("aria-label", `${open ? "Collapse" : "Expand"} ${path}`);
  };
  twisty.onclick = toggle;
  line.ondblclick = toggle;
  return node;
}

function appendChildren(host: HTMLElement, value: unknown, path: string, depth: number, options: TreeOptions): void {
  const pageSize = options.pageSize ?? 200;
  const entries = entriesOf(value);
  let shown = 0;
  const more = document.createElement("button");
  more.type = "button";
  more.className = "tree-more";
  more.style.marginInlineStart = `${depth * 14}px`;

  const page = () => {
    const until = Math.min(entries.length, shown + pageSize);
    for (; shown < until; shown += 1) {
      const [key, child] = entries[shown]!;
      host.insertBefore(row(key, child, `${path}${segment(key)}`, depth, options), more);
    }
    const left = entries.length - shown;
    more.hidden = left <= 0;
    more.textContent = `Show ${Math.min(left, pageSize)} more of ${left}`;
  };
  host.append(more);
  more.onclick = page;
  page();
}

/**
 * Render `value` into `host`. Returns the number of top-level rows built, which
 * is what a caller reports; everything below is built when it is opened.
 */
export function renderJsonTree(host: HTMLElement, value: unknown, options: TreeOptions = {}): number {
  host.replaceChildren();
  const root = row(null, value, "$", 0, options);
  host.append(root);
  // Open the root so the first look shows the shape rather than one collapsed line.
  root.querySelector<HTMLButtonElement>(".tree-twisty:not([disabled])")?.click();
  return entriesOf(value).length;
}

/**
 * Render a flat list of query matches: each row is the match's path and value,
 * and the path is what the reader copies to address it again.
 */
export function renderMatches(host: HTMLElement, matches: readonly { path: string; value: unknown }[], options: TreeOptions = {}): void {
  host.replaceChildren();
  for (const match of matches) {
    const node = row(match.path, match.value, match.path, 0, { ...options, highlight: undefined });
    node.classList.add("tree-match");
    host.append(node);
  }
}
