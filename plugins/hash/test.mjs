import test from "node:test";
import assert from "node:assert/strict";
import { createHash, getHashes } from "node:crypto";
import { readFile } from "node:fs/promises";
import v8 from "node:v8";
import vm from "node:vm";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorCancelled, ProcessorContext, SeededRandom, defaultLimits } from "../../packages/plugin-sdk/src/index.ts";
import { ALGORITHMS, CASES, INPUT_PORT, OPERATION_ID, execute, normalizeOptions } from "./processor.mjs";

const here = (path) => new URL(path, import.meta.url);
const json = async (path) => JSON.parse(await readFile(here(path), "utf8"));
const manifest = await json("./manifest.json");
const readme = await readFile(here("./README.md"), "utf8");
const { vectors: published } = await json("./fixtures/vectors.json");
const { vectors: byteVectors } = await json("./fixtures/bytes.json");
const operation = manifest.operations.find((item) => item.id === OPERATION_ID);
const declaredLimits = Object.fromEntries(Object.entries(operation.limits).map(([key, value]) => [key, Number(value)]));
const ids = ALGORITHMS.map((item) => item.id);
const byId = new Map(ALGORITHMS.map((item) => [item.id, item]));
const VALUE_KEYS = ["algorithm", "digest", "case", "source", "inputBytes", "encoding", "complete"];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CLOCK = "2025-01-01T00:00:00Z";

const fromHex = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));
const byteVector = (name) => byteVectors.find((item) => item.name === name);
function materialize(vector) {
  const unit = encoder.encode(vector.input);
  const count = vector.repeat ?? 1;
  const bytes = new Uint8Array(unit.byteLength * count);
  for (let index = 0; index < count; index += 1) bytes.set(unit, index * unit.byteLength);
  return bytes;
}
const withInputLimit = (maxInputBytes) => ({ ...defaultLimits(), maxInputBytes });
/** Readers may observe chunks asynchronously; the SDK awaits readRange so the chunk is returned after the observer settles. */
const observed = (pending, chunk) => (pending && typeof pending.then === "function" ? pending.then(() => chunk) : chunk);

/**
 * A host-style range reader over a fixed buffer that records every SDK call.
 * `serve` caps the bytes returned per read (short reads are legitimate host
 * behaviour); `honorZero: false` models a reader that ignores a zero-byte
 * request and keeps streaming.
 */
class RangeReader {
  constructor(bytes, { size = true, serve = Infinity, onRead = () => {}, honorZero = true } = {}) {
    this.bytes = bytes; this.calls = []; this.wholeReads = 0; this.serve = serve; this.onRead = onRead; this.honorZero = honorZero;
    if (!size) this.size = undefined;
  }
  size(port) { assert.equal(port, INPUT_PORT); return this.bytes.byteLength; }
  readRange(port, offset, maxBytes) {
    assert.equal(port, INPUT_PORT);
    const wanted = maxBytes === 0 && !this.honorZero ? this.serve : Math.min(maxBytes, this.serve);
    const chunk = this.bytes.slice(offset, offset + wanted);
    this.calls.push({ offset, maxBytes, length: chunk.byteLength });
    return observed(this.onRead(chunk, this.calls.length), chunk);
  }
  read(port, maxBytes) { this.wholeReads += 1; assert.equal(port, INPUT_PORT); if (this.bytes.byteLength > maxBytes) throw new Error(`read of ${port} exceeds the ${maxBytes} byte limit`); return this.bytes.slice(); }
}
/** The minimal reader shape: no size(), no readRange(); exercises the SDK fallback path. */
class WholeReader {
  constructor(bytes) { this.bytes = bytes; this.wholeReads = 0; }
  read(port, maxBytes) { this.wholeReads += 1; assert.equal(port, INPUT_PORT); if (this.bytes.byteLength > maxBytes) throw new Error(`read of ${port} exceeds the ${maxBytes} byte limit`); return this.bytes.slice(); }
}
/**
 * A lazy deterministic byte source that never holds more than one chunk:
 * byte[i] = (i * 31 + 7) & 0xff, so any window is a slice of a 256-periodic
 * template. Each read allocates a fresh chunk, like a real host range reader.
 */
