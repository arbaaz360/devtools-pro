import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorCancelled, ProcessorContext, SeededRandom, defaultLimits } from "../../packages/plugin-sdk/src/index.ts";
import { FindReplaceError, OPERATION_ID, execute, foldCodePoint, limits, normalizeOptions } from "./processor.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CLOCK = "2025-01-01T00:00:00Z";
/** The manifest output limit; the SDK default chunk limit (1 MiB) is too small for a full-size report. */
const WIDE = { ...defaultLimits(), maxOutputBytes: 4 * 1024 * 1024, maxChunkBytes: 4 * 1024 * 1024 };

function harness(input, { limits: injected, cancellation } = {}) {
  const reader = new MemoryReader().insert("input", input);
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(reader, outputs, cancellation ?? new CancellationToken(), new FixedClock(CLOCK), new SeededRandom(1), new MemorySecrets(), injected ?? defaultLimits());
  return { reader, outputs, context, source: reader.inputs.get("input").slice() };
}

async function run(options, input, extra) {
  const h = harness(input, extra);
  await execute({ operationId: OPERATION_ID, options }, h.context);
  assert.deepEqual(h.reader.inputs.get("input"), h.source, "source bytes must remain immutable");
  const bytes = h.outputs.bytes.get("output");
  const value = h.outputs.values.get("output");
  assert.ok(bytes && value, "report bytes and structured value are both published");
  assert.deepEqual(JSON.parse(decoder.decode(bytes)), value, "serialized report equals the structured value");
  assert.equal(h.outputs.artifacts.get("output").byteLength, bytes.byteLength);
  return { value, bytes, source: h.source };
}

async function fails(options, input, code, pattern, extra) {
  const h = harness(input, extra);
  await assert.rejects(
    () => execute({ operationId: OPERATION_ID, options }, h.context),
    (error) => error instanceof FindReplaceError && error.code === code && error.diagnostic.severity === "error" && error.diagnostic.code === code && pattern.test(error.message),
    `${code} matching ${pattern}`,
  );
  assert.equal(h.outputs.bytes.size, 0, "a failed run publishes no bytes");
  assert.equal(h.outputs.values.size, 0, "a failed run publishes no value");
  assert.deepEqual(h.reader.inputs.get("input"), h.source);
  return h;
}

const foldPoints = (text) => Array.from(text, (character) => foldCodePoint(character.codePointAt(0)));

/** Rebuild the result from the source and the reported offsets, independently of the processor's splice. */
function applyReported(source, value) {
  const applied = value.mode === "find" ? [] : value.mode === "replace" ? value.matches.slice(0, 1) : value.matches;
  let cursor = 0;
  let out = "";
  for (const match of applied) { out += source.slice(cursor, match.start) + value.replacement; cursor = match.end; }
  return out + source.slice(cursor);
}

function assertMatchInvariants(sourceText, value) {
  let previousEnd = 0;
  for (const match of value.matches) {
    assert.ok(match.start >= previousEnd && match.end >= match.start, "matches are sorted and never overlap");
    assert.equal(match.startByte, encoder.encode(sourceText.slice(0, match.start)).byteLength, "startByte is the UTF-8 offset of start");
    assert.equal(match.endByte, encoder.encode(sourceText.slice(0, match.end)).byteLength, "endByte is the UTF-8 offset of end");
    if (value.caseSensitive) assert.equal(sourceText.slice(match.start, match.end), value.query, "case-sensitive matches equal the query");
    else assert.deepEqual(foldPoints(sourceText.slice(match.start, match.end)), foldPoints(value.query), "case-insensitive matches fold to the folded query");
    previousEnd = match.end;
  }
  assert.equal(value.matchesTruncated, value.matchCount > value.matches.length);
  assert.equal(value.matches.length, Math.min(value.matchCount, limits.maxMatches));
  assert.equal(value.matchLimit, limits.maxMatches);
  assert.equal(value.inputBytes, encoder.encode(sourceText).byteLength);
  assert.equal(value.inputLength, sourceText.length);
  assert.equal(value.outputBytes, encoder.encode(value.text).byteLength);
  assert.equal(value.outputLength, value.text.length);
  assert.equal(value.operation, OPERATION_ID);
  assert.equal(value.complete, true);
  if (!value.matchesTruncated) assert.equal(value.text, applyReported(sourceText, value), "reported offsets reproduce the result text");
  if (value.mode === "find") assert.deepEqual(encoder.encode(value.text), encoder.encode(sourceText), "find mode returns the source bytes unchanged");
}

