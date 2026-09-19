import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorCancelled, ProcessorContext, SeededRandom,
} from "../../packages/plugin-sdk/src/context.ts";
import { Base64Error, READ_CHUNK_BYTES, STANDARD_ALPHABET, URL_SAFE_ALPHABET, encodedLength, execute } from "./processor.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const bytesOf = (vector) => vector.bytes === "0..255"
  ? Uint8Array.from({ length: 256 }, (_, index) => index)
  : vector.bytes ? Uint8Array.from(vector.bytes) : encoder.encode(vector.input);

/** Run the processor through the public SDK context only. */
async function run(options, input, { reader, cancellation = new CancellationToken(), limits } = {}) {
  const source = reader ?? new MemoryReader().insert("input", input);
  const before = source instanceof MemoryReader ? source.inputs.get("input").slice() : null;
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(source, outputs, cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), limits);
  const result = await execute({ pluginId: "encoding.base64-text", toolId: "encoding.base64-text", operationId: "encoding.base64-text", options }, context);
  if (before) assert.deepEqual(source.inputs.get("input"), before, "source bytes must be untouched");
  const bytes = outputs.bytes.get("output");
  return { result, value: outputs.values.get("output"), artifact: outputs.artifacts.get("output"), bytes, text: bytes ? decoder.decode(bytes) : undefined, outputs };
}
async function rejects(options, input, code, extra = {}) {
  const outputs = { written: false };
  let caught;
  try {
    const sink = new MemoryOutputSink();
    const context = new ProcessorContext(new MemoryReader().insert("input", input), sink, new CancellationToken(), new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), extra.limits);
    await execute({ options }, context);
    outputs.written = sink.bytes.size > 0 || sink.values.size > 0;
  } catch (error) { caught = error; }
  assert.ok(caught, `expected ${code} for ${JSON.stringify(input)}`);
  assert.ok(caught instanceof Base64Error, `expected Base64Error, got ${caught.name}: ${caught.message}`);
  assert.equal(caught.code, code, caught.message);
  assert.equal(outputs.written, false, "no output may be written on failure");
  return caught;
}
const encode = (input, options = {}) => run({ mode: "encode", ...options }, input);
const decode = (input, options = {}) => run({ mode: "decode", ...options }, input);

