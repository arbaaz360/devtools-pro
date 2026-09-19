import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorCancelled, ProcessorContext, SeededRandom, defaultLimits } from "../../packages/plugin-sdk/src/index.ts";
import { BRACKET_SEMANTICS, PACKAGE_LIMITS, execute, utf8InvalidOffset } from "./processor.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
const operation = (id) => manifest.operations.find((item) => item.id === id);
/** The manifest stores limits as decimal strings; the SDK context takes numbers. */
const manifestLimits = (operationId) => Object.fromEntries(Object.entries(operation(operationId).limits).map(([key, value]) => [key, Number(value)]));
const hexBytes = (hex) => Uint8Array.from(hex.match(/../gu), (pair) => Number.parseInt(pair, 16));
const inputOf = (vector) => (vector.inputHex ? hexBytes(vector.inputHex) : vector.input);

function makeContext(input, { limits, cancellation = new CancellationToken() } = {}) {
  const reader = new MemoryReader().insert("input", input);
  const source = reader.inputs.get("input").slice();
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(reader, outputs, cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), limits);
  return { reader, source, outputs, context };
}

async function run(operationId, options, input, settings) {
  const { reader, source, outputs, context } = makeContext(input, settings);
  const returned = await execute({ operationId, options }, context);
  assert.deepEqual(reader.inputs.get("input"), source, "source bytes must remain immutable");
  const bytes = outputs.bytes.get("output");
  const value = outputs.values.get("output");
  assert.equal(returned, value, "execute returns the emitted structured value");
  assert.equal(value.complete, true);
  assert.equal(value.outputBytes, bytes.byteLength);
  assert.equal(value.inputBytes, source.byteLength);
  return { text: decoder.decode(bytes), value, artifact: outputs.artifacts.get("output") };
}

async function rejects(operationId, options, input, expected, settings) {
  const { outputs, context } = makeContext(input, settings);
  await assert.rejects(() => execute({ operationId, options }, context), expected);
  assert.equal(outputs.bytes.size, 0, "a failed run writes no artifact");
  assert.equal(outputs.values.size, 0, "a failed run writes no value");
}

// --- deterministic fixtures -------------------------------------------------

for (const vector of await fixture("transform")) {
  test(`transform fixture: ${vector.name}`, async () => {
    const result = await run("url.transform", vector.options, vector.input);
    assert.equal(result.text, vector.output);
    assert.equal(result.value.text, vector.output);
    assert.equal(result.value.mode, vector.options.mode);
    assert.equal(result.value.encoding, vector.options.encoding);
    if (vector.roundTrip) assert.equal((await run("url.transform", { mode: "decode", encoding: vector.options.encoding }, vector.output)).text, vector.input);
  });
}

for (const vector of await fixture("parse-query")) {
  test(`parse fixture: ${vector.name}`, async () => {
    const result = await run("url.parse-query", vector.options, vector.input);
    assert.equal(result.text, vector.output);
    for (const [key, expected] of Object.entries(vector.value)) assert.deepEqual(result.value[key], expected, `value.${key}`);
    assert.deepEqual(JSON.parse(result.text), result.value.parameters, "text artifact and structured parameters agree");
    assert.equal(result.value.bracketSemantics, BRACKET_SEMANTICS);
    assert.deepEqual(result.value.limits, PACKAGE_LIMITS);
  });
}

for (const vector of await fixture("invalid")) {
  test(`invalid fixture: ${vector.name}`, async () => {
    await rejects(vector.operationId, vector.options, inputOf(vector), (error) => {
      assert.ok(error instanceof Error && !(error instanceof ProcessorCancelled));
      assert.ok(error.message.includes(vector.error), `expected "${error.message}" to include "${vector.error}"`);
      return true;
    });
  });
}

// --- manifest agreement -----------------------------------------------------

test("package limits and option ranges match the manifest", () => {
  const parse = operation("url.parse-query");
  assert.equal(Number(parse.limits.maxRows), PACKAGE_LIMITS.maxRows);
  assert.equal(Number(parse.limits.maxNodes), PACKAGE_LIMITS.maxNodes);
  const indent = parse.options.find((option) => option.id === "indent");
  assert.deepEqual([indent.default, indent.minimum, indent.maximum], ["2", "0", "8"]);
  const transform = operation("url.transform");
  assert.deepEqual(transform.options.find((option) => option.id === "mode").choices.map((choice) => choice.id), ["encode", "decode"]);
  assert.deepEqual(transform.options.find((option) => option.id === "encoding").choices.map((choice) => choice.id), ["rfc3986", "form"]);
  assert.deepEqual(manifest.tests.fixtures, ["transform", "parse-query", "invalid"]);
});