class PatternReader {
  static template = Uint8Array.from({ length: (1 << 20) + 256 }, (_, index) => ((index * 31) + 7) & 0xff);
  constructor(total, { onRead = () => {} } = {}) { this.total = total; this.calls = []; this.wholeReads = 0; this.onRead = onRead; }
  size() { return this.total; }
  readRange(port, offset, maxBytes) {
    assert.equal(port, INPUT_PORT);
    const length = Math.max(0, Math.min(maxBytes, this.total - offset));
    assert.ok(length <= PatternReader.template.byteLength - 256, "test reader only serves chunks up to 1 MiB");
    const start = offset % 256;
    const chunk = PatternReader.template.slice(start, start + length);
    this.calls.push({ offset, maxBytes, length });
    return observed(this.onRead(chunk, this.calls.length), chunk);
  }
  read() { this.wholeReads += 1; throw new Error("whole-document read must not be used for streaming input"); }
}

function harness({ input, reader, cancellation = new CancellationToken(), limits = defaultLimits() } = {}) {
  const source = reader ?? new MemoryReader().insert(INPUT_PORT, input ?? new Uint8Array());
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(source, outputs, cancellation, new FixedClock(CLOCK), new SeededRandom(1), new MemorySecrets(), limits);
  return { reader: source, outputs, cancellation, context };
}
const request = (options = {}, overrides = {}) => ({ pluginId: manifest.id, toolId: OPERATION_ID, operationId: OPERATION_ID, options, ...overrides });
async function run(input, options = {}, extra = {}) {
  const parts = harness({ input, ...extra });
  const before = parts.reader instanceof MemoryReader ? parts.reader.inputs.get(INPUT_PORT).slice() : null;
  const result = await execute(request(options), parts.context);
  if (before) assert.deepEqual(parts.reader.inputs.get(INPUT_PORT), before, "source bytes must remain immutable");
  return { ...parts, result };
}
/** Every port carries a complete, well-formed value, text artifact and returned result. */
function expectComplete({ outputs, result }, inputBytes, presentationCase = "lower") {
  assert.deepEqual([...outputs.values.keys()], ids, "values are emitted for all six ports in manifest order");
  assert.deepEqual([...outputs.bytes.keys()], ids, "text artifacts are emitted for all six ports");
  assert.deepEqual(Object.keys(result), ids, "returned results follow manifest order");
  const charset = presentationCase === "upper" ? /^[0-9A-F]+$/u : /^[0-9a-f]+$/u;
  for (const { id, algorithm, hexLength } of ALGORITHMS) {
    const value = outputs.values.get(id);
    assert.deepEqual(Object.keys(value), VALUE_KEYS, `${id} value has exactly the documented fields`);
    assert.equal(value.algorithm, algorithm);
    assert.equal(value.digest.length, hexLength, `${id} digest length`);
    assert.match(value.digest, charset, `${id} digest charset for ${presentationCase} case`);
    assert.equal(value.case, presentationCase);
    assert.equal(value.source, INPUT_PORT);
    assert.equal(value.inputBytes, inputBytes);
    assert.equal(value.encoding, "hex");
    assert.equal(value.complete, true);
    assert.equal(decoder.decode(outputs.bytes.get(id)), value.digest, `${id} text artifact is the digest`);
    assert.equal(outputs.artifacts.get(id).byteLength, hexLength, `${id} artifact byte length`);
    assert.deepEqual(result[id], value, `${id} returned value matches the emitted value`);
  }
}
const digestsOf = (outputs) => Object.fromEntries(ids.map((id) => [id, outputs.values.get(id).digest]));
async function rejects(promise, pattern) {
  const error = await promise.then(() => null, (thrown) => thrown);
  assert.ok(error instanceof Error, "expected an Error");
  assert.ok(!(error instanceof ProcessorCancelled), "diagnostics must not be reported as cancellation");
  assert.match(error.message, pattern);
  return error;
}

