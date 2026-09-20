import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorContext, SeededRandom } from "../../packages/plugin-sdk/src/context.ts";
import { execute, NumberBaseError } from "./processor.mjs";

const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
const operation = manifest.operations[0];

const text = bytes => new TextDecoder().decode(bytes);

function harness(options, { input, cancellation = new CancellationToken(), limits } = {}) {
  const reader = new MemoryReader();
  if (input !== undefined && input !== null) reader.insert("input", new TextEncoder().encode(input));
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(reader, outputs, cancellation, new FixedClock("2024-01-01T00:00:00Z"), new SeededRandom(42), new MemorySecrets(), limits || {maxInputBytes: 65536});
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
  assert.equal(outputText, result.result, "text artifact is exactly the result");
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

test("Round-trips 2^53 + 1 exactly", async () => {
  const res = await run({ "from-base": 10, "to-base": 10 }, { input: "9007199254740993" });
  assert.equal(res.value.result, "9007199254740993");
});

test("2^128 (large powers)", async () => {
  // 2^128 = 340282366920938463463374607431768211456
  const res = await run({ "from-base": 10, "to-base": 16 }, { input: "340282366920938463463374607431768211456" });
  assert.equal(res.value.result, "100000000000000000000000000000000");

  const back = await run({ "from-base": 16, "to-base": 10 }, { input: res.value.result });
  assert.equal(back.value.result, "340282366920938463463374607431768211456");
});

test("300-digit decimal", async () => {
  const digits = "9".repeat(300);
  const res = await run({ "from-base": 10, "to-base": 10 }, { input: digits });
  assert.equal(res.value.result, digits);
  assert.equal(res.value.digits, 300);
});

test("Negatives", async () => {
  const res = await run({ "from-base": 10, "to-base": 16 }, { input: "-255" });
  assert.equal(res.value.result, "-ff");
  assert.equal(res.value.negative, true);
});

test("Zero", async () => {
  const res = await run({ "from-base": 10, "to-base": 16 }, { input: "0" });
  assert.equal(res.value.result, "0");
  assert.equal(res.value.negative, false);

  const resNegZero = await run({ "from-base": 10, "to-base": 16 }, { input: "-0" });
  assert.equal(resNegZero.value.result, "0");
  assert.equal(resNegZero.value.negative, false);
});

test("Base 36 zz", async () => {
  const res = await run({ "from-base": 36, "to-base": 10 }, { input: "zz" });
  assert.equal(res.value.result, (35 * 36 + 35).toString());
});

test("Base 2 with 0b prefix", async () => {
  const res = await run({ "from-base": 2, "to-base": 10 }, { input: "0b1010" });
  assert.equal(res.value.result, "10");
});

test("0x with from-base: 10 rejected", async () => {
  await rejects({ "from-base": 10 }, { input: "0x1a" }, "prefix-mismatch");
});

test("Digit 9 in base 8 rejected with offset", async () => {
  try {
    await run({ "from-base": 8 }, { input: "  1239" });
    assert.fail("Should have thrown");
  } catch(e) {
    assert.equal(e.code, "invalid-character");
    assert.equal(e.offset, 5); // space is 0, 1. '1' is 2, '2' is 3, '3' is 4, '9' is 5.
  }
});

test("Fractions and separators rejected", async () => {
  await rejects({ "from-base": 10 }, { input: "1,000" }, "invalid-character");
  await rejects({ "from-base": 10 }, { input: "3.14" }, "invalid-character");
});

test("from-base 1 and 37 rejected", async () => {
  await rejects({ "from-base": 1 }, { input: "0" }, "invalid-option");
  await rejects({ "from-base": 37 }, { input: "0" }, "invalid-option");
  await rejects({ "to-base": 1 }, { input: "0" }, "invalid-option");
  await rejects({ "to-base": 37 }, { input: "0" }, "invalid-option");
});

test("Upper and lower digit rendering", async () => {
  const lower = await run({ "from-base": 10, "to-base": 16, digits: "lower" }, { input: "255" });
  assert.equal(lower.value.result, "ff");

  const upper = await run({ "from-base": 10, "to-base": 16, digits: "upper" }, { input: "255" });
  assert.equal(upper.value.result, "FF");
});

test("Source bytes immutable", async () => {
  // handled generically in run()
  await run({}, { input: "12345" });
});
