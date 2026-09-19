import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorCancelled, ProcessorContext, SeededRandom, defaultLimits } from "../../packages/plugin-sdk/src/index.ts";
import { CANCELLATION_STRIDE, JsonError, MAX_DEPTH, MAX_DIAGNOSTICS_PER_CODE, READ_CHUNK_BYTES, execute, findInvalidUtf8 } from "./processor.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const sourceOf = (item) => item.inputHex !== undefined ? Uint8Array.from(Buffer.from(item.inputHex.replace(/\s+/g, ""), "hex")) : encoder.encode(item.input);
const positionOf = ({ code, offset, end, line, column }) => ({ code, offset, end, line, column });

/**
 * Runs one operation through the public SDK context and returns everything a
 * host could observe. Source immutability and artifact completeness are
 * asserted on every call.
 */
async function run(operationId, input, { limits, cancellation = new CancellationToken(), reader, request } = {}) {
  const source = typeof input === "string" ? encoder.encode(input) : input;
  reader ??= new MemoryReader().insert("input", source);
  const before = reader instanceof MemoryReader ? reader.inputs.get("input").slice() : null;
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(reader, outputs, cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), limits);
  let error = null;
  let returned;
  try { returned = await execute(request ?? { operationId, options: {} }, context); } catch (caught) { error = caught; }
  if (before) assert.deepEqual(reader.inputs.get("input"), before, "source bytes must remain immutable");
  const bytes = outputs.bytes.get("output");
  const artifact = outputs.artifacts.get("output");
  if (artifact) {
    assert.equal(artifact.byteLength, bytes.byteLength, "artifact length must describe the complete output");
    assert.equal(artifact.contentHash, sha256(bytes), "artifact hash must cover the complete output");
  }
  return { error, returned, bytes, text: bytes ? decoder.decode(bytes) : null, value: outputs.values.get("output"), artifact };
}

async function expectOk(operationId, input, options) {
  const result = await run(operationId, input, options);
  if (result.error) throw result.error;
  return result;
}

// ---------------------------------------------------------------------------
// Valid documents: exact format/minify bytes, inspect statistics, round trips.
// ---------------------------------------------------------------------------
for (const item of await fixture("json-valid")) {
  test(`valid: ${item.name}`, async () => {
    const source = sourceOf(item);
    const formatted = await expectOk("format", source);
    const minified = await expectOk("minify", source);
    const inspected = await expectOk("inspect", source);
    assert.equal(formatted.text, item.formatted, "format output");
    assert.equal(minified.text, item.minified, "minify output");
    assert.equal(formatted.value.outputBytes, formatted.bytes.byteLength);
    assert.equal(minified.value.outputBytes, minified.bytes.byteLength);
    assert.equal(inspected.artifact, undefined, "inspect writes a value, not an artifact");
    assert.equal(inspected.value.valid, true);
    assert.equal(inspected.value.complete, true);
    assert.equal(inspected.value.topLevel, item.topLevel);
    assert.equal(inspected.value.maxDepth, item.maxDepth);
    assert.equal(inspected.value.bom, item.bom ?? false);
    assert.equal(inspected.value.inputBytes, source.byteLength);
    assert.equal(inspected.value.contentBytes, source.byteLength - (item.bom ? 3 : 0));
    assert.equal(inspected.value.formattedBytes, formatted.bytes.byteLength, "inspect predicts the format size");
    assert.equal(inspected.value.minifiedBytes, minified.bytes.byteLength, "inspect predicts the minify size");
    if (item.counts) assert.deepEqual(inspected.value.counts, item.counts);
    assert.equal(inspected.value.diagnostics.filter((entry) => entry.severity === "error").length, 0);
    if (item.bom) assert.deepEqual(inspected.value.diagnostics.map((entry) => entry.code), ["json.bom"]);
    // Both layouts are fixed points and convert into each other.
    assert.equal((await expectOk("format", formatted.bytes)).text, item.formatted, "format is idempotent");
    assert.equal((await expectOk("minify", minified.bytes)).text, item.minified, "minify is idempotent");
    assert.equal((await expectOk("minify", formatted.bytes)).text, item.minified, "minify(format(x))");
    assert.equal((await expectOk("format", minified.bytes)).text, item.formatted, "format(minify(x))");
    // Independent semantic oracle: the output must parse to the same value as the input.
    const inputText = decoder.decode(source).replace(/^﻿/u, "");
    assert.deepEqual(JSON.parse(formatted.text), JSON.parse(inputText));
    assert.deepEqual(JSON.parse(minified.text), JSON.parse(inputText));
    if (item.oracle) {
      assert.equal(formatted.text, JSON.stringify(JSON.parse(inputText), null, 2), "layout matches JSON.stringify for lexeme-neutral input");
      assert.equal(minified.text, JSON.stringify(JSON.parse(inputText)));
    }
  });
}