/* ------------------------------------------------------------------ package shape */

test("manifest, processor and README agree on exactly six algorithms; MD2/MD4 are not placeholder outputs", () => {
  assert.deepEqual(ids, ["md5", "sha1", "sha224", "sha256", "sha384", "sha512"]);
  assert.deepEqual(operation.outputs.map((item) => item.id), ids, "manifest output ports match processor order");
  assert.deepEqual(operation.inputs.map((item) => item.id), [INPUT_PORT]);
  assert.deepEqual(manifest.workspaces[0].bindings.filter((item) => item.outputPort).map((item) => item.outputPort), ids);
  for (const forbidden of ["md2", "md4"]) {
    assert.ok(!ids.includes(forbidden), `${forbidden} must not be an output`);
    assert.ok(!operation.outputs.some((item) => item.id === forbidden), `${forbidden} must not be in the manifest`);
  }
  assert.deepEqual(operation.options.map((item) => item.id), ["case"]);
  assert.deepEqual(operation.options[0].choices.map((item) => item.id), [...CASES]);
  assert.equal(operation.options[0].default, "lower");
  assert.match(readme, /MD2 and MD4/u, "README explains the omission");
  assert.match(readme, /legacy provider|ERR_OSSL_EVP_UNSUPPORTED/u, "README names the concrete runtime reason");
  for (const fixture of ["hash-vectors", "hash-bytes", "hash-streaming", "hash-cancellation", "hash-limits", "hash-options"]) {
    assert.ok(manifest.tests.fixtures.includes(fixture), `manifest declares ${fixture}`);
  }
});

test("runtime evidence: the bundled Node/OpenSSL provider does not offer MD2 or MD4", () => {
  const available = getHashes();
  for (const name of ["md2", "md4"]) {
    assert.ok(!available.includes(name), `${name} is listed by getHashes(); revisit the README omission before adding it`);
    assert.throws(() => createHash(name), `${name} can be constructed; revisit the README omission before adding it`);
  }
  for (const { id } of ALGORITHMS) assert.doesNotThrow(() => createHash(id), `${id} is provided by the runtime`);
});

/* ------------------------------------------------------------------ published vectors */

for (const vector of published) {
  test(`published vector: ${vector.name} (${vector.source})`, async () => {
    const bytes = materialize(vector);
    const expectedIds = Object.keys(vector.digests);
    assert.ok(expectedIds.length > 0 && expectedIds.every((id) => byId.has(id)), "fixture names only supported algorithms");
    const single = await run(bytes);
    expectComplete(single, bytes.byteLength);
    for (const [id, digest] of Object.entries(vector.digests)) {
      assert.equal(single.outputs.values.get(id).digest, digest, `${vector.name}:${id}`);
      assert.equal(decoder.decode(single.outputs.bytes.get(id)), digest, `${vector.name}:${id} text`);
    }
    // The same bytes through prime-sized chunks that never align with 64/128-byte blocks.
    const reader = new RangeReader(bytes, { serve: 4093 });
    const chunked = await run(undefined, {}, { reader });
    expectComplete(chunked, bytes.byteLength);
    assert.deepEqual(digestsOf(chunked.outputs), digestsOf(single.outputs), `${vector.name} is chunk-boundary independent`);
    assert.equal(reader.calls.length, Math.ceil(bytes.byteLength / 4093), "one range read per chunk");
    assert.ok(reader.calls.every((call) => call.length <= 4093), "no chunk exceeds the requested size");
  });
}

