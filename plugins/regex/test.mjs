import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorCancelled, ProcessorContext, SeededRandom, defaultLimits } from "../../packages/plugin-sdk/src/index.ts";
import { OPERATION_ID, RegexError, buildFlags, execute, limits, normalizeOptions, parseGroupNames } from "./processor.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CLOCK = "2025-01-01T00:00:00Z";
/** The manifest's own limits; the SDK default chunk limit (1 MiB) is too small for large match/annotation lists. */
const WIDE = { ...defaultLimits(), maxOutputBytes: 16 * 1024 * 1024, maxChunkBytes: 4 * 1024 * 1024 };

function harness(input, { limits: injected, cancellation } = {}) {
  const reader = new MemoryReader().insert("input", input);
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(reader, outputs, cancellation ?? new CancellationToken(), new FixedClock(CLOCK), new SeededRandom(1), new MemorySecrets(), injected ?? WIDE);
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
    (error) => error instanceof RegexError && error.code === code && error.diagnostic.severity === "error" && error.diagnostic.code === code && pattern.test(error.message),
    `${code} matching ${pattern}`,
  );
  assert.equal(h.outputs.bytes.size, 0, "a failed run publishes no bytes");
  assert.equal(h.outputs.values.size, 0, "a failed run publishes no value");
  assert.deepEqual(h.reader.inputs.get("input"), h.source);
  return h;
}

/** Independent check: every reported offset must reproduce the same substring of the source. */
function assertMatchInvariants(sourceText, value) {
  assert.equal(value.matches.length, Math.min(value.count, limits.maxMatches));
  assert.equal(value.truncated, value.count > value.matches.length);
  assert.equal(value.operation, OPERATION_ID);
  assert.equal(value.flavor, "ecmascript");
  assert.equal(value.complete, true);
  assert.equal(value.inputLength, sourceText.length);
  assert.equal(value.inputBytes, encoder.encode(sourceText).byteLength);

  // Each "match" annotation starts a new bucket; following "group" annotations belong to it.
  // None of this package's fixtures approach the 20,000-entry annotation cap with groups in
  // play, so every stored match has a complete bucket here.
  const annotationsByMatch = [];
  for (const annotation of value.annotations) {
    if (annotation.kind === "match") annotationsByMatch.push([annotation]);
    else annotationsByMatch.at(-1).push(annotation);
  }
  assert.equal(annotationsByMatch.length, value.matches.length);

  let previousEnd = 0;
  value.matches.forEach((match, position) => {
    assert.ok(match.index >= previousEnd, "matches are sorted and non-overlapping in the source");
    assert.ok(match.end >= match.index);
    assert.equal(sourceText.slice(match.index, match.end), match.text, "match text is the source slice at its offsets");
    previousEnd = match.end;

    const [matchAnnotation, ...groupAnnotations] = annotationsByMatch[position];
    assert.deepEqual(matchAnnotation, { start: match.index, end: match.end, kind: "match", label: `#${position + 1}` });

    const participating = match.groups.filter((group) => group.index !== null);
    assert.equal(groupAnnotations.length, participating.length);
    participating.forEach((group, groupPosition) => {
      const annotation = groupAnnotations[groupPosition];
      assert.equal(annotation.kind, "group");
      assert.equal(annotation.start, group.index);
      assert.equal(annotation.end, group.end);
      assert.equal(annotation.label, group.name ?? String(group.number));
      assert.equal(sourceText.slice(group.index, group.end), group.text, "group text is the source slice at its offsets");
    });

    for (const group of match.groups) {
      if (group.index === null) { assert.equal(group.end, null); assert.equal(group.text, null); continue; }
      assert.equal(sourceText.slice(group.index, group.end), group.text);
    }
    for (const group of match.groups) {
      if (group.name === null) continue;
      assert.deepEqual(match.named[group.name], group);
    }
  });

  assert.ok(value.annotations.length <= limits.maxAnnotations);
}

// ---------------------------------------------------------------------------
// Fixtures

const matchFixtures = JSON.parse(await readFile(new URL("./fixtures/match.json", import.meta.url), "utf8"));
for (const fixture of matchFixtures) {
  test(`match fixture: ${fixture.name}`, async () => {
    const first = await run(fixture.options, fixture.input);
    const second = await run(fixture.options, fixture.input);
    assert.deepEqual(first.bytes, second.bytes, "identical requests produce identical bytes");
    const { value } = first;
    assert.equal(value.count, fixture.expect.count, "count");
    assert.equal(value.truncated, fixture.expect.truncated, "truncated");
    assert.equal(value.flags, fixture.expect.flags, "flags");
    assert.deepEqual(value.matches, fixture.expect.matches, "matches");
    assert.equal(value.text, fixture.expect.text, "text");
    assert.equal(value.mode, "match");
    assert.equal(value.pattern, fixture.options.pattern);
    assert.equal(value.replacements, 0);
    assert.deepEqual(value.annotations.filter((a) => a.kind !== "match" && a.kind !== "group"), []);
    assertMatchInvariants(fixture.input, value);
  });
}

