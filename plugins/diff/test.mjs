import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorContext, SeededRandom, ProcessorCancelled, defaultLimits } from "../../packages/plugin-sdk/src/context.ts";
import { execute } from "./processor.mjs";

async function run(left, right, options = {}, setup) {
  const reader = new MemoryReader();
  if (left !== undefined) reader.insert("left", left);
  if (right !== undefined) reader.insert("right", right);
  const outputs = new MemoryOutputSink();
  const cancellation = new CancellationToken();
  const context = new ProcessorContext(reader, outputs, cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets());
  setup?.({ cancellation, context });
  const value = await execute({ options }, context);
  return { value, text: new TextDecoder().decode(outputs.bytes.get("output")), outputs };
}

const cases = JSON.parse(await readFile(new URL("./fixtures/cases.json", import.meta.url), "utf8"));
for (const fixture of cases) {
  const result = await run(fixture.left, fixture.right, fixture.options);
  for (const [key, expected] of Object.entries(fixture.summary)) assert.equal(result.value.summary[key], expected, fixture.name);
  assert.equal(result.value.complete, true);
  assert.deepEqual(JSON.parse(result.text), result.value, fixture.name);
}
const boundaries = JSON.parse(await readFile(new URL("./fixtures/boundaries.json", import.meta.url), "utf8"));
for (const fixture of boundaries) {
  const result = await run(fixture.left, fixture.right, fixture.options);
  for (const [key, expected] of Object.entries(fixture.summary)) assert.equal(result.value.summary[key], expected, fixture.name);
}
await assert.rejects(() => run("a", "b", { newline: "native" }), /newline must be/);
await assert.rejects(() => run("a", "b", { contextLines: -1 }), /contextLines must be/);
await assert.rejects(() => run("a", undefined), /named input right was not supplied/);
const cancelled = new CancellationToken(); cancelled.cancel();
await assert.rejects(async () => {
  const reader = new MemoryReader().insert("left", "a").insert("right", "b");
  const context = new ProcessorContext(reader, new MemoryOutputSink(), cancelled, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets());
  await execute({ options: {} }, context);
}, ProcessorCancelled);
const tight = new ProcessorContext(new MemoryReader().insert("left", "left\n").insert("right", "right\n"), new MemoryOutputSink(), new CancellationToken(), new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), { ...defaultLimits(), maxOutputBytes: 10 });
await assert.rejects(() => execute({ options: {} }, tight), /diff output exceeds/);
console.log("diff package tests passed");
