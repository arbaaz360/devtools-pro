import assert from "node:assert/strict";
import test from "node:test";
import { JsonNumber, parseJsonLossless } from "./losslessJson.ts";
import { evaluateJsonPath } from "./jsonPath.ts";
import { describeValue } from "./jsonTree.ts";

// The oracle is the input text: each number's own digits, as written.
const text = '{"id":9007199254740993,"overflow":1e400,"price":1.50,"zero":-0,"plain":42,"list":[1,2.5]}';

test("AST-008: a number a double would change keeps its text", () => {
  const value = parseJsonLossless(text) as Record<string, unknown>;
  for (const [key, lexeme] of [["id", "9007199254740993"], ["overflow", "1e400"], ["price", "1.50"], ["zero", "-0"]] as const) {
    assert.ok(value[key] instanceof JsonNumber, key);
    assert.equal((value[key] as JsonNumber).lexeme, lexeme);
  }
  // Numbers a double prints exactly as written stay plain numbers.
  assert.equal(value.plain, 42);
  assert.deepEqual(value.list, [1, 2.5]);
});

test("a lossless parse writes back out as the same text", () => {
  assert.equal(JSON.stringify(parseJsonLossless(text)), text);
});

test("the tree and a path query show the digits, not the double", () => {
  const value = parseJsonLossless(text);
  const [match] = evaluateJsonPath(value, "$.id").matches;
  assert.equal(describeValue(match!.value).summary, "9007199254740993");
  assert.equal(describeValue(match!.value).type, "number");
  assert.equal(describeValue((value as Record<string, unknown>).overflow).summary, "1e400");
  // A kept number is a leaf, not a container to walk into.
  assert.equal(evaluateJsonPath(value, "$.id.*").matches.length, 0);
  assert.equal(describeValue(match!.value).expandable, false);
});
