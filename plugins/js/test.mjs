import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorContext, SeededRandom, defaultLimits } from "../../packages/plugin-sdk/src/index.ts";
import { execute, JsError } from "./processor.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

async function run(operationId, input, { limits, cancellation = new CancellationToken(), reader, request, options = {} } = {}) {
  const source = typeof input === "string" ? encoder.encode(input) : input;
  reader ??= new MemoryReader().insert("input", source);
  const before = reader instanceof MemoryReader ? reader.inputs.get("input").slice() : null;
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(reader, outputs, cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), limits ?? defaultLimits());
  let error = null;
  let returned;
  try { returned = await execute(request ?? { operationId, options }, context); } catch (caught) { error = caught; }
  if (before) assert.deepEqual(reader.inputs.get("input"), before, "source bytes must remain immutable");
  const bytes = outputs.bytes.get("output");
  const properties = outputs.values.get("output");
  return { error, returned, bytes, text: bytes ? decoder.decode(bytes) : null, properties };
}

async function expectOk(operationId, input, options) {
  const result = await run(operationId, input, { options });
  if (result.error) throw result.error;
  return result;
}

try {
  const beautifyCases = await fixture("beautify");
  for (const item of beautifyCases) {
    test(`beautify: ${item.name}`, async () => {
      const formatted = await expectOk("js.beautify", item.input, item.options);
      assert.equal(formatted.text, item.output);
    });
  }
} catch (e) {
  console.log("No beautify fixtures yet.");
}

try {
  const minifyCases = await fixture("minify");
  for (const item of minifyCases) {
    test(`minify: ${item.name}`, async () => {
      const minified = await expectOk("js.minify", item.input, item.options);
      assert.equal(minified.text, item.output);
    });
  }
} catch (e) {
  console.log("No minify fixtures yet.");
}

test("idempotent round trip", async () => {
  const input = "function foo(a, b) {\n    return a + b;\n}";
  const f1 = await expectOk("js.beautify", input);
  const m1 = await expectOk("js.minify", f1.text);
  const f2 = await expectOk("js.beautify", m1.text);
  assert.equal(f1.text, f2.text);
});