test("published coverage: every algorithm has the empty message, a multi-block message and at least three vectors; the SHA family has a 1,000,000-byte message", () => {
  const blockSize = { md5: 64, sha1: 64, sha224: 64, sha256: 64, sha384: 128, sha512: 128 };
  for (const id of ids) {
    const covering = published.filter((vector) => vector.digests[id] !== undefined);
    const lengths = covering.map((vector) => materialize(vector).byteLength);
    assert.ok(covering.length >= 3, `${id} has ${covering.length} published vectors`);
    assert.ok(lengths.includes(0), `${id} covers the empty message`);
    assert.ok(lengths.some((length) => length > blockSize[id]), `${id} covers a message longer than one ${blockSize[id]}-byte block`);
    // RFC 1321 publishes no million-byte MD5 vector; MD5 streaming is covered by the 64 MiB test below instead.
    if (id !== "md5") assert.ok(lengths.some((length) => length >= 1000000), `${id} covers a 1,000,000-byte message`);
  }
});

/* ------------------------------------------------------------------ byte identity */

for (const vector of byteVectors) {
  test(`byte identity: ${vector.name} — ${vector.note}`, async () => {
    const bytes = fromHex(vector.hex);
    assert.equal(bytes.byteLength, vector.byteLength, "fixture byteLength matches its hex");
    const whole = await run(bytes);
    expectComplete(whole, bytes.byteLength);
    assert.deepEqual(digestsOf(whole.outputs), vector.digests, `${vector.name} pinned digests`);
    for (const chunkBytes of [1, 3]) {
      const reader = new RangeReader(bytes, { serve: chunkBytes });
      const chunked = await run(undefined, {}, { reader });
      assert.deepEqual(digestsOf(chunked.outputs), vector.digests, `${vector.name} with ${chunkBytes}-byte chunks`);
      assert.equal(reader.calls.length, Math.ceil(bytes.byteLength / chunkBytes));
    }
    if (vector.text !== undefined) {
      assert.deepEqual(encoder.encode(vector.text), bytes, "text form encodes to the fixture bytes");
      assert.deepEqual(digestsOf((await run(vector.text)).outputs), vector.digests, "string input is hashed as UTF-8 bytes");
    }
  });
}

test("no normalization: newline style, Unicode form, byte order mark and NUL position all change the digest", () => {
  const pairs = [["crlf", "lf"], ["crlf", "cr"], ["lf", "cr"], ["unicode-nfc-e-acute", "unicode-nfd-e-acute"], ["utf8-bom-abc", "ascii-abc"], ["nul-inside", "nul-trailing"], ["crlf", "trailing-crlf"]];
  for (const [left, right] of pairs) {
    for (const id of ids) assert.notEqual(byteVector(left).digests[id], byteVector(right).digests[id], `${left} vs ${right} (${id})`);
  }
  assert.equal(byteVector("unicode-mixed").byteLength, 18, "Hello, 世界 🌍 is 18 UTF-8 bytes, not 12 UTF-16 code units");
  assert.equal(byteVector("all-256-byte-values").byteLength, 256);
});

test("reader capabilities do not change results: range reader, size-less stream and whole-document fallback agree", async () => {
  const bytes = fromHex(byteVector("all-256-byte-values").hex);
  const expected = byteVector("all-256-byte-values").digests;
  const ranged = new RangeReader(bytes, { serve: 100 });
  const stream = new RangeReader(bytes, { size: false, serve: 100 });
  const whole = new WholeReader(bytes);
  for (const reader of [ranged, stream, whole]) {
    const outcome = await run(undefined, {}, { reader });
    expectComplete(outcome, 256);
    assert.deepEqual(digestsOf(outcome.outputs), expected, reader.constructor.name);
  }
  assert.equal(ranged.wholeReads, 0, "range reader never falls back to a whole read");
  assert.equal(ranged.size !== undefined && stream.size === undefined, true);
  assert.equal(stream.calls.length, 4, "size-less stream reads until an empty chunk (3 data chunks plus EOF)");
  assert.equal(whole.wholeReads, 1, "fallback path performs exactly one bounded read");
});

/* ------------------------------------------------------------------ streaming within declared limits */