test("alphabets are RFC 4648 §4 and §5 exactly", () => {
  assert.equal(STANDARD_ALPHABET, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
  assert.equal(URL_SAFE_ALPHABET, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_");
  assert.equal(new Set(STANDARD_ALPHABET).size, 64);
  assert.equal(new Set(URL_SAFE_ALPHABET).size, 64);
});

test("round trip vectors: ASCII, Unicode, empty, multiline, NUL, padding lengths, BOM, binary", async () => {
  for (const vector of await fixture("base64-roundtrip")) {
    const source = bytesOf(vector);
    const encoded = await encode(source);
    assert.equal(encoded.text, vector.encoded, `${vector.name}: encode`);
    assert.equal(encoded.value.text, vector.encoded);
    assert.deepEqual([encoded.value.inputBytes, encoded.value.outputBytes, encoded.artifact.byteLength], [source.byteLength, vector.encoded.length, vector.encoded.length], vector.name);
    assert.equal(encoded.value.outputBytes, encodedLength(source.byteLength, "required"));
    assert.equal(encoded.value.padded, vector.encoded.endsWith("="));
    assert.equal(encoded.value.contentKind, "text");
    assert.equal(encoded.value.complete, true);
    const decoded = await decode(vector.encoded);
    assert.deepEqual(decoded.bytes, source, `${vector.name}: decoded bytes`);
    assert.equal(decoded.value.contentKind, vector.decoded, `${vector.name}: content kind`);
    assert.equal(decoded.value.utf8, vector.decoded === "text");
    assert.equal(decoded.value.decodedBytes, source.byteLength);
    assert.equal(decoded.value.complete, true);
    if (vector.decoded === "text") {
      assert.equal(decoded.value.text, decoder.decode(source), vector.name);
      assert.equal(decoded.value.mime, "text/plain; charset=utf-8");
    } else {
      assert.equal(decoded.value.text, null, `${vector.name}: binary output has no text`);
      assert.equal(decoded.value.mime, "application/octet-stream");
      assert.match(decoded.value.hexPreview, /^[0-9a-f]{2}( [0-9a-f]{2})*( …)?$/);
    }
  }
});

test("encode is byte-faithful: invalid UTF-8 and CRLF bytes are encoded as they are", async () => {
  const invalid = Uint8Array.from([0x68, 0xff, 0x0d, 0x0a]);
  const encoded = await encode(invalid);
  assert.equal(encoded.text, Buffer.from(invalid).toString("base64"));
  assert.equal(encoded.value.inputBytes, 4);
  assert.deepEqual((await decode(encoded.text)).bytes, invalid);
});

test("standard and URL-safe alphabets differ only at values 62 and 63; each rejects the other", async () => {
  const { alphabets } = await fixture("base64-variants");
  for (const vector of alphabets) {
    const bytes = Uint8Array.from(vector.bytes);
    assert.equal((await encode(bytes, { variant: "standard" })).text, vector.standard, vector.name);
    assert.equal((await encode(bytes, { variant: "url" })).text, vector.url, vector.name);
    assert.equal((await encode(bytes, { variant: "standard", padding: "omit" })).text, vector.standardOmit, vector.name);
    assert.equal((await encode(bytes, { variant: "url", padding: "omit" })).text, vector.urlOmit, vector.name);
    assert.equal((await encode(bytes, { variant: "url", padding: "optional" })).text, vector.url, `${vector.name}: optional pads on encode`);
    assert.deepEqual((await decode(vector.standard, { variant: "standard" })).bytes, bytes);
    assert.deepEqual((await decode(vector.url, { variant: "url" })).bytes, bytes);
    assert.deepEqual((await decode(vector.standardOmit, { variant: "standard", padding: "omit" })).bytes, bytes);
    assert.deepEqual((await decode(vector.urlOmit, { variant: "url", padding: "optional" })).bytes, bytes);
    if (vector.standard !== vector.url) {
      await rejects({ mode: "decode", variant: "url" }, vector.standard, "wrong-alphabet");
      await rejects({ mode: "decode", variant: "standard" }, vector.url, "wrong-alphabet");
    }
  }
});

test("padding policy: required, optional and omit on decode", async () => {
  const { paddingPolicies } = await fixture("base64-variants");
  for (const vector of paddingPolicies) {
    for (const padding of ["required", "optional", "omit"]) {
      const expected = vector[padding];
      if (expected === "ok") {
        const decoded = await decode(vector.input, { padding });
        assert.equal(decoded.text, vector.text, `${vector.name} with ${padding}`);
        assert.equal(decoded.value.paddingCharacters, (vector.input.match(/=/g) ?? []).length);
      } else {
        await rejects({ mode: "decode", padding }, vector.input, expected);
      }
    }
  }
});

test("padding policy on encode: required and optional pad, omit never pads", async () => {
  assert.equal((await encode("f", { padding: "required" })).text, "Zg==");
  assert.equal((await encode("f", { padding: "optional" })).text, "Zg==");
  assert.equal((await encode("f", { padding: "omit" })).text, "Zg");
  assert.equal((await encode("fo", { padding: "omit" })).text, "Zm8");
  assert.equal((await encode("foo", { padding: "omit" })).text, "Zm9v");
  assert.equal((await encode("f", { padding: "omit" })).value.padded, false);
  for (const [bytes, padded, omitted] of [[0, 0, 0], [1, 4, 2], [2, 4, 3], [3, 4, 4], [4, 8, 6], [5, 8, 7], [6, 8, 8]]) {
    assert.equal(encodedLength(bytes, "required"), padded);
    assert.equal(encodedLength(bytes, "omit"), omitted);
  }
});

test("whitespace is rejected by strict and ignored by tolerant and replace, with counts", async () => {
  const { whitespace } = await fixture("base64-variants");
  for (const vector of whitespace) {
    await rejects({ mode: "decode" }, vector.input, "whitespace");
    for (const policy of ["tolerant", "replace"]) {
      const decoded = await decode(vector.input, { "error-policy": policy, padding: "optional" });
      assert.equal(decoded.text, vector.text, `${vector.name} under ${policy}`);
      assert.equal(decoded.value.whitespaceIgnored, vector.ignored, `${vector.name}: ignored count`);
    }
  }
});

test("malformed input diagnostics name the code, position and remedy", async () => {
  for (const vector of await fixture("base64-errors")) {
    const error = await rejects({ mode: "decode", ...vector.options }, vector.input, vector.code);
    assert.equal(error.offset, vector.offset, `${vector.name}: offset`);
    assert.equal(error.line, vector.line, `${vector.name}: line`);
    assert.equal(error.column, vector.column, `${vector.name}: column`);
    assert.match(error.message, new RegExp(vector.message), vector.name);
    assert.match(error.message, /offset \d+ \(line \d+, column \d+\)/, `${vector.name}: position in message`);
  }
});

test("non-canonical trailing bits are accepted only by tolerant and replace, and reported", async () => {
  await rejects({ mode: "decode" }, "//==", "trailing-bits");
  const tolerant = await decode("//==", { "error-policy": "tolerant" });
  assert.deepEqual(tolerant.bytes, Uint8Array.from([0xff]));
  assert.equal(tolerant.value.trailingBitsIgnored, true);
  assert.equal(tolerant.value.contentKind, "binary");
  const canonical = await decode("/w==");
  assert.deepEqual(canonical.bytes, Uint8Array.from([0xff]));
  assert.equal(canonical.value.trailingBitsIgnored, false);
});

test("decoded bytes that are not UTF-8 are labelled binary unless the replace policy asks for text", async () => {
  for (const policy of ["strict", "tolerant"]) {
    const binary = await decode("/v8=", { "error-policy": policy });
    assert.deepEqual(binary.bytes, Uint8Array.from([0xfe, 0xff]), policy);
    assert.equal(binary.value.contentKind, "binary");
    assert.equal(binary.value.mime, "application/octet-stream");
    assert.equal(binary.value.utf8, false);
    assert.equal(binary.value.text, null);
    assert.equal(binary.value.hexPreview, "fe ff");
    assert.equal(binary.artifact.byteLength, 2);
  }
  const replaced = await decode("/v8=", { "error-policy": "replace" });
  assert.equal(replaced.value.contentKind, "text");
  assert.equal(replaced.value.utf8, false);
  assert.equal(replaced.value.replacements, 2);
  assert.equal(replaced.value.text, "��");
  assert.equal(replaced.value.decodedBytes, 2);
  assert.equal(replaced.value.outputBytes, 6, "the replaced text is the artifact");
  assert.deepEqual(replaced.bytes, encoder.encode("��"));
  const mixed = await decode("aGn/IQ==", { "error-policy": "replace" });
  assert.equal(mixed.value.text, "hi�!");
  assert.equal(mixed.value.replacements, 1);
  const valid = await decode("aGk=", { "error-policy": "replace" });
  assert.equal(valid.value.utf8, true);
  assert.equal(valid.value.replacements, undefined);
});

test("hex preview of a long binary payload is bounded", async () => {
  const bytes = Uint8Array.from({ length: 100 }, (_, index) => (index * 7 + 0x80) & 0xff);
  const encodedText = Buffer.from(bytes).toString("base64");
  const decoded = await decode(encodedText);
  assert.equal(decoded.value.contentKind, "binary");
  assert.ok(decoded.value.hexPreview.endsWith(" …"));
  assert.equal(decoded.value.hexPreview.split(" ").length, 33);
  assert.deepEqual(decoded.bytes, bytes);
});

test("options are validated with the manifest ids; errorPolicy alias is accepted", async () => {
  for (const [options, id] of [[{ mode: "hex" }, "mode"], [{ variant: "mime" }, "variant"], [{ padding: "maybe" }, "padding"], [{ "error-policy": "lenient" }, "error-policy"]]) {
    const error = await rejects(options, "abc", "invalid-option");
    assert.equal(error.option, id);
    assert.match(error.message, new RegExp(`^${id} must be one of`));
  }
  assert.equal((await decode(" YWJj", { errorPolicy: "tolerant" })).text, "abc");
  assert.equal((await run({}, "abc")).text, "YWJj", "defaults are encode/standard/required/strict");
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

test("input is streamed in bounded chunks and carries across chunk boundaries in both directions", async () => {
  const source = Uint8Array.from({ length: 1000 }, (_, index) => (index * 31) & 0xff);
  for (const length of [997, 998, 999, 1000]) {
    const bytes = source.subarray(0, length);
    const expected = Buffer.from(bytes).toString("base64");
    const reader = new ChunkedReader(bytes, 5);
    const encoded = await run({ mode: "encode" }, null, { reader });
    assert.equal(encoded.text, expected, `length ${length}`);
    assert.ok(reader.calls >= Math.ceil(length / 5), "reads were chunked");
    const decodeReader = new ChunkedReader(encoder.encode(expected), 7);
    const decoded = await run({ mode: "decode" }, null, { reader: decodeReader });
    assert.deepEqual(decoded.bytes, bytes, `length ${length}: decode`);
  }
});

test("a reader without a size probe still works and stays bounded", async () => {
  const bytes = encoder.encode("streamed without size".repeat(200));
  const encoded = await run({ mode: "encode" }, null, { reader: new ChunkedReader(bytes, 64, { withSize: false }) });
  assert.equal(encoded.text, Buffer.from(bytes).toString("base64"));
  const decoded = await run({ mode: "decode" }, null, { reader: new ChunkedReader(encoder.encode(encoded.text), 64, { withSize: false }) });
  assert.deepEqual(decoded.bytes, bytes);
  const limits = { maxInputBytes: 1 << 20, maxOutputBytes: 64, maxChunkBytes: 64, deadlineMs: 0 };
  await assert.rejects(
    () => run({ mode: "encode" }, null, { reader: new ChunkedReader(bytes, 64, { withSize: false }), limits }),
    (error) => error instanceof Base64Error && error.code === "output-limit" && error.limit === 64,
  );
});

test("cooperative cancellation stops both modes between chunks", async () => {
  for (const mode of ["encode", "decode"]) {
    const cancellation = new CancellationToken();
    const bytes = mode === "encode" ? new Uint8Array(READ_CHUNK_BYTES * 3) : encoder.encode("QUFB".repeat(READ_CHUNK_BYTES));
    const reader = new ChunkedReader(bytes, READ_CHUNK_BYTES, { cancellation });
    await assert.rejects(() => run({ mode }, null, { reader, cancellation }), ProcessorCancelled);
  }
});

test("bounded large input: 768 KiB encodes to exactly the 1 MiB single-artifact cap and round-trips", async () => {
  const random = new SeededRandom(7);
  const source = new Uint8Array(786_432);
  random.fill(source);
  const encoded = await encode(source);
  assert.equal(encoded.artifact.byteLength, 1_048_576);
  assert.equal(encoded.text, Buffer.from(source).toString("base64"), "matches an independent encoder");
  assert.equal(encoded.value.outputBytes, 1_048_576);
  const decoded = await decode(encoded.text);
  assert.deepEqual(decoded.bytes, source);
  assert.equal(decoded.value.contentKind, "binary");
  assert.equal(decoded.value.decodedBytes, 786_432);
  const wrapped = encoded.text.replace(/(.{76})/g, "$1\r\n");
  const tolerant = await decode(wrapped, { "error-policy": "tolerant" });
  assert.deepEqual(tolerant.bytes, source);
  assert.equal(tolerant.value.whitespaceIgnored, wrapped.length - encoded.text.length);
});

test("output limit: one byte over the cap fails before any output is written, with the exact size", async () => {
  const source = new Uint8Array(786_433);
  const error = await rejects({ mode: "encode" }, source, "output-limit");
  assert.equal(error.needed, 1_048_580);
  assert.equal(error.limit, 1_048_576);
  assert.match(error.message, /would produce 1,048,580 bytes, above the 1,048,576 byte output limit/);
  const omitted = await rejects({ mode: "encode", padding: "omit" }, new Uint8Array(786_433), "output-limit");
  assert.equal(omitted.needed, 1_048_578, "omitting padding still needs two characters for the last byte");
  const tooLong = "QUFB".repeat(349_526);
  const decodeError = await rejects({ mode: "decode" }, tooLong, "output-limit");
  assert.equal(decodeError.limit, 1_048_576);
  assert.ok(decodeError.needed > 1_048_576);
});

test("explicit host limits are honoured: output cap is the smaller of maxOutputBytes and maxChunkBytes", async () => {
  const limits = { maxInputBytes: 1024, maxOutputBytes: 64, maxChunkBytes: 32, deadlineMs: 0 };
  const fits = await run({ mode: "encode" }, new Uint8Array(24), { limits });
  assert.equal(fits.artifact.byteLength, 32);
  const error = await rejects({ mode: "encode" }, new Uint8Array(25), "output-limit", { limits });
  assert.equal(error.limit, 32);
  const decodeFits = await run({ mode: "decode" }, "QUFB".repeat(8), { limits });
  assert.equal(decodeFits.artifact.byteLength, 24);
  await rejects({ mode: "decode" }, "QUFB".repeat(11), "output-limit", { limits });
});

test("input limit is enforced by the SDK before any output exists", async () => {
  const limits = { maxInputBytes: 16, maxOutputBytes: 1024, maxChunkBytes: 1024, deadlineMs: 0 };
  const sink = new MemoryOutputSink();
  const context = new ProcessorContext(new MemoryReader().insert("input", new Uint8Array(17)), sink, new CancellationToken(), new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), limits);
  await assert.rejects(() => execute({ options: { mode: "encode" } }, context), /exceeds/);
  assert.equal(sink.bytes.size, 0);
  assert.equal(sink.values.size, 0);
});
