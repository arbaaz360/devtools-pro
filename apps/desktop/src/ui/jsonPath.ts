/**
 * A small JSONPath evaluator for querying a result in the tree view.
 *
 * It implements the part of the syntax people actually type at a result pane —
 * root, child, index, wildcard, recursive descent and slices — and refuses the
 * rest with a message naming what it does support. That refusal is the point: a
 * query language that silently returns nothing for syntax it does not implement
 * is indistinguishable from a query that legitimately matched nothing, and the
 * reader cannot tell which they are looking at.
 *
 * Supported:
 *   $                 the whole result
 *   .name  ['name']   a child, by name
 *   [0] [-1]          an element, counting from the end when negative
 *   [1:4] [:2] [::2] [::-1]   a slice, with an optional step (RFC 9535 semantics)
 *   [*]  .*           every child of an object or array
 *   ..name  ..[*]     recursive descent
 *
 * Not supported, and reported rather than ignored: filter expressions
 * (`[?(@.x=="y")]`), unions (`[0,2]`), script expressions and functions.
 */

export interface PathMatch {
  /** Canonical path to the match, e.g. `$.store.book[0].title`. */
  path: string;
  value: unknown;
}

export class JsonPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonPathError";
  }
}

type Step =
  | { kind: "child"; name: string }
  | { kind: "index"; index: number }
  | { kind: "slice"; from: number | null; to: number | null; step: number }
  | { kind: "wildcard" }
  | { kind: "descend"; name: string | null };

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*/;
/** A key that can be written as `.name`; anything else is emitted in brackets. */
const PLAIN_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** A decimal integer as an index or slice bound: no hex, no exponent, no blank. */
const INTEGER = /^-?\d+$/;
/** Values the steps before the last may produce before a query stops early. */
export const WORK_LIMIT = 200_000;

/** Parse an expression into steps, or throw with what went wrong and where. */
export function parseJsonPath(expression: string): Step[] {
  const source = expression.trim();
  if (!source) throw new JsonPathError("Type a path, for example $.store or $..title");
  if (source[0] !== "$") throw new JsonPathError("A path starts at the root: $");
  const steps: Step[] = [];
  let at = 1;
  let pendingDescent = false;

  const readQuoted = (quote: string): string => {
    let name = "";
    at += 1;
    while (at < source.length && source[at] !== quote) {
      if (source[at] === "\\" && at + 1 < source.length) at += 1;
      name += source[at];
      at += 1;
    }
    if (at >= source.length) throw new JsonPathError(`Unclosed ${quote} in the path`);
    at += 1;
    return name;
  };

  while (at < source.length) {
    if (source.startsWith("..", at)) {
      at += 2;
      if (source[at] === "[") { pendingDescent = true; continue; }
      if (source[at] === "*") { at += 1; steps.push({ kind: "descend", name: null }); continue; }
      const name = IDENTIFIER.exec(source.slice(at))?.[0];
      if (!name) throw new JsonPathError("Recursive descent needs a name: ..title, or ..[*]");
      at += name.length;
      steps.push({ kind: "descend", name });
      continue;
    }
    if (source[at] === ".") {
      at += 1;
      if (source[at] === "*") { at += 1; steps.push({ kind: "wildcard" }); continue; }
      const name = IDENTIFIER.exec(source.slice(at))?.[0];
      if (!name) throw new JsonPathError(`Expected a name after "." at position ${at}`);
      at += name.length;
      steps.push({ kind: "child", name });
      continue;
    }
    if (source[at] === "[") {
      at += 1;
      if (source[at] === "?") throw new JsonPathError("Filter expressions are not supported; use $..name to find a field anywhere");
      if (source[at] === "*") {
        at += 1;
        if (source[at] !== "]") throw new JsonPathError("Expected ] after [*");
        at += 1;
        steps.push(pendingDescent ? { kind: "descend", name: null } : { kind: "wildcard" });
        pendingDescent = false;
        continue;
      }
      if (source[at] === "'" || source[at] === '"') {
        const name = readQuoted(source[at]!);
        if (source[at] !== "]") throw new JsonPathError("Expected ] after a quoted name");
        at += 1;
        steps.push(pendingDescent ? { kind: "descend", name } : { kind: "child", name });
        pendingDescent = false;
        continue;
      }
      if (pendingDescent) throw new JsonPathError("After .. use a name or [*]: $..title or $..[*]");
      const close = source.indexOf("]", at);
      if (close === -1) throw new JsonPathError("Unclosed [ in the path");
      const body = source.slice(at, close);
      at = close + 1;
      if (body.includes(",")) throw new JsonPathError("Unions like [0,2] are not supported");
      // Check the whole bracket against the grammar before converting any of it:
      // Number("") is 0 and Number("0x10") is 16, so a lenient conversion turns a
      // typo into a different, valid-looking query.
      if (body.includes(":")) {
        const parts = body.split(":").map((part) => part.trim());
        if (parts.length > 3 || parts.some((part) => part !== "" && !INTEGER.test(part)))
          throw new JsonPathError(`A slice is [start:end:step], each a whole number or empty: [${body}]`);
        const [from = "", to = "", step = ""] = parts;
        steps.push({
          kind: "slice",
          from: from === "" ? null : Number(from),
          to: to === "" ? null : Number(to),
          step: step === "" ? 1 : Number(step),
        });
        continue;
      }
      if (!INTEGER.test(body.trim())) throw new JsonPathError(`Expected a number, a slice or * inside [ ]: [${body}]`);
      steps.push({ kind: "index", index: Number(body.trim()) });
      continue;
    }
    throw new JsonPathError(`Unexpected "${source[at]}" at position ${at}`);
  }
  return steps;
}

