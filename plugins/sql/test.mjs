import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorCancelled, ProcessorContext, SeededRandom, defaultLimits } from "../../packages/plugin-sdk/src/index.ts";
import { execute } from "./processor.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
const operation = (id) => manifest.operations.find((item) => item.id === id);
const manifestLimits = (operationId) => Object.fromEntries(Object.entries(operation(operationId).limits).map(([key, value]) => [key, Number(value)]));

function makeContext(input, { limits, cancellation = new CancellationToken() } = {}) {
  const reader = new MemoryReader().insert("input", encoder.encode(input));
  const source = reader.inputs.get("input").slice();
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(reader, outputs, cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), limits);
  return { reader, source, outputs, context };
}

async function run(operationId, options, input, settings) {
  const { reader, source, outputs, context } = makeContext(input, settings);
  const returned = await execute({ operationId, options }, context);
  assert.deepEqual(reader.inputs.get("input"), source, "source bytes must remain immutable");
  const bytes = outputs.bytes.get("output");
  const value = outputs.values.get("output");
  assert.equal(returned, value, "execute returns the emitted structured value");
  return { text: decoder.decode(bytes), value, artifact: outputs.artifacts.get("output") };
}

async function rejects(operationId, options, input, expected, settings) {
  const { outputs, context } = makeContext(input, settings);
  await assert.rejects(() => execute({ operationId, options }, context), expected);
  assert.equal(outputs.bytes.size, 0, "a failed run writes no artifact");
  assert.equal(outputs.values.size, 0, "a failed run writes no value");
}

for (const vector of await fixture("beautify")) {
  test(`beautify fixture: ${vector.name}`, async () => {
    const result = await run("beautify", vector.options, vector.input);
    assert.equal(result.text, vector.output);

    // Idempotency check: beautify -> minify -> beautify == beautify
    const minified = await run("minify", vector.options, result.text);
    const reBeautified = await run("beautify", vector.options, minified.text);
    assert.equal(reBeautified.text, vector.output, "re-beautified minified text must be identical to original beautified text");
  });
}

for (const vector of await fixture("minify")) {
  test(`minify fixture: ${vector.name}`, async () => {
    const result = await run("minify", vector.options, vector.input);
    assert.equal(result.text, vector.output);
  });
}

for (const vector of await fixture("invalid")) {
  test(`invalid fixture: ${vector.name}`, async () => {
    await rejects(vector.operationId, vector.options, vector.input, (error) => {
      assert.ok(error instanceof Error && !(error instanceof ProcessorCancelled));
      assert.ok(error.message.includes(vector.error), `expected "${error.message}" to include "${vector.error}"`);
      return true;
    });
  });
}

test("a cancelled token rejects both operations before any output, even for an empty document", async () => {
  for (const operationId of ["sql.beautify", "sql.minify"]) for (const input of ["SELECT 1", ""]) {
    const cancellation = new CancellationToken();
    cancellation.cancel();
    await rejects(operationId, {}, input, ProcessorCancelled, { cancellation });
  }
});
