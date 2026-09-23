import assert from "node:assert/strict";
import test, { before } from "node:test";
import { describeValue } from "./jsonTree.ts";

// describeValue is the part of the tree that decides what a reader sees beside a
// node, and it is pure: the DOM half is exercised by the rendered UI suite and by
// the native suite, which drive a real window.
test("a node says what it is and how big it is", () => {
  assert.deepEqual(describeValue({ a: 1, b: 2 }), { type: "object", summary: "2 keys", expandable: true });
  assert.deepEqual(describeValue({ a: 1 }), { type: "object", summary: "1 key", expandable: true });
  assert.deepEqual(describeValue([1, 2, 3]), { type: "array", summary: "3 items", expandable: true });
  assert.deepEqual(describeValue([1]), { type: "array", summary: "1 item", expandable: true });
  // An empty container has nothing to open, so it must not offer a twisty.
  assert.deepEqual(describeValue({}), { type: "object", summary: "0 keys", expandable: false });
  assert.deepEqual(describeValue([]), { type: "array", summary: "0 items", expandable: false });
});

test("scalars keep their type, and null is its own", () => {
  assert.deepEqual(describeValue(null), { type: "null", summary: "null", expandable: false });
  assert.deepEqual(describeValue(42), { type: "number", summary: "42", expandable: false });
  assert.deepEqual(describeValue(true), { type: "boolean", summary: "true", expandable: false });
  assert.deepEqual(describeValue("hi"), { type: "string", summary: '"hi"', expandable: false });
});

test("a long string is shortened for the line but keeps its quotes", () => {
  const long = "x".repeat(500);
  const { summary, type } = describeValue(long);
  assert.equal(type, "string");
  assert.ok(summary.length < 100, `summary should be short, got ${summary.length} characters`);
  assert.ok(summary.startsWith('"xxx'), summary.slice(0, 10));
  assert.ok(summary.endsWith("…"), "a shortened value has to say it was shortened");
});

test("a string is shown escaped, so a newline cannot break the row", () => {
  assert.equal(describeValue('a\nb\t"c"').summary, JSON.stringify('a\nb\t"c"'));
});