// ---------------------------------------------------------------------------
// Invalid documents: one structured diagnostic with byte and line positions.
// ---------------------------------------------------------------------------
for (const item of await fixture("json-invalid")) {
  test(`invalid: ${item.name}`, async () => {
    const source = sourceOf(item);
    const expected = positionOf(item);
    for (const operationId of ["format", "minify"]) {
      const result = await run(operationId, source);
      assert.ok(result.error instanceof JsonError, `${operationId} must reject with JsonError, got ${result.error}`);
      assert.equal(result.error.code, item.code, operationId);
      assert.deepEqual(positionOf(result.error.diagnostic), expected, operationId);
      assert.ok(result.error.diagnostic.message.includes(item.messageIncludes), `${operationId}: ${result.error.diagnostic.message}`);
      assert.ok(result.error.message.includes(`line ${item.line}, column ${item.column} (byte ${item.offset})`), result.error.message);
      assert.equal(result.artifact, undefined, `${operationId} must not publish an artifact`);
      assert.equal(result.value, undefined, `${operationId} must not publish a value`);
    }
    const inspected = await expectOk("inspect", source);
    assert.equal(inspected.value.valid, false);
    assert.equal(inspected.value.complete, true);
    assert.equal(inspected.artifact, undefined);
    const errors = inspected.value.diagnostics.filter((entry) => entry.severity === "error");
    assert.equal(errors.length, 1, "exactly one error diagnostic");
    assert.deepEqual(positionOf(errors[0]), expected);
    assert.equal(inspected.value.topLevel, null);
    assert.equal(inspected.value.counts, null);
  });
}

