import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorCancelled, ProcessorContext, SeededRandom } from "../../packages/plugin-sdk/src/index.ts";
import { C1_REMAP, LEGACY_MAX_LENGTH, NAMED_REFERENCES, NAME_MAX_LENGTH, PREFERRED_NAMES, TABLE_SHA256 } from "./html-entities.mjs";
import { EscapeError, execute } from "./processor.mjs";

const FIXTURES = [
  "html-escape.json", "html-unescape.json", "html-errors.json",
  "json-string-escape.json", "json-string-unescape.json", "json-string-errors.json",
  "backslash-escape.json", "backslash-unescape.json", "backslash-errors.json",
];
const CLOCK = "2025-01-01T00:00:00Z";

function context(input, { cancellation = new CancellationToken(), limits } = {}) {
  const reader = new MemoryReader().insert("input", input);
  const outputs = new MemoryOutputSink();
  return { reader, outputs, source: reader.inputs.get("input").slice(), context: new ProcessorContext(reader, outputs, cancellation, new FixedClock(CLOCK), new SeededRandom(1), new MemorySecrets(), limits) };
}

async function run(operationId, options, input, extra) {
  const { reader, outputs, source, context: ctx } = context(input, extra);
  const value = await execute({ operationId, options }, ctx);
  assert.deepEqual(reader.inputs.get("input"), source, "source bytes must remain immutable");
  const artifact = outputs.artifacts.get("output");
  const bytes = outputs.bytes.get("output");
  assert.equal(artifact.byteLength, bytes.byteLength);
  assert.equal(value.outputBytes, bytes.byteLength);
  assert.equal(value.complete, true);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert.equal(value.text, text, "properties value must carry the artifact text");
  assert.equal(outputs.values.get("output"), value);
  return { text, value };
}

async function expectError(operationId, options, input, expected) {
  const { reader, source, context: ctx } = context(input);
  await assert.rejects(() => execute({ operationId, options }, ctx), (error) => {
    assert.ok(error instanceof EscapeError, `expected EscapeError, got ${error?.constructor?.name}: ${error?.message}`);
    assert.equal(error.code, expected.code);
    if ("byteOffset" in expected) assert.equal(error.byteOffset, expected.byteOffset, `byte offset in "${error.message}"`);
    if ("line" in expected) assert.equal(error.line, expected.line);
    if ("column" in expected) assert.equal(error.column, expected.column);
    if (error.byteOffset !== null) assert.match(error.message, new RegExp(`at byte offset ${error.byteOffset} \\(line ${error.line}, column ${error.column}\\)`));
    if (expected.match) assert.ok(error.message.includes(expected.match), `expected "${expected.match}" in "${error.message}"`);
    return true;
  });
  assert.deepEqual(reader.inputs.get("input"), source, "source bytes must remain immutable after a rejection");
}

const vectors = new Map();
for (const file of FIXTURES) vectors.set(file, JSON.parse(await readFile(new URL(`./fixtures/${file}`, import.meta.url), "utf8")));

for (const [file, list] of vectors) {
  test(`fixture ${file}`, async (t) => {
    assert.ok(Array.isArray(list) && list.length > 0);
    for (const vector of list) {
      await t.test(vector.name, async () => {
        const input = vector.inputBytes ? Uint8Array.from(vector.inputBytes) : vector.input;
        if (vector.error) { await expectError(vector.operationId, vector.options, input, vector.error); return; }
        const { text, value } = await run(vector.operationId, vector.options, input);
        assert.equal(text, vector.output);
        assert.equal(value.operationId, vector.operationId);
        assert.equal(value.mode, vector.options.mode);
        assert.equal(value.inputBytes, new TextEncoder().encode(vector.input).byteLength);
        for (const [key, expected] of Object.entries(vector.value ?? {})) assert.equal(value[key], expected, `value.${key}`);
      });
    }
  });
}

