import assert from "node:assert/strict";
import test from "node:test";
import { JsonPathError, evaluateJsonPath, parseJsonPath } from "./jsonPath.ts";

// The document from the JSONPath write-up everyone's implementation is compared
// against, so the expectations below are the ones a reader already knows.
const store = {
  store: {
    book: [
      { category: "reference", author: "Nigel Rees", title: "Sayings of the Century", price: 8.95 },
      { category: "fiction", author: "Evelyn Waugh", title: "Sword of Honour", price: 12.99 },
      { category: "fiction", author: "Herman Melville", title: "Moby Dick", isbn: "0-553-21311-3", price: 8.99 },
      { category: "fiction", author: "J. R. R. Tolkien", title: "The Lord of the Rings", isbn: "0-395-19395-8", price: 22.99 },
    ],
    bicycle: { color: "red", price: 19.95 },
  },
  "odd-key": { "needs quoting": 1 },
};

const values = (expression: string, document: unknown = store) =>
  evaluateJsonPath(document, expression).matches.map((match) => match.value);
const paths = (expression: string, document: unknown = store) =>
  evaluateJsonPath(document, expression).matches.map((match) => match.path);

test("child, index and wildcard select what they name", () => {
  assert.deepEqual(values("$.store.bicycle.color"), ["red"]);
  assert.deepEqual(values("$.store.book[0].title"), ["Sayings of the Century"]);
  assert.deepEqual(values("$['store']['book'][1]['author']"), ["Evelyn Waugh"]);
  assert.deepEqual(values("$.store.book[-1].title"), ["The Lord of the Rings"]);
  assert.equal(values("$.store.book[*]").length, 4);
  assert.deepEqual(values("$.store.bicycle.*"), ["red", 19.95]);
});

test("a slice takes a range, clamped to the array", () => {
  assert.deepEqual(values("$.store.book[1:3].title"), ["Sword of Honour", "Moby Dick"]);
  assert.deepEqual(values("$.store.book[:2].title"), ["Sayings of the Century", "Sword of Honour"]);
  assert.deepEqual(values("$.store.book[2:].title"), ["Moby Dick", "The Lord of the Rings"]);
  assert.deepEqual(values("$.store.book[-2:].title"), ["Moby Dick", "The Lord of the Rings"]);
  assert.deepEqual(values("$.store.book[10:20]"), []);
});

test("recursive descent finds a name at any depth, in document order", () => {
  assert.deepEqual(values("$..author"), ["Nigel Rees", "Evelyn Waugh", "Herman Melville", "J. R. R. Tolkien"]);
  assert.deepEqual(values("$..price"), [8.95, 12.99, 8.99, 22.99, 19.95]);
  assert.deepEqual(values("$..isbn"), ["0-553-21311-3", "0-395-19395-8"]);
  assert.equal(values("$..[*]").length > 20, true);
});

test("a match carries a path that can be pasted back in", () => {
  assert.deepEqual(paths("$.store.book[2].isbn"), ["$.store.book[2].isbn"]);
  assert.deepEqual(paths("$..isbn"), ["$.store.book[2].isbn", "$.store.book[3].isbn"]);
  // A key that is not an identifier comes back quoted, and that form re-evaluates.
  const quoted = paths("$..['needs quoting']");
  assert.deepEqual(quoted, ["$['odd-key']['needs quoting']"]);
  assert.deepEqual(values(quoted[0]!), [1]);
});

test("a path that matches nothing is empty, not an error", () => {
  assert.deepEqual(values("$.store.magazine"), []);
  assert.deepEqual(values("$.store.book[9].title"), []);
  assert.deepEqual(values("$..nothing"), []);
  assert.deepEqual(values("$.store.bicycle.color.length"), [], "a scalar has no children");
});

test("scalars, empty containers and null are handled without throwing", () => {
  assert.deepEqual(values("$", 42), [42]);
  assert.deepEqual(values("$[*]", []), []);
  assert.deepEqual(values("$.*", {}), []);
  assert.deepEqual(values("$..a", null), []);
  assert.deepEqual(values("$.a", { a: null }), [null], "null is a value, not a miss");
});

test("unsupported syntax is refused by name, never silently empty", () => {
  // The distinction that matters: "I do not do this" reads differently from
  // "nothing matched", and a reader cannot tell them apart from an empty list.
  assert.throws(() => parseJsonPath('$.store.book[?(@.price<10)]'), (error: Error) =>
    error instanceof JsonPathError && /Filter expressions are not supported/.test(error.message));
  assert.throws(() => parseJsonPath("$.store.book[0,2]"), /Unions/);
  assert.throws(() => parseJsonPath("store.book"), /starts at the root/);
  assert.throws(() => parseJsonPath("$."), /Expected a name/);
  assert.throws(() => parseJsonPath("$.store.book[1"), /Unclosed/);
  assert.throws(() => parseJsonPath("$['unclosed"), /Unclosed/);
  assert.throws(() => parseJsonPath("$.store.book[x]"), /Expected a number/);
  assert.throws(() => parseJsonPath("   "), /Type a path/);
});

test("the result set is bounded, and says when it was capped", () => {
  const wide = { items: Array.from({ length: 500 }, (_, index) => ({ index })) };
  const capped = evaluateJsonPath(wide, "$..index", 100);
  assert.equal(capped.matches.length, 100);
  assert.equal(capped.truncated, true);
  const complete = evaluateJsonPath(wide, "$..index", 5_000);
  assert.equal(complete.matches.length, 500);
  assert.equal(complete.truncated, false);
});

test("a deeply nested document does not overflow the stack", () => {
  // Deep enough that any recursive walk fails on any engine: at 5,000 levels a
  // recursive version passed on one machine and overflowed on a CI runner.
  const depth = 100_000;
  let deep: unknown = { leaf: true };
  for (let level = 0; level < depth; level += 1) deep = { child: deep };
  const { matches } = evaluateJsonPath(deep, "$..leaf", 10);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.value, true);
  assert.equal(matches[0]!.path, "$" + ".child".repeat(depth) + ".leaf");
});

test("recursive descent returns matches in document order", () => {
  // The order a reader sees in the document, written out by hand: pre-order, siblings in turn.
  const document = { a: { id: 1, b: { id: 2 } }, c: [{ id: 3 }, { d: { id: 4 } }], id: 5 };
  const { matches } = evaluateJsonPath(document, "$..id");
  assert.deepEqual(matches.map((match) => [match.path, match.value]), [
    ["$.a.id", 1],
    ["$.a.b.id", 2],
    ["$.c[0].id", 3],
    ["$.c[1].d.id", 4],
    ["$.id", 5],
  ]);
});