test("option defaults are encode, rfc3986 and indent 2; the operation defaults to transform", async () => {
  assert.equal((await run("url.transform", {}, "a b")).text, "a%20b");
  assert.equal((await run(undefined, undefined, "a b")).text, "a%20b");
  assert.equal((await run("url.parse-query", {}, "a=1")).text, "{\n  \"a\": \"1\"\n}");
});

// --- decoding is single-pass and delimiter-preserving -------------------------

test("decoding never re-scans its own output", async () => {
  assert.equal((await run("url.transform", { mode: "decode", encoding: "rfc3986" }, "%2525%2520%252B")).text, "%25%20%2B");
  assert.equal((await run("url.transform", { mode: "decode", encoding: "form" }, "%252B%2B+")).text, "%2B+ ");
  const nested = await run("url.parse-query", { indent: 0 }, "a=%2526b%253Dc");
  assert.deepEqual(nested.value.parameters, { a: "%26b%3Dc" });
  assert.equal(nested.value.counts.parameters, 1);
});

test("transform never trims, parse trims only ASCII whitespace at the ends", async () => {
  assert.equal((await run("url.transform", { mode: "encode" }, " a \n")).text, "%20a%20%0A");
  assert.equal((await run("url.transform", { mode: "decode" }, "%20 ")).text, "  ");
  const parsed = await run("url.parse-query", { indent: 0 }, "\t a=1 b \r\n");
  assert.deepEqual(parsed.value.parameters, { a: "1 b" });
  assert.equal(parsed.value.trimmedBytes, 5);
  const nbsp = await run("url.parse-query", { indent: 0 }, " a=1");
  assert.deepEqual(parsed.value.counts.parameters, 1);
  assert.deepEqual(nbsp.value.parameters, { " a": "1" });
});

test("entries keep exact encounter order even when the object hoists integer-like names", async () => {
  const result = await run("url.parse-query", { indent: 0 }, "z=1&10=a&2=b&z=2");
  assert.deepEqual(result.value.entries.map((entry) => entry.key), ["z", "10", "2", "z"]);
  assert.equal(result.text, "{\"z\":[\"1\",\"2\"],\"10\":\"a\",\"2\":\"b\"}");
  assert.deepEqual(Object.keys(result.value.parameters), ["2", "10", "z"]);
});

test("prototype names become own properties of the structured parameters", async () => {
  const result = await run("url.parse-query", { indent: 0 }, "__proto__=1&toString=2");
  assert.ok(Object.hasOwn(result.value.parameters, "__proto__"));
  assert.ok(Object.hasOwn(result.value.parameters, "toString"));
  assert.equal(Object.getPrototypeOf(result.value.parameters), Object.prototype);
  assert.equal(result.value.parameters.toString, "2");
});

test("text output matches JSON.stringify whenever no name is integer-like", async () => {
  for (const indent of [0, 1, 2, 8]) {
    const result = await run("url.parse-query", { indent }, "a=1&a=2&b=&c[]=x&d=\"q\\\n");
    assert.equal(result.text, JSON.stringify(result.value.parameters, null, indent));
  }
});

// --- limits -----------------------------------------------------------------

test("input limit: exactly the manifest maximum is accepted, one more byte is rejected", async () => {
  const limits = { ...defaultLimits(), ...manifestLimits("url.transform") };
  const full = "a".repeat(limits.maxInputBytes);
  assert.equal((await run("url.transform", { mode: "encode" }, full, { limits })).value.outputBytes, limits.maxInputBytes);
  await rejects("url.transform", { mode: "encode" }, `${full}a`, /exceeds/u, { limits });
  const parseLimits = { ...defaultLimits(), ...manifestLimits("url.parse-query") };
  await rejects("url.parse-query", {}, `a=${"b".repeat(parseLimits.maxInputBytes - 1)}`, /exceeds/u, { limits: parseLimits });
});

test("output limit is checked before anything is written, with the size in the message", async () => {
  const limits = { ...defaultLimits(), maxOutputBytes: 10 };
  await rejects("url.transform", { mode: "encode" }, "    ", /output of 12 bytes exceeds the 10 byte output limit/u, { limits });
  await rejects("url.parse-query", { indent: 0 }, "abc=def", /output of 13 bytes exceeds the 10 byte output limit/u, { limits });
  assert.equal((await run("url.transform", { mode: "encode" }, "   ", { limits })).text, "%20%20%20");
  const chunk = { ...defaultLimits(), maxChunkBytes: 4 };
  await rejects("url.transform", { mode: "decode" }, "12345", /output of 5 bytes exceeds the 4 byte chunk limit/u, { limits: chunk });
});