test("streaming 64 MiB at the declared limits keeps live memory bounded and never materializes the input", { timeout: 120000 }, async () => {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc");
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const settle = async () => { gc(); await tick(); gc(); await tick(); return process.memoryUsage(); };

  assert.equal(declaredLimits.maxInputBytes, 64 * 1024 * 1024, "manifest declares a 64 MiB input limit");
  assert.equal(declaredLimits.maxChunkBytes, 1024 * 1024, "manifest declares 1 MiB chunks");
  const total = declaredLimits.maxInputBytes;
  const reference = ALGORITHMS.map(({ id }) => createHash(id));
  const samples = [];
  const baseline = await settle();
  const reader = new PatternReader(total, {
    onRead: async (chunk, count) => {
      for (const hasher of reference) hasher.update(chunk);
      if (count % 8 === 0) { const usage = await settle(); samples.push({ count, arrayBuffers: usage.arrayBuffers, heapUsed: usage.heapUsed }); }
    }
  });
  const started = performance.now();
  const outcome = await run(undefined, {}, { reader, limits: declaredLimits });
  const elapsedMs = performance.now() - started;
  expectComplete(outcome, total);

  assert.equal(reader.wholeReads, 0, "the whole document is never read at once");
  assert.equal(reader.calls.length, total / declaredLimits.maxChunkBytes, "exactly one range read per declared chunk");
  assert.ok(reader.calls.every((call) => call.maxBytes <= declaredLimits.maxChunkBytes), "the SDK never requests more than maxChunkBytes");
  assert.ok(reader.calls.every((call) => call.length <= declaredLimits.maxChunkBytes), "no served chunk exceeds maxChunkBytes");
  assert.equal(reader.calls.reduce((sum, call) => sum + call.length, 0), total, "every byte is read exactly once");
  assert.ok(reader.calls.every((call, index) => call.offset === index * declaredLimits.maxChunkBytes), "reads are sequential and contiguous");
  for (const [index, { id }] of ALGORITHMS.entries()) {
    assert.equal(outcome.outputs.values.get(id).digest, reference[index].digest("hex"), `${id} over the streamed bytes`);
  }

  const peakArrayBuffers = Math.max(...samples.map((sample) => sample.arrayBuffers)) - baseline.arrayBuffers;
  const peakHeap = Math.max(...samples.map((sample) => sample.heapUsed)) - baseline.heapUsed;
  const budget = 4 * declaredLimits.maxChunkBytes;
  assert.ok(samples.length >= 8, "memory was sampled during the stream");
  assert.ok(peakArrayBuffers < budget, `live ArrayBuffer growth ${peakArrayBuffers} bytes must stay under ${budget} (input is ${total})`);
  assert.ok(peakHeap < 16 * 1024 * 1024, `live heap growth ${peakHeap} bytes must stay far below the 64 MiB input`);
  console.log(`hash streaming evidence: ${total} bytes in ${reader.calls.length} chunks, ${elapsedMs.toFixed(0)} ms, peak live ArrayBuffer growth ${(peakArrayBuffers / 1024).toFixed(0)} KiB, peak heap growth ${(peakHeap / 1024).toFixed(0)} KiB (budget ${(budget / 1024).toFixed(0)} KiB)`);
});

/* ------------------------------------------------------------------ cancellation */

test("cancellation during a multi-chunk read stops reading and emits no outputs", async () => {
  const bytes = fromHex(byteVector("all-256-byte-values").hex);
  const cancellation = new CancellationToken();
  const reader = new RangeReader(bytes, { serve: 16, onRead: (_chunk, count) => { if (count === 3) cancellation.cancel(); } });
  const parts = harness({ reader, cancellation });
  const error = await execute(request(), parts.context).then(() => null, (thrown) => thrown);
  assert.ok(error instanceof ProcessorCancelled, "the SDK cancellation error is propagated unchanged");
  assert.equal(error.name, "ProcessorCancelled");
  assert.equal(reader.calls.length, 3, "reading stops at the first check after cancellation (16 chunks were available)");
  assert.equal(parts.outputs.values.size, 0, "no values are emitted");
  assert.equal(parts.outputs.bytes.size, 0, "no text artifacts are emitted");
  assert.equal(parts.outputs.artifacts.size, 0);
});