const cases = JSON.parse(await readFile(new URL("./fixtures/cases.json", import.meta.url), "utf8"));
for (const fixture of cases) {
  test(`fixture: ${fixture.name}`, async () => {
    const first = await run(fixture.options, fixture.input);
    const second = await run(fixture.options, fixture.input);
    assert.deepEqual(first.bytes, second.bytes, "identical requests produce identical bytes");
    const { value } = first;
    const expect = fixture.expect;
    assert.equal(value.matchCount, expect.matchCount, "matchCount");
    assert.equal(value.replacementCount, expect.replacementCount, "replacementCount");
    assert.deepEqual(value.matches, expect.matches, "matches");
    assert.equal(value.text, expect.text, "text");
    assert.equal(value.matchesTruncated, expect.matchesTruncated ?? false);
    assert.deepEqual(value.diagnostics.map((item) => item.code), expect.diagnostics ?? [], "diagnostic codes");
    if (expect.inputBytes !== undefined) assert.equal(value.inputBytes, expect.inputBytes);
    if (expect.outputBytes !== undefined) assert.equal(value.outputBytes, expect.outputBytes);
    assert.equal(value.mode, fixture.options.mode ?? "find");
    assert.equal(value.query, fixture.options.query ?? "");
    assert.equal(value.replacement, fixture.options.replacement ?? "");
    assert.equal(value.caseSensitive, fixture.options["case-sensitive"] ?? fixture.options.caseSensitive ?? true);
    assert.equal(value.wholeWord, fixture.options["whole-word"] ?? fixture.options.wholeWord ?? false);
    assertMatchInvariants(fixture.input, value);
  });
}

