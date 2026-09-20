import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorContext, SeededRandom } from "../../packages/plugin-sdk/src/context.ts";
import { execute, ExampleStringsError } from "./processor.mjs";

const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
const operation = manifest.operations[0];
const deterministic = JSON.parse(await readFile(new URL("./fixtures/deterministic.json", import.meta.url), "utf8"));

const text = bytes => new TextDecoder().decode(bytes);

function harness(options, { seed = 42, cancellation = new CancellationToken(), limits, input } = {}) {
  const outputs = new MemoryOutputSink();
  const reader = new MemoryReader();
  if (input !== undefined && input !== null) reader.insert("input", new TextEncoder().encode(input));

  const context = new ProcessorContext(reader, outputs, cancellation, new FixedClock("2024-01-01T00:00:00Z"), new SeededRandom(seed), new MemorySecrets(), limits || {maxOutputBytes: 1048576});
  const request = { pluginId: manifest.id, toolId: manifest.tools[0].id, operationId: operation.id, options };
  return { outputs, reader, execute: () => execute(request, context) };
}

async function run(options, env) {
  const h = harness(options, env);
  const before = h.reader.inputs.get("input") ? h.reader.inputs.get("input").slice() : null;
  const result = await h.execute();
  if (before) assert.deepEqual(h.reader.inputs.get("input"), before, "source bytes must be untouched");
  const value = h.outputs.values.get("output");
  assert.deepEqual(result, value, "execute returns the value written to the output port");
  const outputText = text(h.outputs.bytes.get("output"));
  assert.equal(outputText, result.items.join("\n") + "\n", "text artifact is items joined by newline plus trailing newline");
  return { ...h, value, text: outputText };
}

async function rejects(options, env, expected) {
  const h = harness(options, env);
  await assert.rejects(h.execute, (err) => {
    if (expected instanceof RegExp) {
      return expected.test(err.message) || expected.test(err.code);
    }
    return err.code === expected;
  });
  assert.equal(h.outputs.bytes.size, 0, "rejected runs write no text artifact");
  assert.equal(h.outputs.values.size, 0, "rejected runs write no value");
  return h;
}

const categories = ["paragraph", "sentence", "word", "title", "first-name", "last-name", "full-name", "email", "url", "short-tweet", "long-tweet"];

for (const cat of categories) {
  test(`Deterministic output for ${cat} (seed 1)`, async () => {
    const res = await run({ category: cat, count: 3 }, { seed: 1 });
    assert.deepEqual(res.value.items, deterministic[`${cat}_seed1`]);
  });

  test(`Deterministic output for ${cat} (seed 42)`, async () => {
    const res = await run({ category: cat, count: 3 }, { seed: 42 });
    assert.deepEqual(res.value.items, deterministic[`${cat}_seed42`]);
  });
}

test("Errors on invalid options", async () => {
  await rejects({ bogus: 1 }, {}, "unknown-option");
  await rejects({ category: "bogus" }, {}, "unknown-category");
  await rejects({ count: 0 }, {}, "invalid-count");
  await rejects({ count: 101 }, {}, "invalid-count");
});

test("Limits check", async () => {
  await rejects({ category: "word", count: 10 }, { limits: { maxOutputBytes: 10 } }, "output-limit");
});

test("Source bytes immutable", async () => {
  await run({ category: "word", count: 1 }, { input: "hello world" });
});
