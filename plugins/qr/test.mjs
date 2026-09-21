import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import {
  CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorCancelled, ProcessorContext, SeededRandom,
} from "../../packages/plugin-sdk/src/context.ts";
import { QrError, execute, OPERATION_ID } from "./processor.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const readFixture = async (file) => JSON.parse(await readFile(new URL(`./fixtures/${file}`, import.meta.url), "utf8"));

async function run(operationId, options, input, { reader, cancellation = new CancellationToken(), limits } = {}) {
  const source = reader ?? new MemoryReader().insert("input", encoder.encode(input));
  const before = source instanceof MemoryReader ? source.inputs.get("input").slice() : null;
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(source, outputs, cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), limits);
  const result = await execute({ pluginId: OPERATION_ID, toolId: OPERATION_ID, operationId, options }, context);
  if (before) assert.deepEqual(source.inputs.get("input"), before, "source bytes must be untouched");
  const bytes = outputs.bytes.get("output");
  return { result, value: outputs.values.get("output"), bytes, text: bytes ? decoder.decode(bytes) : undefined, outputs };
}

async function rejects(operationId, options, input, code, extra = {}) {
  const outputs = { written: false };
  let caught;
  try {
    const sink = new MemoryOutputSink();
    const context = new ProcessorContext(new MemoryReader().insert("input", encoder.encode(input)), sink, new CancellationToken(), new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), extra.limits);
    await execute({ operationId, options }, context);
    outputs.written = sink.bytes.size > 0 || sink.values.size > 0;
  } catch (error) { caught = error; }
  assert.ok(caught, `expected ${code} for ${JSON.stringify(input)}`);
  assert.ok(caught instanceof QrError, `expected QrError, got ${caught?.name}: ${caught?.message}`);
  assert.equal(caught.code, code, caught.message);
  assert.equal(outputs.written, false, "no output may be written on failure");
  return caught;
}

test("fixtures produce the expected SVG output or error", async () => {
  const files = await readdir(new URL("./fixtures", import.meta.url));
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const item = await readFixture(file);
    if (item.error) {
      await rejects(item.operationId, item.options, item.input.input, item.error);
    } else {
      const result = await run(item.operationId, item.options, item.input.input);
      assert.equal(result.text, item.output.output, `fixture ${item.id} output SVG mismatch`);
      if (item.properties) {
        for (const [key, value] of Object.entries(item.properties)) {
          assert.deepEqual(result.value[key], value, `fixture ${item.id} property ${key} mismatch`);
        }
      }
    }
  }
});

class ChunkedReader {
  constructor(bytes, chunk, { cancellation, withSize = true } = {}) { this.bytes = bytes; this.chunk = chunk; this.cancellation = cancellation; this.calls = 0; if (!withSize) this.size = undefined; }
  read() { throw new Error("streaming processors must not read the whole input"); }
  size() { return this.bytes.byteLength; }
  readRange(_port, offset, maxBytes) {
    this.calls += 1;
    if (this.cancellation && offset > 0) this.cancellation.cancel();
    return this.bytes.slice(offset, offset + Math.min(maxBytes, this.chunk));
  }
}

test("cooperative cancellation", async () => {
  const cancellation = new CancellationToken();
  const bytes = encoder.encode("a".repeat(1000));
  const reader = new ChunkedReader(bytes, 500, { cancellation });
  const context = new ProcessorContext(reader, new MemoryOutputSink(), cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets());
  try {
    await execute({ operationId: OPERATION_ID, options: {} }, context);
    assert.fail("should have rejected");
  } catch (err) {
    if (err.name !== 'ProcessorCancelled') {
      assert.fail(`rejected with wrong error: ${err.name} ${err.message}`);
    }
  }
});

test("options validation", async () => {
  // outside ranges
  await rejects(OPERATION_ID, { "error-correction": "Z" }, "hello", "qr.invalid-option");
  await rejects(OPERATION_ID, { "cell-size": 0 }, "hello", "qr.invalid-option");
  await rejects(OPERATION_ID, { "cell-size": 41 }, "hello", "qr.invalid-option");
  await rejects(OPERATION_ID, { margin: -1 }, "hello", "qr.invalid-option");
  await rejects(OPERATION_ID, { margin: 17 }, "hello", "qr.invalid-option");
  await rejects(OPERATION_ID, { version: -1 }, "hello", "qr.invalid-option");
  await rejects(OPERATION_ID, { version: 41 }, "hello", "qr.invalid-option");

  // unknown keys
  await rejects(OPERATION_ID, { unknown: true }, "hello", "qr.invalid-option");
});

test("camelCase aliases accepted", async () => {
  const result = await run(OPERATION_ID, { errorCorrection: "H", cellSize: 10 }, "hello");
  assert.equal(result.value.errorCorrection, "H");
  assert.equal(result.value.cellSize, 10);
});

test("determinism", async () => {
  const result1 = await run(OPERATION_ID, { version: 5 }, "hello");
  const result2 = await run(OPERATION_ID, { version: 5 }, "hello");
  assert.deepEqual(result1.bytes, result2.bytes, "two runs must produce byte-identical SVG");
});
