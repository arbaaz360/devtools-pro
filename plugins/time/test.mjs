import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorCancelled, ProcessorContext, SeededRandom } from "../../packages/plugin-sdk/src/context.ts";
import { execute, TimeError } from "./processor.mjs";

const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
const operation = manifest.operations[0];
const CLOCK = "2024-02-01T12:00:00.000Z";

const text = bytes => new TextDecoder().decode(bytes);

function harness(options, { input, clock = CLOCK, cancellation = new CancellationToken(), limits } = {}) {
  const reader = new MemoryReader();
  if (input !== undefined && input !== null) reader.insert("input", new TextEncoder().encode(input));
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(reader, outputs, cancellation, new FixedClock(clock), new SeededRandom(42), new MemorySecrets(), limits || {maxInputBytes: 4096});
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
  assert.ok(outputText.endsWith("\n") && !outputText.endsWith("\n\n"), "text artifact ends with exactly one newline");
  return { ...h, value, text: outputText };
}

async function rejects(options, env, pattern) {
  const h = harness(options, env);
  await assert.rejects(h.execute, pattern);
  assert.equal(h.outputs.bytes.size, 0, "rejected runs write no text artifact");
  assert.equal(h.outputs.values.size, 0, "rejected runs write no value");
  return h;
}

// Basic empty -> now
const noInput = await run({}, { clock: "2024-01-01T00:00:00Z" });
assert.equal(noInput.value.interpretation, "now");
assert.equal(noInput.value.isoUtc, "2024-01-01T00:00:00.000Z");
assert.equal(noInput.value.relative, "now");

// Epoch zero
const epochZero = await run({}, { input: "0" });
assert.equal(epochZero.value.epochMilliseconds, 0);
assert.equal(epochZero.value.isoUtc, "1970-01-01T00:00:00.000Z");

// Negative timestamps
const negative = await run({}, { input: "-1000" });
assert.equal(negative.value.epochMilliseconds, -1000000); // 1000 secs

// Millisecond precision
const millis = await run({}, { input: "1700000000123" });
assert.equal(millis.value.epochMilliseconds, 1700000000123);
assert.equal(millis.value.interpretation, "milliseconds");

// The leap day
const leap = await run({}, { input: "2024-02-29" });
assert.equal(leap.value.leapYear, true);
assert.equal(leap.value.dateUtc, "2024-02-29");
assert.equal(leap.value.interpretation, "iso");

// 2023-02-29 rejected
await rejects({}, { input: "2023-02-29" }, /Invalid ISO 8601 date/);

// Offsets
const tz1 = await run({}, { input: "2024-02-29T12:00:00+05:30" });
assert.equal(tz1.value.timeUtc, "06:30:00.000Z");

const tz2 = await run({}, { input: "2024-02-29T12:00:00-08:00" });
assert.equal(tz2.value.timeUtc, "20:00:00.000Z");

// Boundary of digit heuristic
const elevenDigits = await run({}, { input: "99999999999" });
assert.equal(elevenDigits.value.interpretation, "seconds");

const twelveDigits = await run({}, { input: "100000000000" });
assert.equal(twelveDigits.value.interpretation, "milliseconds");

const negTwelveDigits = await run({}, { input: "-100000000000" });
assert.equal(negTwelveDigits.value.interpretation, "milliseconds");

// Explicit unit
const expl = await run({ interpretation: "seconds" }, { input: "100000000000" });
assert.equal(expl.value.interpretation, "seconds");
assert.equal(expl.value.epochSeconds, 100000000000);

// Arithmetic
const arith = await run({}, { input: "1700000000 + 86400 * 7" });
assert.equal(arith.value.epochSeconds, 1700604800);
assert.equal(arith.value.expression, true);

const parens = await run({}, { input: "(1 + 2) * 3" });
assert.equal(parens.value.epochSeconds, 9);
assert.equal(parens.value.expression, true);

// Invalid arithmetic
await rejects({}, { input: "(1 + 2 * 3" }, /Unbalanced parentheses/);
await rejects({}, { input: "1 / 0" }, /Division by zero/);

// Out of range
await rejects({}, { input: "8640000000000001" }, /outside the ECMAScript date range/);

// Relative time with fixed clock
const rel1 = await run({}, { input: "2024-02-04T12:00:00Z", clock: "2024-02-01T12:00:00Z" });
assert.equal(rel1.value.relative, "in 3 days");

const rel2 = await run({}, { input: "2024-01-29T12:00:00Z", clock: "2024-02-01T12:00:00Z" });
assert.equal(rel2.value.relative, "3 days ago");

// Ambiguous
await rejects({}, { input: "01/02/2024" }, /Ambiguous date format. Use ISO 8601/);

// Input limit
await rejects({}, { input: "1".repeat(4097), limits: { maxInputBytes: 4096 } }, /exceeds/);

console.log("Passed!");