const invalid = JSON.parse(await readFile(new URL("./fixtures/invalid.json", import.meta.url), "utf8"));
for (const fixture of invalid) {
  test(`invalid: ${fixture.name}`, async () => {
    const input = fixture.inputBytes ? Uint8Array.from(fixture.inputBytes) : fixture.input;
    await fails(fixture.options, input, fixture.code, new RegExp(fixture.message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
}

test("report layout is fixed: key order, one match per line, trailing newline", async () => {
  const { bytes, value } = await run({ query: "a", replacement: "b", mode: "replaceAll" }, "a a");
  const text = decoder.decode(bytes);
  assert.deepEqual(Object.keys(value), ["operation", "mode", "query", "replacement", "caseSensitive", "wholeWord", "matchCount", "replacementCount", "matchLimit", "matchesTruncated", "matches", "inputBytes", "inputLength", "outputBytes", "outputLength", "text", "diagnostics", "complete"]);
  assert.match(text, /^\{\n {2}"operation": "text\.find-replace",\n/u);
  assert.match(text, /\n {2}"matches": \[\n {4}\{"start":0,"end":1,"startByte":0,"endByte":1\},\n {4}\{"start":2,"end":3,"startByte":2,"endByte":3\}\n {2}\],\n/u);
  assert.match(text, /\n {2}"diagnostics": \[\],\n {2}"complete": true\n\}\n$/u);
});

test("operation id is checked when supplied and optional otherwise", async () => {
  const h = harness("abc");
  await execute({ options: { query: "b" } }, h.context);
  assert.equal(h.outputs.values.get("output").matchCount, 1);
  const other = harness("abc");
  await assert.rejects(() => execute({ operationId: "text.other", options: { query: "b" } }, other.context), (error) => error instanceof FindReplaceError && error.code === "find.unsupported-operation");
  assert.equal(other.outputs.values.size, 0);
});

test("option normalization applies manifest defaults", () => {
  assert.deepEqual(normalizeOptions(undefined), { query: "", replacement: "", mode: "find", caseSensitive: true, wholeWord: false });
  assert.deepEqual(normalizeOptions({ query: "x", mode: "replace", caseSensitive: false, wholeWord: true, replacement: "y" }), { query: "x", replacement: "y", mode: "replace", caseSensitive: false, wholeWord: true });
  assert.deepEqual(normalizeOptions({ query: "x", "case-sensitive": false, "whole-word": true }), { query: "x", replacement: "", mode: "find", caseSensitive: false, wholeWord: true });
  assert.deepEqual(normalizeOptions({ query: "x", "case-sensitive": false, caseSensitive: false }), { query: "x", replacement: "", mode: "find", caseSensitive: false, wholeWord: false });
  assert.throws(() => normalizeOptions({ query: "a".repeat(limits.maxQueryLength + 1) }), (error) => error.code === "find.invalid-option" && /limited to/u.test(error.message));
  assert.throws(() => normalizeOptions({ query: "a", replacement: "b".repeat(limits.maxQueryLength + 1) }), (error) => error.code === "find.invalid-option");
  assert.throws(() => normalizeOptions("query=a"), (error) => error.code === "find.invalid-option");
});

test("case folding matches ECMAScript u-mode canonicalization for every cased code point", () => {
  // The processor never builds a RegExp from user input; the regex here is the
  // reference oracle for the fold table, built from a hexadecimal escape only.
  const single = (value) => value.length > 0 && String.fromCodePoint(value.codePointAt(0)) === value;
  const oracle = (codePoint) => new RegExp("^\\u{" + codePoint.toString(16) + "}$", "iu");
  let cased = 0;
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    const character = String.fromCodePoint(codePoint);
    const lower = character.toLowerCase();
    const upper = character.toUpperCase();
    const folded = foldCodePoint(codePoint);
    if (lower === character && upper === character) { assert.equal(folded, codePoint); continue; }
    cased += 1;
    const sameClass = oracle(codePoint);
    assert.ok(sameClass.test(String.fromCodePoint(folded)), `U+${codePoint.toString(16)} folds inside its own class`);
    assert.equal(foldCodePoint(folded), folded, `U+${codePoint.toString(16)} fold is idempotent`);
    for (const variant of [lower, upper]) {
      if (!single(variant)) continue;
      const variantPoint = variant.codePointAt(0);
      if (sameClass.test(variant)) assert.equal(foldCodePoint(variantPoint), folded, `U+${codePoint.toString(16)} and U+${variantPoint.toString(16)} fold together`);
      else assert.notEqual(foldCodePoint(variantPoint), folded, `U+${codePoint.toString(16)} and U+${variantPoint.toString(16)} stay apart`);
    }
  }
  assert.ok(cased > 2500, `oracle covered ${cased} cased code points`);
});

test("match listing is bounded while counts and replacements stay exact", async () => {
  const input = "a".repeat(limits.maxMatches + 5000);
  const found = await run({ query: "a" }, input);
  assert.equal(found.value.matchCount, limits.maxMatches + 5000);
  assert.equal(found.value.matches.length, limits.maxMatches);
  assert.equal(found.value.matchesTruncated, true);
  assert.deepEqual(found.value.matches.at(-1), { start: limits.maxMatches - 1, end: limits.maxMatches, startByte: limits.maxMatches - 1, endByte: limits.maxMatches });
  assert.deepEqual(found.value.diagnostics, [{ code: "find.match-limit", severity: "warning", message: `${limits.maxMatches + 5000} matches found; only the first ${limits.maxMatches} offsets are listed`, data: { matchCount: limits.maxMatches + 5000, limit: limits.maxMatches } }]);
  assertMatchInvariants(input, found.value);
  const replaced = await run({ query: "a", replacement: "b", mode: "replaceAll" }, input);
  assert.equal(replaced.value.replacementCount, limits.maxMatches + 5000);
  assert.equal(replaced.value.text, "b".repeat(limits.maxMatches + 5000));
  assert.equal(replaced.value.matches.length, limits.maxMatches);
  assert.equal(replaced.value.matchesTruncated, true);
  const first = await run({ query: "a", replacement: "b", mode: "replace" }, input);
  assert.equal(first.value.replacementCount, 1);
  assert.equal(first.value.text, "b" + "a".repeat(limits.maxMatches + 4999));
});

test("input limits: injected byte limit and package code-unit limit", async () => {
  const tight = { ...defaultLimits(), maxInputBytes: 4 };
  const h = harness("five!", { limits: tight });
  await assert.rejects(() => execute({ operationId: OPERATION_ID, options: { query: "f" } }, h.context), /exceeds/u);
  assert.equal(h.outputs.values.size, 0);
  const sized = await run({ query: "f" }, "four", { limits: tight });
  assert.equal(sized.value.matchCount, 1);
  await fails({ query: "a" }, "a".repeat(limits.maxTextLength + 1), "find.input-limit", /UTF-16 code units/u);
  const exact = await run({ query: "zz" }, "a".repeat(limits.maxTextLength), { limits: WIDE });
  assert.equal(exact.value.inputLength, limits.maxTextLength);
});

test("output limits: report bytes against the smaller of output and chunk limits, and result length", async () => {
  const h = await fails({ query: "a" }, "aaa", "find.output-limit", /above the 64 byte output limit/u, { limits: { ...defaultLimits(), maxOutputBytes: 64 } });
  assert.equal(h.outputs.artifacts.size, 0);
  await fails({ query: "a" }, "aaa", "find.output-limit", /above the 96 byte output limit/u, { limits: { ...defaultLimits(), maxChunkBytes: 96 } });
  const ok = await run({ query: "a" }, "aaa", { limits: { ...defaultLimits(), maxOutputBytes: 4096, maxChunkBytes: 4096 } });
  assert.ok(ok.bytes.byteLength <= 4096);
  const growth = await fails({ query: "a", replacement: "aa", mode: "replaceAll" }, "a".repeat(600_000), "find.output-limit", /UTF-16 code units/u);
  assert.equal(growth.outputs.values.size, 0);
  const grownToLimit = await run({ query: "a", replacement: "aa", mode: "replaceAll" }, "a".repeat(limits.maxTextLength / 2), { limits: WIDE });
  assert.equal(grownToLimit.value.outputLength, limits.maxTextLength);
});

class CountingToken {
  constructor(cancelAfter = Infinity) { this.calls = 0; this.cancelAfter = cancelAfter; }
  isCancelled() { this.calls += 1; return this.calls > this.cancelAfter; }
}

test("cancellation: before reading, during folding, during scanning, and polling granularity", async () => {
  const cancelled = new CancellationToken();
  cancelled.cancel();
  const early = harness("abc", { cancellation: cancelled });
  await assert.rejects(() => execute({ operationId: OPERATION_ID, options: { query: "a" } }, early.context), ProcessorCancelled);
  assert.equal(early.outputs.values.size, 0);

  const input = "ab ".repeat(200_000);
  // Reading costs at most two checks per 64 KiB chunk (SDK plus processor),
  // so 60 lands inside folding and 40 inside a case-sensitive scan.
  const duringFold = harness(input, { cancellation: new CountingToken(60) });
  await assert.rejects(() => execute({ operationId: OPERATION_ID, options: { query: "AB", caseSensitive: false } }, duringFold.context), ProcessorCancelled);
  assert.equal(duringFold.outputs.values.size, 0);
  assert.equal(duringFold.outputs.bytes.size, 0);

  const duringScan = harness(input, { cancellation: new CountingToken(40) });
  await assert.rejects(() => execute({ operationId: OPERATION_ID, options: { query: "ab", wholeWord: true } }, duringScan.context), ProcessorCancelled);
  assert.equal(duringScan.outputs.values.size, 0);

  const counted = new CountingToken();
  const complete = harness(input, { cancellation: counted, limits: WIDE });
  await execute({ operationId: OPERATION_ID, options: { query: "AB", caseSensitive: false, replacement: "x", mode: "replaceAll" } }, complete.context);
  assert.equal(complete.outputs.values.get("output").replacementCount, 200_000);
  assert.ok(counted.calls >= Math.floor(input.length / limits.checkEvery), `cancellation polled ${counted.calls} times for ${input.length} code units`);
});

test("diagnostic errors carry contract-shaped diagnostics", async () => {
  const h = harness("abc");
  try { await execute({ operationId: OPERATION_ID, options: { query: "a", mode: "nope" } }, h.context); assert.fail("expected a diagnostic"); }
  catch (error) {
    assert.ok(error instanceof FindReplaceError);
    assert.deepEqual(error.diagnostic, { code: "find.invalid-option", severity: "error", message: "mode must be one of find, replace, replaceAll", data: { option: "mode", received: "nope" } });
    assert.match(error.diagnostic.code, /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);
  }
});
