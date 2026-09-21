import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import {
  CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorContext, SeededRandom,
} from "../../packages/plugin-sdk/src/context.ts";
import { validateManifest } from "../../packages/plugin-contract/ts/validate.ts";
import { execute, JsxError, normalizeOptions } from "./processor.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
const descriptor = JSON.parse(await readFile(new URL("./plugin.json", import.meta.url), "utf8"));

const fixtureFiles = (await readdir(new URL("./fixtures", import.meta.url))).filter(f => f.endsWith(".json"));
const allFixtures = [];
for (const file of fixtureFiles) {
  const content = await readFile(new URL(`./fixtures/${file}`, import.meta.url), "utf8");
  allFixtures.push(JSON.parse(content));
}

async function run(operation, options, input, { reader, cancellation = new CancellationToken(), limits } = {}) {
  const source = reader ?? new MemoryReader().insert("input", encoder.encode(input));
  const before = source instanceof MemoryReader ? source.inputs.get("input").slice() : null;
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(source, outputs, cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), limits);
  const report = await execute({ pluginId: "convert.jsx", toolId: "convert.jsx", operationId: operation, options }, context);
  if (before) assert.deepEqual(source.inputs.get("input"), before, "source bytes must be untouched");
  const bytes = outputs.bytes.get("output");
  return { report, value: outputs.values.get("output"), bytes, text: bytes ? decoder.decode(bytes) : undefined, outputs };
}

async function rejects(operation, options, input, code, extra = {}) {
  const sink = new MemoryOutputSink();
  let caught;
  try {
    const context = new ProcessorContext(new MemoryReader().insert("input", encoder.encode(input)), sink, new CancellationToken(), new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), extra.limits);
    await execute({ operationId: operation, options }, context);
  } catch (error) { caught = error; }
  assert.ok(caught, `expected ${code} for ${JSON.stringify(input).slice(0, 60)}`);
  assert.ok(caught instanceof JsxError, `expected JsxError, got ${caught.name}: ${caught.message}`);
  assert.equal(caught.code, code, caught.message);
  assert.equal(sink.bytes.size + sink.values.size, 0, "no output may be written on failure");
  return caught;
}

function assertDiagnostics(actual, expected, name) {
  assert.equal(actual.length, expected.length, `${name}: expected ${expected.length} diagnostics, got ${JSON.stringify(actual)}`);
  for (let index = 0; index < expected.length; index += 1) {
    for (const [key, value] of Object.entries(expected[index])) {
      assert.deepEqual(actual[index][key], value, `${name}: diagnostic ${index} field ${key}`);
    }
  }
}

test("fixtures produce the expected output or error", async () => {
  assert.ok(allFixtures.length >= 40, `expected at least 40 fixtures, found ${allFixtures.length}`);
  for (const item of allFixtures) {
    if (item.error) {
      const caught = await rejects(item.operationId, item.options, item.input.input, item.error);
      assert.ok(caught, `fixture ${item.id} should fail`);
    } else {
      const result = await run(item.operationId, item.options, item.input.input);
      assert.equal(result.text, item.output.output, `fixture ${item.id} output`);
      assertDiagnostics(result.value.annotations, item.diagnostics, item.id);
      assert.equal(result.value.diagnostics, item.diagnostics.length, `${item.id}: diagnostics count`);
    }
  }
});

test("the manifest is contract-valid and matches the processor", () => {
  validateManifest(manifest);
  assert.equal(descriptor.processor, "processor.mjs");
  assert.equal(descriptor.manifest, "manifest.json");
  assert.equal(manifest.id, "convert.jsx");
  assert.deepEqual(manifest.tests.requirementIds, ["DU-24"]);
});

test("normalizeOptions accepts every declared indent spelling", () => {
  assert.equal(normalizeOptions({ indent: "spaces-2" }).indent, "2");
  assert.equal(normalizeOptions({ indent: "spaces-4" }).indent, "4");
  assert.equal(normalizeOptions({ indent: "tab" }).indent, "tab");
});

test("the processor imports no Node built-in", async () => {
  const source = await readFile(new URL("./processor.mjs", import.meta.url), "utf8");
  assert.equal(/\bfrom\s+["']node:/u.test(source), false, "processor.mjs must not import a node: module");
  assert.equal(/\brequire\s*\(/u.test(source), false, "processor.mjs must not call require()");
});

test("every package file uses LF line endings", async () => {
  const files = ["processor.mjs", "test.mjs", "manifest.json", "plugin.json", "README.md"];
  for (const file of files) {
    let text;
    try {
      text = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
    } catch { continue; }
    assert.equal(text.includes("\r"), false, `${file} must use LF line endings`);
  }
});