/** A JSON object: plain, from JSON.parse. Not an array, and not a kept number. */
const isObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * A path segment as it is written, so a reader can paste the result back in. The
 * parser treats a backslash in quotes as an escape, so both it and the quote are
 * escaped here; otherwise a key containing `\\` would not select itself again.
 */
const segment = (key: string | number): string =>
  typeof key === "number"
    ? `[${key}]`
    : PLAIN_NAME.test(key)
      ? `.${key}`
      : `['${key.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`;

/** The indices an RFC 9535 slice selects, in selection order. */
function sliceIndices(size: number, from: number | null, to: number | null, step: number): number[] {
  if (step === 0) return [];
  const normalize = (index: number) => (index >= 0 ? index : size + index);
  const start = from ?? (step > 0 ? 0 : size - 1);
  const end = to ?? (step > 0 ? size : -size - 1);
  const indices: number[] = [];
  if (step > 0) {
    const lower = Math.min(Math.max(normalize(start), 0), size);
    const upper = Math.min(Math.max(normalize(end), 0), size);
    for (let index = lower; index < upper; index += step) indices.push(index);
  } else {
    const upper = Math.min(Math.max(normalize(start), -1), size - 1);
    const lower = Math.min(Math.max(normalize(end), -1), size - 1);
    for (let index = upper; lower < index; index += step) indices.push(index);
  }
  return indices;
}

/**
 * Every descendant of `match`, in document order, that `name` selects (or all of
 * them for `..*`). Iterative, with its own stack: the depth of a document is the
 * document's choice, and a recursive walk would fail on a deep one at whatever depth
 * the engine's native stack happens to run out — which differs by machine and JIT
 * tier, so a test at one depth can pass on one runner and fail on the next.
 */
function descend(match: PathMatch, name: string | null, into: PathMatch[], budget: { left: number }): void {
  type Pending = { path: string; value: unknown; key: string | number };
  const pending: Pending[] = [];
  // Children go on in reverse so they come off in order: a pre-order walk, the
  // same order the recursive version produced.
  const pushChildren = (path: string, value: unknown): void => {
    const entries: [string | number, unknown][] = Array.isArray(value)
      ? value.map((item, index) => [index, item])
      : isObject(value)
        ? Object.entries(value)
        : [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index]!;
      pending.push({ path: `${path}${segment(key)}`, value: child, key });
    }
  };
  pushChildren(match.path, match.value);
  while (pending.length && budget.left > 0) {
    const node = pending.pop()!;
    if (name === null || node.key === name) {
      into.push({ path: node.path, value: node.value });
      budget.left -= 1;
    }
    pushChildren(node.path, node.value);
  }
}

/**
 * Evaluate a parsed path. Two bounds, kept apart. `limit` caps the matches the pane
 * is handed; `truncated` says there were more. `WORK_LIMIT` caps what the steps
 * before the last may produce, so a query over a huge result cannot lock the pane;
 * `stopped` says it was reached and the matches are only those found so far.
 *
 * One shared budget used to serve both, so the intermediate matches of `$[*]` over
 * 5,000 objects used it all and `$[*].id` reported no matches at all.
 */
export function evaluateJsonPath(
  value: unknown,
  expression: string,
  limit = 5_000,
): { matches: PathMatch[]; truncated: boolean; stopped: boolean } {
  const steps = parseJsonPath(expression);
  let current: PathMatch[] = [{ path: "$", value }];
  let truncated = false;
  let stopped = false;
  for (const [position, step] of steps.entries()) {
    const last = position === steps.length - 1;
    // The last step collects one more than it keeps, to know whether there were more.
    const budget = { left: last ? limit + 1 : WORK_LIMIT };
    const next: PathMatch[] = [];
    for (const match of current) {
      if (budget.left <= 0) break;
      switch (step.kind) {
        case "child": {
          if (isObject(match.value) && Object.hasOwn(match.value, step.name)) {
            next.push({ path: `${match.path}${segment(step.name)}`, value: match.value[step.name] });
            budget.left -= 1;
          }
          break;
        }
        case "index": {
          if (Array.isArray(match.value)) {
            const index = step.index < 0 ? match.value.length + step.index : step.index;
            if (index >= 0 && index < match.value.length) {
              next.push({ path: `${match.path}[${index}]`, value: match.value[index] });
              budget.left -= 1;
            }
          }
          break;
        }
        case "slice": {
          if (Array.isArray(match.value)) {
            for (const index of sliceIndices(match.value.length, step.from, step.to, step.step)) {
              if (budget.left <= 0) break;
              next.push({ path: `${match.path}[${index}]`, value: match.value[index] });
              budget.left -= 1;
            }
          }
          break;
        }
        case "wildcard": {
          const entries: [string | number, unknown][] = Array.isArray(match.value)
            ? match.value.map((item, index) => [index, item])
            : isObject(match.value)
              ? Object.entries(match.value)
              : [];
          for (const [key, child] of entries) {
            if (budget.left <= 0) break;
            next.push({ path: `${match.path}${segment(key)}`, value: child });
            budget.left -= 1;
          }
          break;
        }
        case "descend": {
          descend(match, step.name, next, budget);
          break;
        }
      }
    }
    if (budget.left <= 0) {
      if (last) truncated = true;
      else stopped = true;
    }
    current = last ? next.slice(0, limit) : next;
    if (!current.length) break;
  }
  return { matches: current, truncated: truncated || stopped, stopped };
}