test("cancellation after the final chunk but before emission still emits nothing", async () => {
  const bytes = fromHex(byteVector("all-256-byte-values").hex);
  const cancellation = new CancellationToken();
  const reader = new RangeReader(bytes, { serve: 16, onRead: (_chunk, count) => { if (count === 16) cancellation.cancel(); } });
  const parts = harness({ reader, cancellation });
  await assert.rejects(() => execute(request(), parts.context), ProcessorCancelled);
  assert.equal(reader.calls.length, 16, "the whole input was read");
  assert.equal(parts.outputs.values.size + parts.outputs.bytes.size, 0, "partial digests are never published");
});

test("a job cancelled before it starts performs no reads", async () => {
  const cancellation = new CancellationToken(); cancellation.cancel();
  const reader = new RangeReader(new Uint8Array(64));
  const parts = harness({ reader, cancellation });
  await assert.rejects(() => execute(request(), parts.context), ProcessorCancelled);
  assert.equal(reader.calls.length, 0);
  assert.equal(parts.outputs.values.size, 0);
});

/* ------------------------------------------------------------------ presentation case */

test("uppercase presentation changes only the digest text; every other field and the bytes hashed are identical", async () => {
  const vector = byteVector("unicode-mixed");
  const bytes = fromHex(vector.hex);
  const lower = await run(bytes, { case: "lower" });
  const upper = await run(bytes, { case: "upper" });
  expectComplete(lower, bytes.byteLength, "lower");
  expectComplete(upper, bytes.byteLength, "upper");
  for (const id of ids) {
    const low = lower.outputs.values.get(id);
    const high = upper.outputs.values.get(id);
    assert.equal(low.digest, vector.digests[id]);
    assert.equal(high.digest, vector.digests[id].toUpperCase());
    assert.equal(high.digest.toLowerCase(), low.digest, `${id} upper is a pure re-encoding of lower`);
    const { digest: _l, case: _lc, ...lowRest } = low;
    const { digest: _h, case: _hc, ...highRest } = high;
    assert.deepEqual(highRest, lowRest, `${id} non-presentation fields are unchanged`);
    assert.equal(upper.outputs.artifacts.get(id).byteLength, lower.outputs.artifacts.get(id).byteLength);
  }
  const implicit = await run(bytes);
  assert.deepEqual(digestsOf(implicit.outputs), digestsOf(lower.outputs), "the default case is lower");
  assert.deepEqual(digestsOf((await run(bytes, { case: null })).outputs), digestsOf(lower.outputs), "a null case falls back to the default");
});

/* ------------------------------------------------------------------ invalid options and requests */

test("normalizeOptions accepts only the documented shape", () => {
  for (const options of [undefined, null, {}, { case: undefined }, { case: null }]) assert.deepEqual(normalizeOptions(options), { case: "lower" });
  assert.deepEqual(normalizeOptions({ case: "upper" }), { case: "upper" });
  assert.throws(() => normalizeOptions({ case: "mixed" }), /case must be "lower" or "upper", received "mixed"/u);
  assert.throws(() => normalizeOptions({ case: "LOWER" }), /received "LOWER"/u);
  assert.throws(() => normalizeOptions({ case: 1 }), /received 1$/u);
  assert.throws(() => normalizeOptions({ case: true }), /received true$/u);
  assert.throws(() => normalizeOptions({ case: ["upper"] }), /received \["upper"\]/u);
  assert.throws(() => normalizeOptions({ Case: "upper" }), /unknown option "Case"; encoding\.hash accepts only "case"/u);
  assert.throws(() => normalizeOptions({ casing: "x", algorithm: "md4" }), /unknown options "casing", "algorithm"/u);
  assert.throws(() => normalizeOptions([]), /options must be a JSON object, received \[\]/u);
  assert.throws(() => normalizeOptions("upper"), /options must be a JSON object, received "upper"/u);
  assert.throws(() => normalizeOptions(7), /received 7$/u);
});

