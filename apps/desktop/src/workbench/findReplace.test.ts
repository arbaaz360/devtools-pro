import test from "node:test";
import assert from "node:assert/strict";
import {
  findMatches,
  nextMatch,
  replaceAll,
  replaceOne,
  MAX_FIND_MATCHES,
} from "./findReplace.ts";

test("finds literal text across lines and preserves UTF-16 offsets", () => {
  const text = "one\ntwo\n東京 two";
  assert.deepEqual(findMatches(text, "two").matches, [
    { start: 4, end: 7 },
    { start: 11, end: 14 },
  ]);
  assert.deepEqual(findMatches("café CAFÉ", "é", { caseSensitive: false }).matches, [
    { start: 3, end: 4 },
    { start: 8, end: 9 },
  ]);
});

test("whole word matching uses Unicode word characters", () => {
  assert.deepEqual(findMatches("cat scatter 猫", "cat", { wholeWord: true }).matches, [
    { start: 0, end: 3 },
  ]);
  assert.deepEqual(findMatches("a_foo foo-bar", "foo", { wholeWord: true }).matches, [
    { start: 6, end: 9 },
  ]);
});

test("find results are bounded and report truncation", () => {
  const result = findMatches("x ".repeat(MAX_FIND_MATCHES + 2), "x");
  assert.equal(result.matches.length, MAX_FIND_MATCHES);
  assert.equal(result.truncated, true);
});

test("next match wraps in both directions", () => {
  const matches = [{ start: 1, end: 2 }, { start: 5, end: 6 }];
  assert.deepEqual(nextMatch(matches, 2, 2, "forward"), matches[1]);
  assert.deepEqual(nextMatch(matches, 6, 6, "forward"), matches[0]);
  assert.deepEqual(nextMatch(matches, 5, 5, "backward"), matches[0]);
  assert.deepEqual(nextMatch(matches, 1, 1, "backward"), matches[1]);
  assert.equal(nextMatch([], 0, 0), null);
});

test("empty query is a no-op and replacement treats dollar signs literally", () => {
  assert.deepEqual(findMatches("abc", ""), { matches: [], truncated: false });
  assert.deepEqual(replaceAll("a a", "a", "$&-$1-$", { caseSensitive: true }), {
    text: "$&-$1-$ $&-$1-$",
    count: 2,
  });
  assert.equal(replaceOne("hello", { start: 0, end: 5 }, "$1"), "$1");
  assert.deepEqual(replaceAll("A a", "a", "x", { caseSensitive: false }), {
    text: "x x",
    count: 2,
  });
});
