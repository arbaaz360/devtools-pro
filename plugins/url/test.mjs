import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorCancelled, ProcessorContext, SeededRandom } from "../../packages/plugin-sdk/src/index.ts";
import { execute } from "./processor.mjs";

async function run(operationId, options, input, limits) {
  const reader = new MemoryReader().insert("input", input);
  const source = reader.inputs.get("input").slice();
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(reader, outputs, new CancellationToken(), new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), limits);
  await execute({ operationId, options }, context);
  assert.deepEqual(reader.inputs.get("input"), source, "source bytes must remain immutable");
  return { text: new TextDecoder().decode(outputs.bytes.get("output")), value: outputs.values.get("output") };
}

const vectors = JSON.parse(await readFile(new URL("./fixtures/vectors.json", import.meta.url), "utf8"));
for (const vector of vectors) test(vector.name, async () => assert.equal((await run(vector.operationId, vector.options, vector.input)).text, vector.output));
test("decoding is mode-specific and never double-decodes", async () => {
  assert.equal((await run("url.transform", { mode: "decode", encoding: "rfc3986" }, "a+b%2520c")).text, "a+b%20c");
  assert.equal((await run("url.transform", { mode: "decode", encoding: "form" }, "a+b%2Bc")).text, "a b+c");
});
test("parser preserves encoded delimiters, blank values and literal nested brackets", async () => {
  const result = await run("url.parse-query", { indent: 2 }, "one=x%26y&blank&obj[a]=1");
  assert.deepEqual(result.value.parameters, { one: "x&y", blank: "", "obj[a]": "1" });
});
test("malformed escapes and invalid UTF-8 fail", async () => {
  await assert.rejects(() => run("url.transform", { mode: "decode" }, "%G0"), /two hexadecimal digits/);
  await assert.rejects(() => run("url.parse-query", {}, "a=%E2%28"), /not valid UTF-8/);
});
test("limits and cancellation are enforced", async () => {
  const limits = { maxInputBytes: 3, maxOutputBytes: 10, maxChunkBytes: 10, deadlineMs: 0 };
  await assert.rejects(() => run("url.transform", { mode: "encode" }, "four", limits), /exceeds/);
  const token = new CancellationToken(); token.cancel();
  const context = new ProcessorContext(new MemoryReader().insert("input", "x"), new MemoryOutputSink(), token, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets());
  await assert.rejects(() => execute({ operationId: "url.transform", options: {} }, context), ProcessorCancelled);
});