test("encoding stays within the manifest output limit at the worst-case 3:1 expansion", async () => {
  const limits = { ...defaultLimits(), ...manifestLimits("url.transform") };
  const result = await run("url.transform", { mode: "encode", encoding: "rfc3986" }, " ".repeat(limits.maxInputBytes), { limits });
  assert.equal(result.value.outputBytes, limits.maxInputBytes * 3);
  assert.ok(result.value.outputBytes <= limits.maxOutputBytes);
});

test("row limit counts non-empty segments and rejects before decoding the excess", async () => {
  const limits = { ...defaultLimits(), maxRows: 2 };
  assert.equal((await run("url.parse-query", { indent: 0 }, "a=1&&b=2&", { limits })).value.counts.parameters, 2);
  await rejects("url.parse-query", {}, "a=1&b=2&c=%zz", /query has more than 2 parameters \(row limit\)/u, { limits });
  const stringLimits = { ...defaultLimits(), maxRows: "1" };
  await rejects("url.parse-query", {}, "a=1&b=2", /more than 1 parameters/u, { limits: stringLimits });
  await rejects("url.parse-query", {}, "a=1", /maxRows limit must be a non-negative integer/u, { limits: { ...defaultLimits(), maxRows: -1 } });
});

test("row limit defaults to the manifest value when the host supplies none", async () => {
  const atLimit = Array.from({ length: PACKAGE_LIMITS.maxRows }, (_, index) => `k${index}`).join("&");
  const result = await run("url.parse-query", { indent: 0 }, atLimit);
  assert.equal(result.value.counts.parameters, PACKAGE_LIMITS.maxRows);
  assert.equal(result.value.counts.nodes, PACKAGE_LIMITS.maxRows);
  await rejects("url.parse-query", {}, `${atLimit}&extra`, new RegExp(`more than ${PACKAGE_LIMITS.maxRows} parameters`, "u"));
});

test("node limit counts properties plus array elements", async () => {
  const limits = { ...defaultLimits(), maxNodes: 3 };
  assert.equal((await run("url.parse-query", { indent: 0 }, "a=1&b=2&c=3", { limits })).value.counts.nodes, 3);
  assert.equal((await run("url.parse-query", { indent: 0 }, "a=1&a=2", { limits })).value.counts.nodes, 3);
  await rejects("url.parse-query", {}, "a[]=1&b[]=2", /parameter tree has more than 3 nodes \(node limit\)/u, { limits });
  await rejects("url.parse-query", {}, "a=1&a=2&a=3", /more than 3 nodes/u, { limits });
  await rejects("url.parse-query", {}, "a=1&b=2&c=3&d=4", /more than 3 nodes/u, { limits });
});

test("node limit defaults to the manifest value: every row as a distinct array reaches it exactly", async () => {
  const input = Array.from({ length: PACKAGE_LIMITS.maxRows }, (_, index) => `k${index}[]=v`).join("&");
  const result = await run("url.parse-query", { indent: 0 }, input);
  assert.equal(result.value.counts.nodes, PACKAGE_LIMITS.maxNodes);
  await rejects("url.parse-query", {}, input, /more than 19999 nodes/u, { limits: { ...defaultLimits(), maxNodes: PACKAGE_LIMITS.maxNodes - 1 } });
});

// --- cancellation ----------------------------------------------------------

test("a cancelled token rejects both operations before any output, even for an empty document", async () => {
  for (const operationId of ["url.transform", "url.parse-query"]) for (const input of ["a=1", ""]) {
    const cancellation = new CancellationToken();
    cancellation.cancel();
    await rejects(operationId, {}, input, ProcessorCancelled, { cancellation });
  }
});