const replaceFixtures = JSON.parse(await readFile(new URL("./fixtures/replace.json", import.meta.url), "utf8"));
for (const fixture of replaceFixtures) {
  test(`replace fixture: ${fixture.name}`, async () => {
    const { value } = await run(fixture.options, fixture.input);
    assert.equal(value.replacements, fixture.expect.replacements, "replacements");
    assert.equal(value.text, fixture.expect.text, "text");
    assert.equal(value.mode, "replace");
    assert.equal(value.count, value.replacements);
    assert.equal(value.truncated, false);
    assert.deepEqual(value.matches, []);
    assert.deepEqual(value.annotations, []);
    assert.equal(value.outputBytes, encoder.encode(value.text).byteLength);
    assert.equal(value.outputLength, value.text.length);
    if (fixture.options.global === false) assert.ok(value.replacements <= 1);
  });
}

const invalidFixtures = JSON.parse(await readFile(new URL("./fixtures/invalid.json", import.meta.url), "utf8"));
for (const fixture of invalidFixtures) {
  test(`invalid: ${fixture.name}`, async () => {
    const input = fixture.inputBytes ? Uint8Array.from(fixture.inputBytes) : fixture.input;
    await fails(fixture.options, input, fixture.code, new RegExp(fixture.message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
}

// ---------------------------------------------------------------------------
// Direct unit checks

test("group numbering and naming skips non-capturing groups, lookaround and character classes", () => {
  assert.deepEqual(parseGroupNames("abc"), [null]);
  assert.deepEqual(parseGroupNames("(a)(b)"), [null, null, null]);
  assert.deepEqual(parseGroupNames("(?<x>a)(b)"), [null, "x", null]);
  assert.deepEqual(parseGroupNames("(?:a)(b)"), [null, null]);
  assert.deepEqual(parseGroupNames("(?=a)(b)"), [null, null]);
  assert.deepEqual(parseGroupNames("(?!a)(b)"), [null, null]);
  assert.deepEqual(parseGroupNames("(?<=a)(b)"), [null, null]);
  assert.deepEqual(parseGroupNames("(?<!a)(b)"), [null, null]);
  assert.deepEqual(parseGroupNames("[(a)](b)"), [null, null], "parens inside a character class are literal");
  assert.deepEqual(parseGroupNames("\\((a)\\)"), [null, null], "an escaped paren is literal");
  assert.deepEqual(parseGroupNames("[\\]](a)"), [null, null], "an escaped ] inside a class does not close it early");
  assert.deepEqual(parseGroupNames("((a)(b))"), [null, null, null, null], "outer group is numbered before its nested groups");
  assert.deepEqual(parseGroupNames("(?<a>x)|(?<b>y)"), [null, "a", "b"]);
});

test("flags are built in canonical order regardless of option order", () => {
  assert.equal(buildFlags({ global: true, ignoreCase: true, multiline: true, dotAll: true, unicode: true, sticky: true }), "gimsuy");
  assert.equal(buildFlags({ global: false, ignoreCase: false, multiline: false, dotAll: false, unicode: false, sticky: false }), "");
  assert.equal(buildFlags({ global: false, sticky: true, unicode: true }), "uy");
});

test("option normalization applies manifest defaults", () => {
  assert.deepEqual(normalizeOptions(undefined), { pattern: "", mode: "match", replacement: "", global: true, ignoreCase: false, multiline: false, dotAll: false, unicode: false, sticky: false });
  assert.deepEqual(normalizeOptions({ pattern: "a", mode: "replace", replacement: "b", ignoreCase: true, dotAll: true }), { pattern: "a", mode: "replace", replacement: "b", global: true, ignoreCase: true, multiline: false, dotAll: true, unicode: false, sticky: false });
  assert.throws(() => normalizeOptions("pattern=a"), (error) => error.code === "regex.invalid-option");
});

test("operation id is checked when supplied and optional otherwise", async () => {
  const h = harness("abc");
  await execute({ options: { pattern: "b" } }, h.context);
  assert.equal(h.outputs.values.get("output").count, 1);
  const other = harness("abc");
  await assert.rejects(() => execute({ operationId: "text.other", options: { pattern: "b" } }, other.context), (error) => error instanceof RegexError && error.code === "regex.unsupported-operation");
  assert.equal(other.outputs.values.size, 0);
});

test("diagnostic errors carry contract-shaped diagnostics", async () => {
  const h = harness("abc");
  try { await execute({ operationId: OPERATION_ID, options: { pattern: "a", mode: "nope" } }, h.context); assert.fail("expected a diagnostic"); }
  catch (error) {
    assert.ok(error instanceof RegexError);
    assert.deepEqual(error.diagnostic, { code: "regex.invalid-option", severity: "error", message: "mode must be one of match, replace", data: { option: "mode", received: "nope" } });
    assert.match(error.diagnostic.code, /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);
  }
});

test("input limits: injected byte limit and package code-unit limit", async () => {
  const tight = { ...defaultLimits(), maxInputBytes: 4 };
  const h = harness("five!", { limits: tight });
  await assert.rejects(() => execute({ operationId: OPERATION_ID, options: { pattern: "f" } }, h.context), /exceeds/u);
  assert.equal(h.outputs.values.size, 0);
  const sized = await run({ pattern: "f" }, "four", { limits: tight });
  assert.equal(sized.value.count, 1);
});

test("output limits: report bytes checked against the smaller of output and chunk limits", async () => {
  const h = await fails({ pattern: "a" }, "aaa", "regex.output-limit", /output limit/u, { limits: { ...defaultLimits(), maxOutputBytes: 16 } });
  assert.equal(h.outputs.artifacts.size, 0);
  await fails({ pattern: "a" }, "aaa", "regex.output-limit", /output limit/u, { limits: { ...defaultLimits(), maxChunkBytes: 16 } });
  const ok = await run({ pattern: "a" }, "aaa", { limits: { ...defaultLimits(), maxOutputBytes: 4096, maxChunkBytes: 4096 } });
  assert.ok(ok.bytes.byteLength <= 4096);
});

class CountingToken {
  constructor(cancelAfter = Infinity) { this.calls = 0; this.cancelAfter = cancelAfter; }
  isCancelled() { this.calls += 1; return this.calls > this.cancelAfter; }
}

test("cancellation: before reading, and during a long match scan", async () => {
  const cancelled = new CancellationToken();
  cancelled.cancel();
  const early = harness("abc", { cancellation: cancelled });
  await assert.rejects(() => execute({ operationId: OPERATION_ID, options: { pattern: "a" } }, early.context), ProcessorCancelled);
  assert.equal(early.outputs.values.size, 0);

  const input = "a".repeat(50_000);
  const duringScan = harness(input, { cancellation: new CountingToken(3) });
  await assert.rejects(() => execute({ operationId: OPERATION_ID, options: { pattern: "a" } }, duringScan.context), ProcessorCancelled);
  assert.equal(duringScan.outputs.values.size, 0);
  assert.equal(duringScan.outputs.bytes.size, 0);

  const counted = new CountingToken();
  const complete = await run({ pattern: "a" }, input, { cancellation: counted });
  assert.equal(complete.value.count, 50_000);
  assert.ok(counted.calls >= Math.floor(50_000 / limits.checkEvery), `cancellation polled ${counted.calls} times for ${50_000} matches`);
});

test("match listing is bounded at 10,000 while the count stays exact", async () => {
  const input = "a".repeat(limits.maxMatches + 1);
  const { value } = await run({ pattern: "a" }, input);
  assert.equal(value.count, limits.maxMatches + 1);
  assert.equal(value.truncated, true);
  assert.equal(value.matches.length, limits.maxMatches);
  assert.deepEqual(value.matches.at(-1), { index: limits.maxMatches - 1, end: limits.maxMatches, text: "a", groups: [], named: {} });
  assert.equal(value.annotations.length, limits.maxMatches);
  assertMatchInvariants(input, value);
});

test("cancellation during a replace pass", async () => {
  const input = "a".repeat(50_000);
  const duringReplace = harness(input, { cancellation: new CountingToken(3) });
  await assert.rejects(() => execute({ operationId: OPERATION_ID, options: { pattern: "a", mode: "replace", replacement: "b" } }, duringReplace.context), ProcessorCancelled);
  assert.equal(duringReplace.outputs.values.size, 0);
});

test("source bytes are never mutated even when the run throws", async () => {
  const h = harness("hello world");
  const before = h.reader.inputs.get("input").slice();
  await assert.rejects(() => execute({ operationId: OPERATION_ID, options: { pattern: "(unterminated" } }, h.context));
  assert.deepEqual(h.reader.inputs.get("input"), before);
});
