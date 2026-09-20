import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorCancelled, ProcessorContext, defaultLimits } from "../../packages/plugin-sdk/src/index.ts";
import { CssError, OPERATIONS, TOKEN_STRIDE, execute, normalizeOptions, tokenize } from "./processor.mjs";

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
  const context = new ProcessorContext(reader, outputs, cancellation, new FixedClock("2025-01-01T00:00:00Z"), { fill() {}, id: "seed" }, new MemorySecrets(), limits);
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
    assert.equal(result.value.operation, "minify");
  });
}

// ---------------------------------------------------------------------------
// Round trip: beautify -> minify -> beautify is byte-identical for every
// well-formed (zero-diagnostic) beautify fixture, excluding fixtures whose
// input carries a comment minify is required to drop by design (a plain
// comment always vanishes in minify; a `/*!` one only survives with
// preserve-comments true) — round-tripping through that necessarily-lossy
// step can never be byte-identical, independent of anything this processor
// could format differently.
// ---------------------------------------------------------------------------
function hasDroppableComment(input, options) {
  const { tokens } = tokenize(encoder.encode(input), () => {});
  const bytes = encoder.encode(input);
  for (const tok of tokens) {
    if (tok.type !== "comment") continue;
    if (options.preserveComments === false) return true;
    if (!(tok.e - tok.s >= 3 && bytes[tok.s + 2] === 0x21)) return true; // not a `/*!` license comment
  }
  return false;
}

test("round trip: beautify -> minify -> beautify is byte-identical for well-formed fixtures", async () => {
  let checked = 0;
  for (const item of await fixture("beautify")) {
    if (item.diagnostics.length > 0) continue;
    if (hasDroppableComment(item.input, item.options)) continue;
    const beautified = await expectOk("beautify", item.input, { options: item.options });
    const minified = await expectOk("minify", beautified.bytes, { options: item.options });
    const beautifiedAgain = await expectOk("beautify", minified.bytes, { options: item.options });
    assert.equal(beautifiedAgain.text, beautified.text, `round trip for "${item.name}"`);
    checked += 1;
  }
  assert.ok(checked >= 30, `expected at least 30 well-formed fixtures to round-trip, saw ${checked}`);
});

// ---------------------------------------------------------------------------
// Properties: rules/declarations/atRules/comments counts, independent of the fixtures above.
// ---------------------------------------------------------------------------
test("properties count rules, declarations, at-rules and comments including nested ones", async () => {
  const input = "/* a */\n.a, .b { color: red; margin: 0; }\n@media (min-width:1px) { .c { color: blue; } }\n@import url(x.css);";
  const { value } = await expectOk("beautify", input);
  assert.equal(value.rules, 2, "the .a,.b rule and the nested .c rule");
  assert.equal(value.declarations, 3);
  assert.equal(value.atRules, 2, "@media and @import");
  assert.equal(value.comments, 1);
});

// ---------------------------------------------------------------------------
// Options: kebab-case ids, camelCase aliases, structured errors.
// ---------------------------------------------------------------------------
test("options: defaults, aliases and structured errors", () => {
  assert.deepEqual(normalizeOptions(undefined), { indent: "sp2", indentUnit: "  ", preserveComments: true, blankLineBetweenRules: true });
  assert.deepEqual(normalizeOptions({ indent: "sp4", "blank-line-between-rules": false }), { indent: "sp4", indentUnit: "    ", preserveComments: true, blankLineBetweenRules: false });
  assert.equal(normalizeOptions({ "preserve-comments": false }).preserveComments, false);
  assert.equal(normalizeOptions({ preserveComments: false }).preserveComments, false);
  assert.equal(normalizeOptions({ "preserve-comments": true, preserveComments: true }).preserveComments, true);
  assert.throws(() => normalizeOptions({ "preserve-comments": true, preserveComments: false }), /disagree/);
  assert.throws(() => normalizeOptions({ indent: "4" }), /indent must be one of/);
  assert.throws(() => normalizeOptions({ "blank-line-between-rules": "yes" }), /must be a boolean/);
  assert.throws(() => normalizeOptions({ bogus: 1 }), /unknown option bogus/);
  assert.throws(() => normalizeOptions([]), /options must be an object/);
});

test("unknown operations are rejected", async () => {
  const result = await run("inspect", ".a{color:red}");
  assert.ok(result.error instanceof CssError);
  assert.equal(result.error.code, "css.unsupported-operation");
  assert.equal(result.artifact, undefined);
});

test("both declared operations run", () => {
  assert.deepEqual([...OPERATIONS], ["beautify", "minify"]);
});

// ---------------------------------------------------------------------------
// The one document-level failure: empty input.
// ---------------------------------------------------------------------------
test("an empty document is rejected", async () => {
  for (const operationId of ["beautify", "minify"]) {
    const result = await run(operationId, "");
    assert.ok(result.error instanceof CssError, operationId);
    assert.equal(result.error.code, "css.empty");
    assert.equal(result.artifact, undefined);
    assert.equal(result.value, undefined);
  }
});

