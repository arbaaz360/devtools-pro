import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorCancelled, ProcessorContext, SeededRandom, defaultLimits } from "../../packages/plugin-sdk/src/index.ts";
import { OPERATIONS, TEXT_SCAN_STRIDE, TOKEN_STRIDE, XmlError, execute, normalizeOptions } from "./processor.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const diagShape = ({ code, severity, message, offset, end, line, column }) => ({ code, severity, message, offset, end, line, column });

/** Runs one operation through the public SDK context; asserts source immutability and artifact completeness. */
async function run(operationId, input, { limits, cancellation = new CancellationToken(), reader, options = {} } = {}) {
  const source = typeof input === "string" ? encoder.encode(input) : input;
  reader ??= new MemoryReader().insert("input", source);
  const before = reader instanceof MemoryReader ? reader.inputs.get("input").slice() : null;
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(reader, outputs, cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), limits);
  let error = null;
  let returned;
  try { returned = await execute({ operationId, options }, context); } catch (caught) { error = caught; }
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
// Fixture-driven cases: exact output bytes and exact diagnostics.
// ---------------------------------------------------------------------------
for (const item of await fixture("beautify")) {
  test(`beautify fixture: ${item.name}`, async () => {
    const result = await expectOk("beautify", item.input, { options: item.options });
    assert.equal(result.text, item.output, "beautify output");
    assert.deepEqual(result.value.diagnosticsDetail.map(diagShape), item.diagnostics);
    assert.equal(result.value.wellFormed, item.diagnostics.length === 0);
    assert.equal(result.value.diagnostics, item.diagnostics.length);
    assert.equal(result.value.outputBytes, result.bytes.byteLength);
    assert.equal(result.value.operation, "beautify");
  });
}

for (const item of await fixture("minify")) {
  test(`minify fixture: ${item.name}`, async () => {
    const result = await expectOk("minify", item.input, { options: item.options });
    assert.equal(result.text, item.output, "minify output");
    assert.deepEqual(result.value.diagnosticsDetail.map(diagShape), item.diagnostics);
    assert.equal(result.value.wellFormed, item.diagnostics.length === 0);
    assert.equal(result.value.operation, "minify");
  });
}

// ---------------------------------------------------------------------------
// Round trip: beautify -> minify -> beautify is byte-identical for every
// well-formed (zero-diagnostic) beautify fixture.
// ---------------------------------------------------------------------------
test("round trip: beautify -> minify -> beautify is byte-identical for well-formed fixtures", async () => {
  let checked = 0;
  for (const item of await fixture("beautify")) {
    if (item.diagnostics.length > 0) continue;
    const beautified = await expectOk("beautify", item.input, { options: item.options });
    const minified = await expectOk("minify", beautified.bytes, { options: item.options });
    const beautifiedAgain = await expectOk("beautify", minified.bytes, { options: item.options });
    assert.equal(beautifiedAgain.text, beautified.text, `round trip for "${item.name}"`);
    checked += 1;
  }
  assert.ok(checked >= 30, `expected at least 30 well-formed fixtures to round-trip, saw ${checked}`);
});

// ---------------------------------------------------------------------------
// Options: kebab-case ids, camelCase aliases, structured errors.
// ---------------------------------------------------------------------------
test("options: defaults, aliases and structured errors", () => {
  assert.deepEqual(normalizeOptions(undefined), { indent: "sp2", indentUnit: "  ", preserveComments: true, collapseEmpty: true, trimText: false });
  assert.deepEqual(normalizeOptions({ indent: "sp4", collapseEmpty: false }), { indent: "sp4", indentUnit: "    ", preserveComments: true, collapseEmpty: false, trimText: false });
  assert.equal(normalizeOptions({ "preserve-comments": false }).preserveComments, false);
  assert.equal(normalizeOptions({ preserveComments: false }).preserveComments, false);
  assert.equal(normalizeOptions({ "preserve-comments": true, preserveComments: true }).preserveComments, true);
  assert.throws(() => normalizeOptions({ "preserve-comments": true, preserveComments: false }), /disagree/);
  assert.throws(() => normalizeOptions({ indent: "8" }), /indent must be one of/);
  assert.throws(() => normalizeOptions({ "collapse-empty": "yes" }), /must be a boolean/);
  assert.throws(() => normalizeOptions({ bogus: 1 }), /unknown option bogus/);
  assert.throws(() => normalizeOptions([]), /options must be an object/);
});

test("unknown operations are rejected", async () => {
  const result = await run("inspect", "<a/>");
  assert.ok(result.error instanceof XmlError);
  assert.equal(result.error.code, "xml.unsupported-operation");
  assert.equal(result.artifact, undefined);
});

test("both declared operations run", () => {
  assert.deepEqual([...OPERATIONS], ["beautify", "minify"]);
});