test("invalid options and requests are rejected before any input is read and nothing is emitted", async () => {
  const cases = [
    [request({ case: "mixed" }), /case must be "lower" or "upper", received "mixed"/u],
    [request({ Case: "upper" }), /unknown option "Case"/u],
    [request([]), /options must be a JSON object/u],
    [request({}, { operationId: "encoding.md4" }), /unsupported operation "encoding\.md4"; this package provides only "encoding\.hash"/u],
    [5, /request must be an object, received 5/u],
    [["encoding.hash"], /request must be an object/u]
  ];
  for (const [badRequest, pattern] of cases) {
    const reader = new RangeReader(new Uint8Array(64));
    const parts = harness({ reader });
    await rejects(execute(badRequest, parts.context), pattern);
    assert.equal(reader.calls.length + reader.wholeReads, 0, `no read for ${JSON.stringify(badRequest)}`);
    assert.equal(parts.outputs.values.size + parts.outputs.bytes.size, 0);
  }
  await assert.doesNotReject(() => execute(undefined, harness({ input: "abc" }).context), "an absent request uses defaults");
  await assert.doesNotReject(() => execute({ options: {} }, harness({ input: "abc" }).context), "operationId is optional for direct SDK callers");
});

test("a missing named input port is reported by name", async () => {
  const parts = harness({ reader: new MemoryReader() });
  await rejects(execute(request(), parts.context), /encoding\.hash requires the named input port "input"/u);
  assert.equal(parts.outputs.values.size, 0);
});

/* ------------------------------------------------------------------ oversized input */

test("oversized input with a known size is rejected before any byte is read, naming both sizes", async () => {
  const limits = withInputLimit(16);
  const reader = new RangeReader(new Uint8Array(17));
  const parts = harness({ reader, limits });
  const error = await rejects(execute(request(), parts.context), /^input is 17 bytes, which exceeds the 16-byte limit declared for encoding\.hash; no digest was produced$/u);
  assert.ok(error.cause instanceof Error, "the SDK error is preserved as cause");
  assert.equal(reader.calls.length, 0, "nothing is read");
  assert.equal(parts.outputs.values.size, 0);
  const exact = await run(undefined, {}, { reader: new RangeReader(new Uint8Array(16)), limits });
  expectComplete(exact, 16);
});

test("one byte over the declared 64 MiB limit is rejected without reading", async () => {
  const reader = new PatternReader(declaredLimits.maxInputBytes + 1);
  const parts = harness({ reader, limits: declaredLimits });
  await rejects(execute(request(), parts.context), /input is 67108865 bytes, which exceeds the 67108864-byte limit/u);
  assert.equal(reader.calls.length, 0);
});

test("a size-less stream that overruns the limit is rejected, whether or not it honors a zero-byte request", async () => {
  const limits = withInputLimit(16);
  const honoring = new RangeReader(new Uint8Array(20), { size: false, serve: 4 });
  await rejects(execute(request(), harness({ reader: honoring, limits }).context), /input is larger than 16 bytes, which exceeds the 16-byte limit/u);
  assert.ok(honoring.calls.length <= 6, `reading stops at the limit (${honoring.calls.length} calls)`);
  const ignoring = new RangeReader(new Uint8Array(20), { size: false, serve: 4, honorZero: false });
  await rejects(execute(request(), harness({ reader: ignoring, limits }).context), /input is larger than 16 bytes, which exceeds the 16-byte limit/u);
  const exact = await run(undefined, {}, { reader: new RangeReader(new Uint8Array(16), { size: false, serve: 4 }), limits });
  expectComplete(exact, 16);
  const whole = new WholeReader(new Uint8Array(17));
  await rejects(execute(request(), harness({ reader: whole, limits }).context), /which exceeds the 16-byte limit/u);
});

test("the SDK default limits (16 MiB) are stricter than the manifest; the processor honors whichever it is given", async () => {
  assert.ok(defaultLimits().maxInputBytes < declaredLimits.maxInputBytes);
  const reader = new PatternReader(defaultLimits().maxInputBytes + 1);
  await rejects(execute(request(), harness({ reader }).context), /exceeds the 16777216-byte limit/u);
  assert.equal(reader.calls.length, 0);
});