// ---------------------------------------------------------------------------
// Tokenizer building blocks, independent of the beautify/minify fixtures.
// ---------------------------------------------------------------------------
test("tokenizer: strings, comments, url() and hashes carry their raw source spans", () => {
  const bytes = encoder.encode(".a { color: #fff; content: \"x\"; background: url(a.png); /* c */ }");
  const { tokens, diagnostics } = tokenize(bytes, () => {});
  assert.equal(diagnostics.length, 0);
  const byType = (type) => tokens.filter((t) => t.type === type);
  assert.equal(byType("hash").length, 1);
  assert.equal(byType("string").length, 1);
  assert.equal(byType("url").length, 1);
  assert.equal(byType("comment").length, 1);
  const url = byType("url")[0];
  assert.equal(decoder.decode(bytes.subarray(url.s, url.e)), "url(a.png)");
});

test("tokenizer: numbers, dimensions and percentages", () => {
  const bytes = encoder.encode("10 10px 10% -5 +5 .5 1e3 1.5e-2");
  const { tokens } = tokenize(bytes, () => {});
  const shapes = tokens.filter((t) => t.type !== "ws").map((t) => [t.type, decoder.decode(bytes.subarray(t.s, t.e))]);
  assert.deepEqual(shapes, [
    ["number", "10"], ["dimension", "10px"], ["percentage", "10%"],
    ["number", "-5"], ["number", "+5"], ["number", ".5"], ["number", "1e3"], ["number", "1.5e-2"],
  ]);
});

test("tokenizer polls cancellation every TOKEN_STRIDE tokens", async () => {
  const input = ".a{" + "color:red;".repeat(TOKEN_STRIDE * 2) + "}";
  let checks = 0;
  tokenize(encoder.encode(input), () => { checks += 1; });
  assert.ok(checks > 1, "the tokenizer itself polled cancellation more than once");
});

// ---------------------------------------------------------------------------
// Limits and cancellation.
// ---------------------------------------------------------------------------
test("input above the injected limit is rejected before any tokenizing", async () => {
  const limits = { ...defaultLimits(), maxInputBytes: 4 };
  const result = await run("beautify", ".a{color:red}", { limits });
  assert.match(result.error?.message ?? "", /exceeds/);
  assert.equal(result.artifact, undefined);
  assert.equal((await expectOk("beautify", ".a{}", { limits })).text, ".a {\n}\n", "input at the limit is accepted");
});

test("output above the effective cap is rejected explicitly", async () => {
  const limits = { ...defaultLimits(), maxOutputBytes: 8, maxChunkBytes: 1024 };
  const result = await run("beautify", ".a{color:red}", { limits });
  assert.ok(result.error instanceof CssError);
  assert.equal(result.error.code, "css.output-limit");
  assert.equal(result.artifact, undefined);
  const small = await expectOk("minify", ".a{}", { limits });
  assert.equal(small.text, ".a{}");
});

test("a token cancelled before execution rejects without reading or writing", async () => {
  const cancellation = new CancellationToken();
  cancellation.cancel();
  const result = await run("beautify", ".a{color:red}", { cancellation });
  assert.ok(result.error instanceof ProcessorCancelled);
  assert.equal(result.artifact, undefined);
  assert.equal(result.value, undefined);
});

class CountedCancellation {
  constructor(allowedChecks) { this.allowedChecks = allowedChecks; this.checks = 0; }
  isCancelled() { this.checks += 1; return this.checks > this.allowedChecks; }
}

test("cancellation raised while tokenizing many statements is honoured", async () => {
  const input = ".a{" + "color:red;".repeat(TOKEN_STRIDE * 3) + "}";
  const cancellation = new CountedCancellation(3);
  const result = await run("beautify", input, { cancellation });
  assert.ok(result.error instanceof ProcessorCancelled);
  assert.ok(cancellation.checks > 3, "the tokenizer itself checked the token");
  assert.equal(result.artifact, undefined);
});

class CancellingReader extends MemoryReader {
  constructor(source, token, afterChunks) { super(); this.insert("input", source); this.token = token; this.afterChunks = afterChunks; this.reads = 0; }
  readRange(port, offset, maxBytes) { this.reads += 1; if (this.reads >= this.afterChunks) this.token.cancel(); return super.readRange(port, offset, maxBytes); }
}

test("cancellation between reader chunks stops the job before any output exists", async () => {
  const source = encoder.encode(".a{" + "color:red;".repeat(200000) + "}");
  const cancellation = new CancellationToken();
  const reader = new CancellingReader(source, cancellation, 2);
  const result = await run("beautify", source, { cancellation, reader });
  assert.ok(result.error instanceof ProcessorCancelled);
  assert.equal(result.artifact, undefined);
  assert.equal(result.value, undefined);
});

// ---------------------------------------------------------------------------
// Source immutability under a demanding document exercising every tolerant case at once.
// ---------------------------------------------------------------------------
test("source bytes are never mutated while tolerating every diagnostic category at once", async () => {
  const input = ".a { broken; color: red; /* unterminated";
  const result = await expectOk("beautify", input);
  assert.equal(result.value.diagnostics, 3, "declaration-no-colon, unclosed-comment, unclosed-block");
});