test("html escape and unescape round trip under every option combination", async () => {
  // Control characters other than tab, LF and CR are escaped to numeric
  // references; HTML5 calls decoding those a parse error, so only permissive
  // unescape can round-trip them. Everything else round-trips strictly.
  const plainSample = `<p class="x">Tom & Jerry's café — ≤ 😀 \u00a0\t\n \u2329 nul\u0000 c1\u0085</p>`;
  const referenceSample = `${plainSample} &amp; &#x1F600;`;
  const controlSample = `esc\u001b del\u007f cr\r`;
  for (const numeric of ["decimal", "hex"]) for (const preferNamed of [true, false]) for (const encodeEverything of [true, false]) for (const allowUnsafeSymbols of [true, false]) {
    const options = { mode: "escape", numeric, "prefer-named": preferNamed, "encode-everything": encodeEverything, "allow-unsafe-symbols": allowUnsafeSymbols };
    // allow-unsafe-symbols leaves "&" alone, so existing references in the input
    // survive escaping and decode; only samples without references round-trip.
    const escapesAmpersand = !allowUnsafeSymbols || encodeEverything;
    const strictSample = escapesAmpersand ? referenceSample : plainSample;
    const escaped = (await run("text.html", options, strictSample)).text;
    if (escapesAmpersand) assert.doesNotMatch(escaped, /[<>"']/u, JSON.stringify(options));
    assert.doesNotMatch(escaped, /[^\x00-\x7f\x80-\x9f]/u, "escaped output is ASCII apart from NUL and the C1 block");
    assert.equal((await run("text.html", { mode: "unescape", strict: true }, escaped)).text, strictSample, JSON.stringify(options));
    const controls = (await run("text.html", options, controlSample)).text;
    assert.doesNotMatch(controls, /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/u, "C0 controls and DEL are made visible");
    assert.equal(controls.includes("\r"), !encodeEverything, "CR stays literal unless everything is encoded");
    assert.equal((await run("text.html", { mode: "unescape", strict: false }, controls)).text, controlSample, JSON.stringify(options));
    await expectError("text.html", { mode: "unescape", strict: true }, controls, { code: "html.numeric-reference-control" });
  }
});

test("html escape only emits names that decode to the same character in strict mode", async () => {
  const characters = [...PREFERRED_NAMES.keys()].map((codePoint) => String.fromCodePoint(codePoint)).join("");
  const escaped = (await run("text.html", { mode: "escape" }, characters)).text;
  assert.equal((escaped.match(/&[A-Za-z0-9]+;/gu) ?? []).length, PREFERRED_NAMES.size);
  assert.doesNotMatch(escaped, /&#/u, "every preferred character has a name");
  assert.equal((await run("text.html", { mode: "unescape" }, escaped)).text, characters);
});

test("html named reference table is the pinned WHATWG table", () => {
  assert.equal(NAMED_REFERENCES.size, 2231);
  const legacy = [...NAMED_REFERENCES.keys()].filter((name) => !name.endsWith(";"));
  assert.equal(legacy.length, 106);
  assert.equal(Math.max(...legacy.map((name) => name.length)), LEGACY_MAX_LENGTH);
  assert.equal(Math.max(...[...NAMED_REFERENCES.keys()].map((name) => name.length)), NAME_MAX_LENGTH);
  for (const name of legacy) assert.equal(NAMED_REFERENCES.get(name), NAMED_REFERENCES.get(`${name};`));
  const canonical = JSON.stringify([...NAMED_REFERENCES.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  // Same canonical form as the generator: json.dumps(ensure_ascii=True), which
  // escapes every non-ASCII UTF-16 code unit (surrogates individually).
  const ascii = canonical.replace(/[^\x00-\x7f]/g, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`);
  assert.equal(createHash("sha256").update(ascii).digest("hex"), TABLE_SHA256);
  assert.equal(TABLE_SHA256, "c73f5a2c86e09e2ac11024366cded2e8221b502554e756b346379ea4f38801a2");
  assert.equal(PREFERRED_NAMES.size, 251);
  assert.equal(PREFERRED_NAMES.get(0x27), "apos");
  assert.equal(PREFERRED_NAMES.has(0x2329), false, "HTML 4.01 lang is not an HTML5 name for U+2329");
  for (const [codePoint, name] of PREFERRED_NAMES) assert.equal(NAMED_REFERENCES.get(`${name};`), String.fromCodePoint(codePoint));
  assert.equal(C1_REMAP.size, 27);
  assert.equal(C1_REMAP.get(0x80), 0x20ac);
});

test("json string escape matches JSON.stringify and unescape matches JSON.parse", async () => {
  const samples = ["", "plain", `quote " backslash \\ slash /`, "\u0000\u0001\u001f\b\f\n\r\t\u007f", "café 😀 \u2028\u2029 \ufeff", `{"looks":"like json"}`, "😀😀"];
  for (const sample of samples) {
    const escaped = (await run("text.json-string", { mode: "escape" }, sample)).text;
    assert.equal(escaped, JSON.stringify(sample));
    assert.equal((await run("text.json-string", { mode: "unescape" }, escaped)).text, JSON.parse(escaped));
    const ascii = (await run("text.json-string", { mode: "escape", "ascii-only": true }, sample)).text;
    assert.doesNotMatch(ascii, /[^\x20-\x7e]/u);
    assert.equal(JSON.parse(ascii), sample);
    assert.equal((await run("text.json-string", { mode: "unescape" }, ascii)).text, sample);
    const body = (await run("text.json-string", { mode: "escape", quotes: "omit" }, sample)).text;
    assert.equal(`"${body}"`, escaped);
    assert.equal((await run("text.json-string", { mode: "unescape", quotes: "omit" }, body)).text, sample);
  }
});

test("json string operation never formats or parses a whole document", async () => {
  await expectError("text.json-string", { mode: "unescape" }, `{"a": "b"}`, { code: "json.expected-string", byteOffset: 0, match: "JSON tool" });
  await expectError("text.json-string", { mode: "unescape" }, `["a"]`, { code: "json.expected-string", byteOffset: 0 });
  const escaped = (await run("text.json-string", { mode: "escape" }, `{"a": 1}`)).text;
  assert.equal(escaped, `"{\\"a\\": 1}"`);
});

test("backslash escape and unescape round trip for every quote and non-ascii policy", async () => {
  const sample = "tab\tnl\ncr\rnul\u0000 \u00001 bell\u0007 esc\u001b del\u007f c1\u0085 \"quoted\" 'single' back\\slash café 😀 \u{10ffff} \ufffe";
  for (const quotes of ["both", "double", "single", "none"]) for (const nonAscii of ["keep", "unicode", "utf16"]) {
    const options = { mode: "escape", quotes, "non-ascii": nonAscii };
    const escaped = (await run("text.backslash", options, sample)).text;
    assert.doesNotMatch(escaped, /[\x00-\x1f\x7f-\x9f]/u, "no control characters remain after escaping");
    if (nonAscii !== "keep") assert.doesNotMatch(escaped, /[^\x20-\x7e]/u, JSON.stringify(options));
    assert.equal((await run("text.backslash", { mode: "unescape" }, escaped)).text, sample, JSON.stringify(options));
  }
});

test("backslash grammar stays distinct from json and html grammars", async () => {
  await expectError("text.backslash", { mode: "unescape" }, "a\\/b", { code: "backslash.unknown-escape", byteOffset: 1, match: "JSON string tool" });
  assert.equal((await run("text.backslash", { mode: "unescape" }, "&amp; &#233;")).text, "&amp; &#233;");
  assert.equal((await run("text.json-string", { mode: "escape" }, "<&>")).text, `"<&>"`);
  assert.equal((await run("text.html", { mode: "escape" }, "\\n")).text, "\\n");
});

test("input limit is enforced by the SDK reader", async () => {
  const limits = { maxInputBytes: 3, maxOutputBytes: 1024, maxChunkBytes: 1024, deadlineMs: 0 };
  await assert.rejects(() => run("text.html", { mode: "escape" }, "four", { limits }), /exceeds limit/u);
  assert.equal((await run("text.html", { mode: "escape" }, "two", { limits })).text, "two");
});

test("output limit rejects before writing and names both bounds", async () => {
  const limits = { maxInputBytes: 1024, maxOutputBytes: 16, maxChunkBytes: 1024, deadlineMs: 0 };
  const { outputs, context: ctx } = context("<<<<<", { limits });
  await assert.rejects(() => execute({ operationId: "text.html", options: { mode: "escape" } }, ctx), (error) => {
    assert.equal(error.code, "limit.output");
    assert.match(error.message, /output of 20 bytes exceeds the 16 byte output limit \(maxOutputBytes 16, maxChunkBytes 1024\)/u);
    return true;
  });
  assert.equal(outputs.artifacts.size, 0, "nothing is written when the limit is exceeded");
  assert.equal(outputs.values.size, 0);
  const chunkLimits = { maxInputBytes: 1024, maxOutputBytes: 1024, maxChunkBytes: 16, deadlineMs: 0 };
  await assert.rejects(() => run("text.html", { mode: "escape" }, "<<<<<", { limits: chunkLimits }), (error) => error.code === "limit.output" && /maxChunkBytes 16/u.test(error.message));
  assert.equal((await run("text.html", { mode: "escape" }, "<<<<", { limits: chunkLimits })).text, "&lt;&lt;&lt;&lt;");
});

test("cancellation is honoured before reading and cooperatively during transforms", async () => {
  const cancelled = new CancellationToken();
  cancelled.cancel();
  await assert.rejects(() => run("text.html", { mode: "escape" }, "x", { cancellation: cancelled }), ProcessorCancelled);
  class CountingToken { constructor(after) { this.after = after; this.calls = 0; } isCancelled() { this.calls += 1; return this.calls > this.after; } }
  const large = "&amp;<\\n\"".repeat(50_000);
  for (const [operationId, options] of [["text.html", { mode: "escape" }], ["text.html", { mode: "unescape", strict: false }], ["text.json-string", { mode: "escape" }], ["text.json-string", { mode: "unescape", quotes: "omit" }], ["text.backslash", { mode: "escape" }], ["text.backslash", { mode: "unescape" }]]) {
    const token = new CountingToken(12);
    const { outputs, context: ctx } = context(large, { cancellation: token });
    await assert.rejects(() => execute({ operationId, options }, ctx), ProcessorCancelled, `${operationId} ${options.mode}`);
    assert.ok(token.calls > 12, `${operationId} ${options.mode} checked cancellation ${token.calls} times`);
    assert.equal(outputs.artifacts.size, 0);
  }
});

test("large inputs are processed with bounded chunk reads", async () => {
  const large = `<é>\n`.repeat(100_000);
  const escaped = await run("text.html", { mode: "escape", "prefer-named": false }, large, { limits: { maxInputBytes: 1 << 20, maxOutputBytes: 8 << 20, maxChunkBytes: 8 << 20, deadlineMs: 0 } });
  assert.equal(escaped.value.inputBytes, 500_000);
  assert.equal(escaped.value.sequences, 300_000);
  assert.equal(escaped.text.length, "&#60;&#233;&#62;\n".length * 100_000);
});

test("requests are validated before any input is read", async () => {
  const { reader, context: ctx } = context("x");
  let reads = 0;
  const original = reader.readRange.bind(reader);
  reader.readRange = (...args) => { reads += 1; return original(...args); };
  await assert.rejects(() => execute({ operationId: "text.html", options: { mode: "escape", numeric: "binary" } }, ctx), (error) => error.code === "option.invalid");
  await assert.rejects(() => execute({ operationId: "text.html", options: [] }, ctx), (error) => error.code === "option.invalid");
  await assert.rejects(() => execute({ operationId: "missing" }, ctx), (error) => error.code === "operation.unknown");
  assert.equal(reads, 0);
  assert.equal((await run("text.html", {}, "<")).text, "&lt;", "mode defaults to escape");
  assert.deepEqual((await run("text.backslash", { mode: "unescape" }, "x")).value.options, { quotes: "both", "non-ascii": "keep" }, "normalized options are reported");
});
