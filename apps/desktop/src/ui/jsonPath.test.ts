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

test("AST-009: intermediate matches do not use up the result limit", () => {
  // 5,000 ids by construction; the wildcard's 5,000 intermediate objects used to exhaust
  // a shared budget, so the query reported none.
  const five = Array.from({ length: 5_000 }, (_, id) => ({ id }));
  const all = evaluateJsonPath(five, "$[*].id");
  assert.equal(all.matches.length, 5_000);
  assert.equal(all.truncated, false);
  assert.equal(all.stopped, false);
  assert.deepEqual(all.matches.slice(0, 2).map((match) => [match.path, match.value]), [["$[0].id", 0], ["$[1].id", 1]]);

  const six = Array.from({ length: 6_000 }, (_, id) => ({ id }));
  const capped = evaluateJsonPath(six, "$[*].id");
  assert.equal(capped.matches.length, 5_000, "the result cap applies to what is shown");
  assert.equal(capped.truncated, true);
  assert.equal(capped.stopped, false);
});

test("a query whose earlier steps pass the work limit says it stopped, with what it found", () => {
  // 600 x 400 = 240,000 objects: more than WORK_LIMIT (200,000) in the step before .x.
  const grid = Array.from({ length: 600 }, () => Array.from({ length: 400 }, (_, x) => ({ x })));
  const result = evaluateJsonPath(grid, "$[*][*].x");
  assert.equal(result.stopped, true);
  assert.equal(result.truncated, true);
  assert.ok(result.matches.length > 0, "the matches found before stopping are kept");
});

test("AST-010: slices follow RFC 9535, step included", () => {
  // RFC 9535 §2.3.4.3, the array slice selector examples, on the same array.
  const letters = ["a", "b", "c", "d", "e", "f", "g"];
  const values = (path: string) => evaluateJsonPath(letters, path).matches.map((match) => match.value);
  assert.deepEqual(values("$[1:3]"), ["b", "c"]);
  assert.deepEqual(values("$[5:]"), ["f", "g"]);
  assert.deepEqual(values("$[1:5:2]"), ["b", "d"]);
  assert.deepEqual(values("$[5:1:-2]"), ["f", "d"]);
  assert.deepEqual(values("$[::-1]"), ["g", "f", "e", "d", "c", "b", "a"]);
  // The review's case: a step of 2 over 0..5 selects 0, 2 and 4.
  assert.deepEqual(evaluateJsonPath([0, 1, 2, 3, 4, 5], "$[0:6:2]").matches.map((match) => match.value), [0, 2, 4]);
  assert.deepEqual(values("$[::0]"), [], "a zero step selects nothing (RFC 9535)");
});

test("AST-010: an index or slice that is not decimal whole numbers is refused, not guessed", () => {
  for (const bad of ["$[]", "$[ ]", "$[0x10]", "$[1e1]", "$[a]", "$[1:2:3:4]", "$[1.5:2]", "$[:x]"]) {
    assert.throws(() => parseJsonPath(bad), JsonPathError, bad);
  }
  assert.deepEqual(evaluateJsonPath([7, 8], "$[ 1 ]").matches.map((match) => match.value), [8]);
});

test("AST-011: a child is one of the object's own members, never inherited", () => {
  assert.equal(evaluateJsonPath({ a: 1 }, "$.toString").matches.length, 0);
  assert.equal(evaluateJsonPath({ a: 1 }, "$.__proto__").matches.length, 0);
  assert.equal(evaluateJsonPath({ a: 1 }, "$.constructor").matches.length, 0);
  // Present as real members, they are found, with the document's values.
  const own = JSON.parse('{"toString": 2, "__proto__": 3}');
  assert.deepEqual(evaluateJsonPath(own, "$.toString").matches.map((match) => match.value), [2]);
  assert.deepEqual(evaluateJsonPath(own, "$['__proto__']").matches.map((match) => match.value), [3]);
});

test("AST-012: every path the evaluator gives back selects its own node again", () => {
  const backslash = String.fromCharCode(92);
  const keys = [
    `a${backslash}b`, "a'b", `it's ${backslash} fine`, 'a"b', "", "line\nbreak", "__proto__", "plain", "with space",
    "tab\there", "cr\r\nlf", "\u0001", "\u001f", "\b\f", `${backslash}n`, "é ✓ 😀",
  ];
  const document = JSON.parse(JSON.stringify(Object.fromEntries(keys.map((key, index) => [key, index]))));
  const matches = evaluateJsonPath(document, "$.*").matches;
  assert.equal(matches.length, keys.length);
  for (const match of matches) {
    // A path is pasted into a one-line box, which drops a raw newline: none may carry one.
    assert.doesNotMatch(match.path, /[\u0000-\u001f]/, `the path ${JSON.stringify(match.path)} carries a control character`);
    const again = evaluateJsonPath(document, match.path).matches;
    assert.deepEqual(again.map((found) => found.value), [match.value], `the path ${JSON.stringify(match.path)}`);
  }
});

test("a quoted name reads JSON's escapes, as RFC 9535 §2.3.1.1 defines them", () => {
  const document = { "line\nbreak": 1, "tab\t": 2, A: 3, "\u0001": 4, "it's": 5, "a/b": 6, 'q"': 7 };
  const value = (path: string) => evaluateJsonPath(document, path).matches.map((match) => match.value);
  assert.deepEqual(value("$['line\\nbreak']"), [1]);
  assert.deepEqual(value('$["tab\\t"]'), [2]);
  assert.deepEqual(value("$['\\u0041']"), [3]);
  assert.deepEqual(value("$['\\u0001']"), [4]);
  assert.deepEqual(value("$['it\\'s']"), [5]);
  assert.deepEqual(value("$['a\\/b']"), [6]);
  assert.deepEqual(value('$["q\\""]'), [7]);
  // An escape the grammar does not define is refused, not read as the letter after it.
  assert.throws(() => parseJsonPath("$['a\\qb']"), /Unknown escape \\q/);
  assert.throws(() => parseJsonPath("$['\\u12']"), /four hex digits/);
  assert.throws(() => parseJsonPath("$['a\\"), /Unclosed/);
});