// ---------------------------------------------------------------------------
// The two document-level failures: empty input, and input with no "<" at all.
// ---------------------------------------------------------------------------
test("an empty document is rejected", async () => {
  for (const operationId of ["beautify", "minify"]) {
    const result = await run(operationId, "");
    assert.ok(result.error instanceof XmlError, operationId);
    assert.equal(result.error.code, "xml.no-element");
    assert.equal(result.artifact, undefined);
    assert.equal(result.value, undefined);
  }
});

test("a document with no \"<\" anywhere is rejected", async () => {
  const result = await run("beautify", "just some plain text, no markup at all");
  assert.ok(result.error instanceof XmlError);
  assert.equal(result.error.code, "xml.no-element");
});

test("a document whose only \"<\" is inside a comment still has no element and is tolerated", async () => {
  // A comment is a recognized construct in its own right, so this document does contain
  // a "<" and is not rejected; it simply never finds a root element.
  const result = await expectOk("beautify", "<!-- just a comment, no root element -->");
  assert.equal(result.text, "<!-- just a comment, no root element -->");
  assert.equal(result.value.elements, 0);
  assert.equal(result.value.wellFormed, true);
});

// ---------------------------------------------------------------------------
// Limits and cancellation.
// ---------------------------------------------------------------------------
test("input above the injected limit is rejected before any parsing", async () => {
  const limits = { ...defaultLimits(), maxInputBytes: 4 };
  const result = await run("beautify", "<abc/>", { limits });
  assert.match(result.error?.message ?? "", /exceeds/);
  assert.equal(result.artifact, undefined);
  assert.equal((await expectOk("beautify", "<a/>", { limits })).text, "<a/>", "input at the limit is accepted");
});

test("output above the effective cap is rejected explicitly", async () => {
  const limits = { ...defaultLimits(), maxOutputBytes: 8, maxChunkBytes: 1024 };
  const result = await run("beautify", "<longer-than-eight-bytes/>", { limits });
  assert.ok(result.error instanceof XmlError);
  assert.equal(result.error.code, "xml.output-limit");
  assert.equal(result.artifact, undefined);
  const small = await expectOk("beautify", "<a/>", { limits });
  assert.equal(small.text, "<a/>");
});

test("a token cancelled before execution rejects without reading or writing", async () => {
  const cancellation = new CancellationToken();
  cancellation.cancel();
  const result = await run("beautify", "<a/>", { cancellation });
  assert.ok(result.error instanceof ProcessorCancelled);
  assert.equal(result.artifact, undefined);
  assert.equal(result.value, undefined);
});

class CountedCancellation {
  constructor(allowedChecks) { this.allowedChecks = allowedChecks; this.checks = 0; }
  isCancelled() { this.checks += 1; return this.checks > this.allowedChecks; }
}

test("cancellation raised while scanning many tokens is honoured", async () => {
  const input = "<root>" + "<item/>".repeat(TOKEN_STRIDE * 3) + "</root>";
  const cancellation = new CountedCancellation(5);
  const result = await run("beautify", input, { cancellation });
  assert.ok(result.error instanceof ProcessorCancelled);
  assert.ok(cancellation.checks > 5, "the scanner itself checked the token");
  assert.equal(result.artifact, undefined);
});

test("cancellation is checked inside one oversized text run", async () => {
  const input = "<a>" + "x".repeat(TEXT_SCAN_STRIDE * 3) + "</a>";
  const cancellation = new CountedCancellation(2);
  const result = await run("beautify", input, { cancellation });
  assert.ok(result.error instanceof ProcessorCancelled);
  assert.ok(cancellation.checks > 2);
  assert.equal((await expectOk("beautify", input)).value.elements, 1, "the same document succeeds when not cancelled");
});

class CancellingReader extends MemoryReader {
  constructor(source, token, afterChunks) { super(); this.insert("input", source); this.token = token; this.afterChunks = afterChunks; this.reads = 0; }
  readRange(port, offset, maxBytes) { this.reads += 1; if (this.reads >= this.afterChunks) this.token.cancel(); return super.readRange(port, offset, maxBytes); }
}

test("cancellation between reader chunks stops the job before any output exists", async () => {
  const source = encoder.encode("<root>" + "<a/>".repeat(200000) + "</root>");
  const cancellation = new CancellationToken();
  const reader = new CancellingReader(source, cancellation, 2);
  const result = await run("beautify", source, { cancellation, reader });
  assert.ok(result.error instanceof ProcessorCancelled);
  assert.equal(result.artifact, undefined);
  assert.equal(result.value, undefined);
});

// ---------------------------------------------------------------------------
// Source immutability under a demanding document.
// ---------------------------------------------------------------------------
test("source bytes are never mutated while tolerating every diagnostic category at once", async () => {
  const input = "<root><a b=unquoted>1 < 2 & 3<![CDATA[keep]]></a>garbage";
  const result = await expectOk("beautify", input);
  assert.ok(result.value.diagnostics >= 4, `expected several diagnostics, saw ${result.value.diagnostics}`);
});