test("cancellation is polled during encoding, decoding and parsing, not only at the start", async () => {
  class CountingToken { constructor(after) { this.after = after; this.polls = 0; } isCancelled() { this.polls += 1; return this.polls > this.after; } }
  const cases = [
    ["url.transform", { mode: "encode" }, "é ".repeat(64 * 1024)],
    ["url.transform", { mode: "decode" }, "%C3%A9".repeat(64 * 1024)],
    ["url.parse-query", {}, Array.from({ length: 5000 }, (_, index) => `k${index}=%C3%A9`).join("&")],
  ];
  for (const [operationId, options, input] of cases) {
    const completed = new CountingToken(Number.MAX_SAFE_INTEGER);
    await run(operationId, options, input, { cancellation: completed });
    const cancellation = new CountingToken(Math.floor(completed.polls / 2));
    await rejects(operationId, options, input, ProcessorCancelled, { cancellation });
    assert.ok(cancellation.polls > 4 && cancellation.polls < completed.polls, `${operationId} polls ${cancellation.polls} of ${completed.polls}`);
  }
});

// --- source bytes and determinism ---------------------------------------------

test("reader-owned memory is never written to", async () => {
  const backing = encoder.encode("a=%C3%A9&b=x+y");
  const pristine = backing.slice();
  const reader = { size: () => backing.byteLength, readRange: (_port, offset, max) => backing.subarray(offset, offset + max), read: () => backing };
  for (const [operationId, options] of [["url.transform", { mode: "decode", encoding: "form" }], ["url.transform", { mode: "encode" }], ["url.parse-query", {}]]) {
    const context = new ProcessorContext(reader, new MemoryOutputSink(), new CancellationToken(), new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets());
    await execute({ operationId, options }, context);
    assert.deepEqual(backing, pristine, operationId);
  }
});

test("large inputs are deterministic and round-trip through both encodings under manifest limits", async () => {
  const limits = { ...defaultLimits(), ...manifestLimits("url.transform") };
  const sample = "café & crème brûlée / 100% ~*!'() ?+=#😀\n";
  // 300 KiB encodes to under 1 MiB, so the encoded text still fits the input limit on the way back.
  const large = sample.repeat(Math.ceil((300 * 1024) / encoder.encode(sample).byteLength));
  for (const encoding of ["rfc3986", "form"]) {
    const first = await run("url.transform", { mode: "encode", encoding }, large, { limits });
    const second = await run("url.transform", { mode: "encode", encoding }, large, { limits });
    assert.equal(first.artifact.contentHash, second.artifact.contentHash);
    assert.ok(first.value.outputBytes > 64 * 1024 && first.value.outputBytes <= limits.maxInputBytes);
    assert.equal((await run("url.transform", { mode: "decode", encoding }, first.text, { limits })).text, large);
  }
});

test("inputs are read in bounded chunks and reassembled exactly", async () => {
  const input = encoder.encode("x=".concat("%C3%A9".repeat(50 * 1024)));
  const backing = new MemoryReader().insert("input", input);
  let ranges = 0;
  const reader = { size: (port) => backing.size(port), readRange: (port, offset, max) => { ranges += 1; return backing.readRange(port, offset, max); }, read: (port, max) => backing.read(port, max) };
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(reader, outputs, new CancellationToken(), new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets());
  await execute({ operationId: "url.parse-query", options: { indent: 0 } }, context);
  assert.equal(outputs.values.get("output").parameters.x, "é".repeat(50 * 1024));
  assert.ok(ranges >= Math.floor(input.byteLength / (64 * 1024)), `read in ${ranges} ranges`);
});

// --- UTF-8 validator --------------------------------------------------------

test("UTF-8 validator agrees with the platform decoder on every two-byte sequence and curated longer ones", () => {
  const fatal = new TextDecoder("utf-8", { fatal: true });
  const platformAccepts = (bytes) => { try { fatal.decode(bytes); return true; } catch { return false; } };
  for (let first = 0x80; first < 0x100; first += 1) for (let second = 0; second < 0x100; second += 1) {
    const bytes = Uint8Array.of(first, second);
    assert.equal(utf8InvalidOffset(bytes) < 0, platformAccepts(bytes), `${first.toString(16)} ${second.toString(16)}`);
  }
  const curated = ["e0a080", "e09f80", "ed9fbf", "eda080", "efbfbf", "f0908080", "f08f8080", "f48fbfbf", "f4908080", "f5808080", "c2", "e282", "f09f98", "41", "7f", "c3a9", "e282ac", "f09f9880", "80", "bf", "c0", "c1", "fe", "ff"];
  for (const hex of curated) {
    const bytes = hexBytes(hex);
    assert.equal(utf8InvalidOffset(bytes) < 0, platformAccepts(bytes), hex);
  }
  assert.equal(utf8InvalidOffset(hexBytes("41c3a9ff")), 3);
  assert.equal(utf8InvalidOffset(hexBytes("41e282")), 1);
});