// ---------------------------------------------------------------------------
// Duplicate member names: preserved in output, reported with both positions.
// ---------------------------------------------------------------------------
for (const item of await fixture("json-duplicate-keys")) {
  test(`duplicate keys: ${item.name}`, async () => {
    const formatted = await expectOk("format", item.input);
    const minified = await expectOk("minify", item.input);
    const inspected = await expectOk("inspect", item.input);
    assert.equal(formatted.text, item.formatted);
    assert.equal(minified.text, item.minified);
    for (const value of [formatted.value, minified.value, inspected.value]) {
      assert.equal(value.valid, true);
      assert.equal(value.duplicateKeys, item.duplicateKeys);
      const warnings = value.diagnostics.filter((entry) => entry.code === "json.duplicate-key");
      assert.equal(warnings.length, item.diagnostics.length);
      warnings.forEach((warning, index) => {
        const expected = item.diagnostics[index];
        assert.equal(warning.severity, "warning");
        assert.deepEqual(positionOf(warning), { code: "json.duplicate-key", offset: expected.offset, end: expected.end, line: expected.line, column: expected.column });
        assert.ok(warning.message.includes(JSON.stringify(expected.name)), warning.message);
        assert.equal(warning.related.length, 1);
        assert.equal(warning.related[0].offset, expected.firstOffset);
        assert.equal(warning.related[0].end, expected.firstEnd);
        assert.ok(Number.isInteger(warning.related[0].line) && Number.isInteger(warning.related[0].column));
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Numbers: lexemes are never routed through Number; unsafe integers are flagged.
// ---------------------------------------------------------------------------
for (const item of await fixture("json-numbers")) {
  test(`numbers: ${item.name}`, async () => {
    const minified = await expectOk("minify", item.input);
    assert.equal(minified.text, item.minified);
    if (item.formatted !== undefined) assert.equal((await expectOk("format", item.input)).text, item.formatted);
    const inspected = await expectOk("inspect", item.input);
    assert.equal(inspected.value.valid, true);
    assert.deepEqual(inspected.value.numbers, { integers: item.integers, unsafeIntegers: item.unsafeIntegers, withFractionOrExponent: item.withFractionOrExponent });
    assert.equal(inspected.value.counts.numbers, item.integers + item.withFractionOrExponent);
    const flagged = inspected.value.diagnostics.filter((entry) => entry.code === "json.unsafe-integer");
    assert.deepEqual(flagged.map((entry) => entry.offset), item.unsafeOffsets);
    for (const entry of flagged) assert.equal(entry.severity, "info");
  });
}

test("numbers: a large integer survives a format/minify cycle where JSON.parse would not", async () => {
  const input = "{\"id\":12345678901234567890}";
  const formatted = await expectOk("format", input);
  assert.equal((await expectOk("minify", formatted.bytes)).text, input);
  assert.notEqual(JSON.stringify(JSON.parse(input)), input, "the oracle itself rounds, which is why it is not used here");
});

// ---------------------------------------------------------------------------
// Generated cases: depth, size, limits, chunked reads, diagnostics cap.
// ---------------------------------------------------------------------------
test("nesting up to MAX_DEPTH is accepted and one level more is rejected at the offending bracket", async () => {
  const atLimit = "[".repeat(MAX_DEPTH) + "]".repeat(MAX_DEPTH);
  const inspected = await expectOk("inspect", atLimit);
  assert.equal(inspected.value.valid, true);
  assert.equal(inspected.value.maxDepth, MAX_DEPTH);
  const formatted = await expectOk("format", atLimit);
  assert.equal(formatted.text.split("\n").length, MAX_DEPTH * 2 - 1);
  assert.equal((await expectOk("minify", atLimit)).text, atLimit);
  const overLimit = "[".repeat(MAX_DEPTH + 1) + "]".repeat(MAX_DEPTH + 1);
  const result = await run("format", overLimit);
  assert.ok(result.error instanceof JsonError);
  assert.equal(result.error.code, "json.depth-limit");
  assert.equal(result.error.diagnostic.offset, MAX_DEPTH);
  assert.equal(result.error.diagnostic.column, MAX_DEPTH + 1);
  const objects = "{\"a\":".repeat(MAX_DEPTH + 1) + "1" + "}".repeat(MAX_DEPTH + 1);
  assert.equal((await run("inspect", objects)).value.diagnostics[0].code, "json.depth-limit");
});

test("a large string with escapes and multibyte text is copied byte for byte", async () => {
  const unit = "0123456789 \\\" \\\\ \\/ \\n \\u00e9 \\uD83D\\uDE00 é 😀 ключ ";
  const text = unit.repeat(Math.ceil((300 * 1024) / unit.length));
  const input = `{"big":"${text}","after":[1,2]}`;
  const source = encoder.encode(input);
  assert.ok(source.byteLength > READ_CHUNK_BYTES * 4, "input spans several reader chunks");
  const minified = await expectOk("minify", source);
  assert.deepEqual(minified.bytes, source, "minify of an already compact document is the identity");
  const formatted = await expectOk("format", source);
  assert.equal(formatted.text, `{\n  "big": "${text}",\n  "after": [\n    1,\n    2\n  ]\n}`);
  assert.equal(formatted.value.counts.strings, 1);
  assert.equal(formatted.value.inputBytes, source.byteLength);
});

test("many small values across several reader chunks produce one complete artifact", async () => {
  const count = 40000;
  const input = "[" + Array.from({ length: count }, (_, index) => index).join(",") + "]";
  assert.ok(input.length > READ_CHUNK_BYTES * 3);
  const minified = await expectOk("minify", input);
  assert.equal(minified.text, input);
  assert.equal(minified.value.counts.elements, count);
  const formatted = await expectOk("format", input);
  assert.equal(formatted.text, "[\n" + Array.from({ length: count }, (_, index) => `  ${index}`).join(",\n") + "\n]");
});

test("input above the injected limit is rejected by the SDK reader before any parsing", async () => {
  const limits = { ...defaultLimits(), maxInputBytes: 8 };
  for (const operationId of ["format", "minify", "inspect"]) {
    const result = await run(operationId, "[1,2,3,4]", { limits });
    assert.match(result.error?.message ?? "", /exceeds/, operationId);
    assert.equal(result.artifact, undefined);
    assert.equal(result.value, undefined);
  }
  assert.equal((await expectOk("minify", "[1,2,3]", { limits })).text, "[1,2,3]");
});

test("output above the effective cap is rejected explicitly and nothing partial is published", async () => {
  const input = "[" + Array.from({ length: 200 }, () => "1").join(",") + "]";
  const limits = { ...defaultLimits(), maxOutputBytes: 64, maxChunkBytes: 1024 };
  const compact = await expectOk("minify", "[1]", { limits });
  assert.equal(compact.text, "[1]");
  for (const operationId of ["format", "minify"]) {
    const result = await run(operationId, input, { limits });
    assert.ok(result.error instanceof JsonError, `${operationId}: ${result.error}`);
    assert.equal(result.error.code, "json.output-limit");
    assert.equal(result.error.diagnostic.offset, null);
    assert.match(result.error.message, /above the 64 byte output limit/);
    assert.equal(result.artifact, undefined);
    assert.equal(result.value, undefined);
  }
  const inspected = await expectOk("inspect", input, { limits });
  assert.equal(inspected.value.valid, true, "inspect is unaffected by the output cap");
  assert.equal(inspected.value.limits.maxOutputBytes, 64);
});

test("the output cap is the smaller of maxOutputBytes and maxChunkBytes because the sink takes one chunk", async () => {
  const limits = { ...defaultLimits(), maxOutputBytes: 1024, maxChunkBytes: 16 };
  const result = await run("format", "{\"a\":[1,2,3]}", { limits });
  assert.equal(result.error?.code, "json.output-limit");
  assert.match(result.error.message, /above the 16 byte output limit/);
  assert.equal((await expectOk("minify", "{\"a\":[1]}", { limits })).text, "{\"a\":[1]}");
});

test("validation errors take precedence over the output cap", async () => {
  const limits = { ...defaultLimits(), maxOutputBytes: 4 };
  const result = await run("format", "[1,2,3,", { limits });
  assert.equal(result.error?.code, "json.unexpected-end");
});

test("diagnostics per code are capped and the remainder is counted", async () => {
  const total = MAX_DIAGNOSTICS_PER_CODE + 50;
  const input = "{" + Array.from({ length: total + 1 }, () => "\"k\":1").join(",") + "}";
  const inspected = await expectOk("inspect", input);
  assert.equal(inspected.value.duplicateKeys, total);
  assert.equal(inspected.value.diagnostics.filter((entry) => entry.code === "json.duplicate-key").length, MAX_DIAGNOSTICS_PER_CODE);
  assert.equal(inspected.value.suppressedDiagnostics, 50);
  assert.equal(inspected.value.limits.maxDiagnosticsPerCode, MAX_DIAGNOSTICS_PER_CODE);
});

test("diagnostics are ordered by byte offset and every span carries a resolved position", async () => {
  const input = "﻿{\"n\":99999999999999999,\"a\":1,\"a\":2}";
  const inspected = await expectOk("inspect", input);
  assert.deepEqual(inspected.value.diagnostics.map((entry) => [entry.code, entry.severity]), [["json.bom", "info"], ["json.unsafe-integer", "info"], ["json.duplicate-key", "warning"]]);
  for (const entry of inspected.value.diagnostics) {
    assert.ok(Number.isInteger(entry.offset) && Number.isInteger(entry.end) && entry.end >= entry.offset, JSON.stringify(entry));
    assert.ok(Number.isInteger(entry.line) && Number.isInteger(entry.column), JSON.stringify(entry));
  }
  assert.equal((await expectOk("format", input)).text, "{\n  \"n\": 99999999999999999,\n  \"a\": 1,\n  \"a\": 2\n}");
});

// ---------------------------------------------------------------------------
// Cancellation: before reading, between chunks, and inside the scanner.
// ---------------------------------------------------------------------------
class CancellingReader extends MemoryReader {
  constructor(source, token, afterChunks) { super(); this.insert("input", source); this.token = token; this.afterChunks = afterChunks; this.reads = 0; }
  readRange(port, offset, maxBytes) { this.reads += 1; if (this.reads >= this.afterChunks) this.token.cancel(); return super.readRange(port, offset, maxBytes); }
}
class CountedCancellation {
  constructor(allowedChecks) { this.allowedChecks = allowedChecks; this.checks = 0; }
  isCancelled() { this.checks += 1; return this.checks > this.allowedChecks; }
}

test("a token cancelled before execution rejects without reading or writing", async () => {
  const cancellation = new CancellationToken(); cancellation.cancel();
  for (const operationId of ["format", "minify", "inspect"]) {
    const result = await run(operationId, "[1]", { cancellation });
    assert.ok(result.error instanceof ProcessorCancelled, operationId);
    assert.equal(result.artifact, undefined); assert.equal(result.value, undefined);
  }
});

test("cancellation between reader chunks stops the job before validation output exists", async () => {
  const source = encoder.encode("[" + "1,".repeat(READ_CHUNK_BYTES) + "1]");
  const cancellation = new CancellationToken();
  const reader = new CancellingReader(source, cancellation, 2);
  const result = await run("format", source, { cancellation, reader });
  assert.ok(result.error instanceof ProcessorCancelled);
  assert.ok(reader.reads < Math.ceil(source.byteLength / READ_CHUNK_BYTES) + 1, "the reader stopped early");
  assert.equal(result.artifact, undefined); assert.equal(result.value, undefined);
});

test("cancellation raised while scanning is honoured at the cooperative stride", async () => {
  const source = encoder.encode("[" + "1,".repeat(CANCELLATION_STRIDE * 3) + "1]");
  for (const operationId of ["format", "minify", "inspect"]) {
    // Enough checks to read every chunk, then flip during the scan.
    const cancellation = new CountedCancellation(Math.ceil(source.byteLength / READ_CHUNK_BYTES) + 3);
    const result = await run(operationId, source, { cancellation });
    assert.ok(result.error instanceof ProcessorCancelled, `${operationId}: ${result.error}`);
    assert.ok(cancellation.checks > Math.ceil(source.byteLength / READ_CHUNK_BYTES) + 3, "the scanner itself checked the token");
    assert.equal(result.artifact, undefined); assert.equal(result.value, undefined);
  }
});

test("cancellation is checked inside a single oversized string token", async () => {
  const source = encoder.encode("\"" + "a".repeat(CANCELLATION_STRIDE * 3) + "\"");
  // Count every check that precedes the grammar scan: one before reading, one per reader chunk, then the UTF-8 pass.
  let utf8Checks = 0;
  findInvalidUtf8(source, 0, source.byteLength, () => { utf8Checks += 1; });
  const beforeScan = 1 + Math.ceil(source.byteLength / READ_CHUNK_BYTES) + utf8Checks;
  const cancellation = new CountedCancellation(beforeScan);
  const result = await run("inspect", source, { cancellation });
  assert.ok(result.error instanceof ProcessorCancelled, String(result.error));
  assert.equal(cancellation.checks, beforeScan + 1, "the first check inside the string token observed the cancellation");
  assert.equal(result.value, undefined);
  const digitsOnly = encoder.encode("[" + "7".repeat(CANCELLATION_STRIDE * 2) + "]");
  const numberCancellation = new CountedCancellation(1 + Math.ceil(digitsOnly.byteLength / READ_CHUNK_BYTES) + 2);
  assert.ok((await run("minify", digitsOnly, { cancellation: numberCancellation })).error instanceof ProcessorCancelled);
  assert.equal((await expectOk("minify", digitsOnly)).bytes.byteLength, digitsOnly.byteLength, "the same number is accepted when not cancelled");
});

test("cancellation raised during the emitting pass leaves no artifact", async () => {
  const source = encoder.encode("[" + "1,".repeat(CANCELLATION_STRIDE * 2) + "1]");
  const uncancelled = new CountedCancellation(Number.POSITIVE_INFINITY);
  await expectOk("minify", source, { cancellation: uncancelled });
  // Allow every check up to the render pass, then cancel inside it.
  const cancellation = new CountedCancellation(uncancelled.checks - 2);
  const result = await run("minify", source, { cancellation });
  assert.ok(result.error instanceof ProcessorCancelled, String(result.error));
  assert.equal(result.artifact, undefined); assert.equal(result.value, undefined);
});

// ---------------------------------------------------------------------------
// Request handling.
// ---------------------------------------------------------------------------
test("unknown operations are rejected and a missing operation id means format", async () => {
  const unknown = await run("explode", "[1]");
  assert.match(unknown.error?.message ?? "", /unsupported operation explode/);
  assert.equal((await expectOk("format", "[1]", { request: { options: {} } })).text, "[\n  1\n]");
});

test("the structured value names the operation, limits and policies", async () => {
  const { value } = await expectOk("minify", "{\"a\":1}");
  assert.equal(value.operation, "minify");
  assert.deepEqual(value.policy, { grammar: "RFC 8259", strings: "lexeme-preserving", numbers: "lexeme-preserving", duplicateKeys: "preserve-and-report", bom: "strip-and-report", indent: "2 spaces" });
  assert.deepEqual(Object.keys(value.limits), ["maxDepth", "maxInputBytes", "maxOutputBytes", "maxDiagnosticsPerCode"]);
  assert.equal(value.limits.maxDepth, MAX_DEPTH);
});
