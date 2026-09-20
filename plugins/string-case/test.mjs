import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorCancelled, ProcessorContext, SeededRandom,
} from "../../packages/plugin-sdk/src/context.ts";
import { StringCaseError, execute, TARGETS } from "./processor.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

async function run(options, input, { reader, cancellation = new CancellationToken(), limits } = {}) {
  const source = reader ?? new MemoryReader().insert("input", encoder.encode(input));
  const before = source instanceof MemoryReader ? source.inputs.get("input").slice() : null;
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(source, outputs, cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), limits);
  const result = await execute({ pluginId: "text.case", toolId: "text.case", operationId: "text.case", options }, context);
  if (before) assert.deepEqual(source.inputs.get("input"), before, "source bytes must be untouched");
  const bytes = outputs.bytes.get("output");
  return { result, value: outputs.values.get("output"), bytes, text: bytes ? decoder.decode(bytes) : undefined, outputs };
}

async function rejects(options, input, code, extra = {}) {
  const outputs = { written: false };
  let caught;
  try {
    const sink = new MemoryOutputSink();
    const context = new ProcessorContext(new MemoryReader().insert("input", encoder.encode(input)), sink, new CancellationToken(), new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), extra.limits);
    await execute({ options }, context);
    outputs.written = sink.bytes.size > 0 || sink.values.size > 0;
  } catch (error) { caught = error; }
  assert.ok(caught, `expected ${code} for ${JSON.stringify(input)}`);
  assert.ok(caught instanceof StringCaseError, `expected StringCaseError, got ${caught.name}: ${caught.message}`);
  assert.equal(caught.code, code, caught.message);
  assert.equal(outputs.written, false, "no output may be written on failure");
  return caught;
}

test("vectors convert correctly and are idempotent", async () => {
  const vectors = await fixture("vectors");
  for (const vector of vectors) {
    const converted = await run(vector.options, vector.input);
    assert.equal(converted.text, vector.output, `${vector.name}: expected ${JSON.stringify(vector.output)} but got ${JSON.stringify(converted.text)}`);

    if (vector.expectedProperties) {
      assert.equal(converted.value.lines, vector.expectedProperties.lines, `${vector.name}: expected lines ${vector.expectedProperties.lines}`);
      assert.equal(converted.value.converted, vector.expectedProperties.converted, `${vector.name}: expected converted ${vector.expectedProperties.converted}`);
      assert.equal(converted.value.acronymsApplied, vector.expectedProperties.acronymsApplied, `${vector.name}: expected acronymsApplied ${vector.expectedProperties.acronymsApplied}`);
    }

    for (const target of TARGETS) {
      const options = { ...vector.options, target };
      const pass1 = await run(options, vector.input);
      const pass2 = await run(options, pass1.text);
      assert.equal(pass2.text, pass1.text, `${vector.name} (idempotence ${target}): expected ${JSON.stringify(pass1.text)} but got ${JSON.stringify(pass2.text)}`);
    }
  }
});

test("invalid options and limits produce structured errors", async () => {
  const invalids = await fixture("invalid");
  for (const vector of invalids) {
    await rejects(vector.options, vector.input, vector.errorCode);
  }
});

test("input limit is enforced", async () => {
  const limits = { maxInputBytes: 16, maxOutputBytes: 1024, maxChunkBytes: 1024, deadlineMs: 0 };
  const input = "a".repeat(17);
  await assert.rejects(() => run({ target: "camel" }, input, { limits }), /exceeds/);
});

test("output limit is enforced", async () => {
  const limits = { maxInputBytes: 1024, maxOutputBytes: 16, maxChunkBytes: 1024, deadlineMs: 0 };
  const input = "a".repeat(17);
  await rejects({ target: "camel" }, input, "case.output-limit", { limits });
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
  const bytes = encoder.encode("a".repeat(100_000));
  const reader = new ChunkedReader(bytes, 65536, { cancellation });
  const context = new ProcessorContext(reader, new MemoryOutputSink(), cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets());
  try {
    await execute({ options: { target: "camel" } }, context);
    assert.fail("should have rejected");
  } catch (err) {
    if (err.name !== 'ProcessorCancelled') {
      assert.fail(`rejected with wrong error: ${err.name} ${err.message}`);
    }
  }
});
