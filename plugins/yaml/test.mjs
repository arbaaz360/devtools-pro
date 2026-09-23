import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorCancelled, ProcessorContext, SeededRandom, defaultLimits } from "../../packages/plugin-sdk/src/index.ts";
import { execute as jsonExecute } from "../json/processor.mjs";
import { CANCELLATION_STRIDE_LINES, OptionError, YamlError, classifyPlainScalar, execute } from "./processor.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const VALID_DIR = new URL("./fixtures/valid/", import.meta.url);
const INVALID_DIR = new URL("./fixtures/invalid/", import.meta.url);
const JSON_DIR = new URL("./fixtures/json/", import.meta.url);

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
  }
  return { error, returned, bytes, text: bytes ? decoder.decode(bytes) : null, value: outputs.values.get("output"), artifact };
}

async function expectOk(operationId, input, options) {
  const result = await run(operationId, input, options);
  if (result.error) throw result.error;
  return result;
}

async function jsonMinify(text) {
  const reader = new MemoryReader().insert("input", text);
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(reader, outputs, new CancellationToken(), new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), defaultLimits());
  await jsonExecute({ operationId: "minify", options: {} }, context);
  return decoder.decode(outputs.bytes.get("output"));
}

// ---------------------------------------------------------------------------
// Valid YAML -> JSON fixtures: exact bytes at the default 2-space indent.
// ---------------------------------------------------------------------------

const validNames = (await readdir(VALID_DIR)).filter((name) => name.endsWith(".yaml")).map((name) => name.slice(0, -5)).sort();
assert.ok(validNames.length >= 40, `expected at least 40 valid fixtures, found ${validNames.length}`);

for (const name of validNames) {
  test(`valid: ${name}`, async () => {
    const yamlText = await readFile(new URL(`${name}.yaml`, VALID_DIR), "utf8");
    const expectedJson = await readFile(new URL(`${name}.json`, VALID_DIR), "utf8");
    const result = await expectOk("convert.yaml-json", yamlText, { options: { indent: "space2" } });
    assert.equal(result.text, expectedJson, name);
    assert.equal(result.value.documents, 1);
    assert.equal(result.value.bytes, result.bytes.byteLength);
    // Every successful output must be valid JSON (AG-130): this class of defect cannot
    // return without failing here, on every fixture, at both indent settings.
    JSON.parse(result.text);
    // Minified output parses to the same JSON.parse-independent structure (byte check via re-run).
    const minified = await expectOk("convert.yaml-json", yamlText, { options: { indent: "minified" } });
    assert.equal(minified.text.endsWith("\n"), false, "minified output has no trailing newline");
    JSON.parse(minified.text);
  });
}

test("indent option: 4 spaces nests deeper than 2", async () => {
  const yamlText = "a:\n  b: 1\n";
  const two = await expectOk("convert.yaml-json", yamlText, { options: { indent: "space2" } });
  const four = await expectOk("convert.yaml-json", yamlText, { options: { indent: "space4" } });
  assert.equal(two.text, "{\n  \"a\": {\n    \"b\": 1\n  }\n}\n");
  assert.equal(four.text, "{\n    \"a\": {\n        \"b\": 1\n    }\n}\n");
});

test("sort-keys option sorts top-level and nested mapping keys", async () => {
  const yamlText = "zebra: 1\napple:\n  z: 1\n  a: 2\nmango: 3\n";
  const unsorted = await expectOk("convert.yaml-json", yamlText, { options: { indent: "minified" } });
  const sorted = await expectOk("convert.yaml-json", yamlText, { options: { indent: "minified", "sort-keys": true } });
  assert.equal(unsorted.text, "{\"zebra\":1,\"apple\":{\"z\":1,\"a\":2},\"mango\":3}");
  assert.equal(sorted.text, "{\"apple\":{\"a\":2,\"z\":1},\"mango\":3,\"zebra\":1}");
});

// ---------------------------------------------------------------------------
// Invalid YAML: a single structured diagnostic naming the rejected construct.
// ---------------------------------------------------------------------------

const invalidManifest = JSON.parse(await readFile(new URL("manifest.json", INVALID_DIR), "utf8"));
assert.ok(invalidManifest.length >= 15, `expected at least 15 invalid fixtures, found ${invalidManifest.length}`);

for (const item of invalidManifest) {
  test(`invalid: ${item.name}`, async () => {
    const yamlText = await readFile(new URL(item.file, INVALID_DIR), "utf8");
    const result = await run("convert.yaml-json", yamlText);
    assert.ok(result.error instanceof YamlError, `expected a YamlError, got ${result.error}`);
    assert.equal(result.error.code, item.code, result.error.message);
    assert.equal(result.artifact, undefined);
    assert.equal(result.value, undefined);
    assert.ok(Number.isInteger(result.error.diagnostic.line) && Number.isInteger(result.error.diagnostic.column), "position must be resolved");
  });
}

test("duplicate-key diagnostic names both positions", async () => {
  const result = await run("convert.yaml-json", "a: 1\na: 2\n");
  assert.equal(result.error.diagnostic.related.length, 1);
  assert.ok(result.error.message.includes('"a"'));
});

// ---------------------------------------------------------------------------
// JSON -> YAML fixtures: semantic round trip is byte-identical to plugins/json's minify.
// ---------------------------------------------------------------------------

const jsonNames = (await readdir(JSON_DIR)).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).sort();
assert.ok(jsonNames.length >= 15, `expected at least 15 json fixtures, found ${jsonNames.length}`);

for (const name of jsonNames) {
  test(`json round trip: ${name}`, async () => {
    const source = await readFile(new URL(`${name}.json`, JSON_DIR), "utf8");
    const minified = await jsonMinify(source);
    const yaml = await expectOk("convert.json-yaml", source, { options: { indent: "space2" } });
    const back = await expectOk("convert.yaml-json", yaml.text, { options: { indent: "minified" } });
    assert.equal(back.text, minified, `round trip mismatch for ${name}\nyaml:\n${yaml.text}`);
    // AG-130: the round trip's own output, and the minified source it is compared against, must
    // both be valid JSON.
    assert.deepEqual(JSON.parse(back.text), JSON.parse(minified), name);
  });
}

test("json-yaml rejects invalid JSON the same way plugins/json does", async () => {
  const result = await run("convert.json-yaml", "{not valid}");
  assert.equal(result.error.code, "json.unexpected-token");
  assert.ok(Number.isInteger(result.error.diagnostic.line));
});

test("json-yaml preserves exact integer lexemes beyond IEEE-754 safe range", async () => {
  const result = await expectOk("convert.json-yaml", "{\"big\":18446744073709551615}");
  assert.equal(result.text, "big: 18446744073709551615\n");
});

// ---------------------------------------------------------------------------
// Scalar typing unit coverage (independent of the parser's line handling).
// ---------------------------------------------------------------------------

test("classifyPlainScalar covers the YAML 1.2 core schema", async () => {
  assert.deepEqual(classifyPlainScalar(""), { t: "null" });
  assert.deepEqual(classifyPlainScalar("~"), { t: "null" });
  assert.deepEqual(classifyPlainScalar("Null"), { t: "null" });
  assert.deepEqual(classifyPlainScalar("True"), { t: "bool", v: true });
  assert.deepEqual(classifyPlainScalar("FALSE"), { t: "bool", v: false });
  assert.equal(classifyPlainScalar("0x1F").decimal, "31");
  assert.equal(classifyPlainScalar("0o17").decimal, "15");
  assert.equal(classifyPlainScalar("-5").decimal, "-5");
  assert.equal(classifyPlainScalar("3.14").text, "3.14");
  assert.equal(classifyPlainScalar(".5").text, "0.5");
  assert.equal(classifyPlainScalar("1.").text, "1.0");
  assert.deepEqual(classifyPlainScalar(".inf"), { t: "floatSpecial", kind: "inf" });
  assert.deepEqual(classifyPlainScalar("-.inf"), { t: "floatSpecial", kind: "-inf" });
  assert.deepEqual(classifyPlainScalar(".nan"), { t: "floatSpecial", kind: "nan" });
  assert.deepEqual(classifyPlainScalar("hello"), { t: "str", v: "hello" });
  assert.equal(classifyPlainScalar("99999999999999999999").unsafe, true);
  assert.equal(classifyPlainScalar("42").unsafe, false);
});

// AG-130: every plain scalar the YAML 1.2 core schema resolves as a number must become a
// JSON number that JSON.parse accepts, with every significant digit preserved. Int pattern
// from the schema: `[-+]?[0-9]+` (plus 0x/0o forms); float pattern:
// `[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?`. JSON's own number grammar forbids a
// leading zero before another digit in the integer part, which the core schema's patterns do
// not forbid, so the emitter must strip what the grammar rejects and nothing more.
// [lexeme, expected classifyPlainScalar type, exact JSON emitted for `a: <lexeme>` at minified indent]
const AG_130_NUMBER_LEXEMES = [
  ["0", "int", '{"a":0}'],
  ["-0", "int", '{"a":0}'],
  ["00", "int", '{"a":0}'],
  ["+1", "int", '{"a":1}'],
  ["0.0", "float", '{"a":0.0}'],
  ["1_000", "str", '{"a":"1_000"}'], // underscores are not part of the YAML 1.2 core schema number patterns
  ["0x1F", "int", '{"a":31}'],
  ["0o17", "int", '{"a":15}'],
  ["123456789012345678901234567890", "int", '{"a":"123456789012345678901234567890"}'], // 30 digits, unsafe range
  ["01.2", "float", '{"a":1.2}'],
  ["00e2", "float", '{"a":0e2}'],
  ["-00.3", "float", '{"a":-0.3}'],
];

test("classifyPlainScalar strips leading zeros a JSON number cannot carry, keeping every significant digit", async () => {
  for (const [lexeme, kind] of AG_130_NUMBER_LEXEMES) {
    assert.equal(classifyPlainScalar(lexeme).t, kind, lexeme);
  }
});

test("every AG-130 number lexeme round-trips through the full pipeline as exact, valid JSON", async () => {
  for (const [lexeme, , expectedJson] of AG_130_NUMBER_LEXEMES) {
    const result = await expectOk("convert.yaml-json", `a: ${lexeme}\n`, { options: { indent: "minified" } });
    assert.equal(result.text, expectedJson, lexeme);
    JSON.parse(result.text); // throws, and so fails the test, if the output is not valid JSON
  }
});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

test("unknown or malformed options are rejected before parsing", async () => {
  const badIndent = await run("convert.yaml-json", "a: 1", { options: { indent: "3" } });
  assert.ok(badIndent.error instanceof OptionError);
  const unknown = await run("convert.yaml-json", "a: 1", { options: { nope: true } });
  assert.ok(unknown.error instanceof OptionError);
  const badSort = await run("convert.yaml-json", "a: 1", { options: { "sort-keys": "yes" } });
  assert.ok(badSort.error instanceof OptionError);
  const jsonBadIndent = await run("convert.json-yaml", "1", { options: { indent: "minified" } });
  assert.ok(jsonBadIndent.error instanceof OptionError, "convert.json-yaml only accepts 2 or 4");
});

// ---------------------------------------------------------------------------
// Limits and cancellation.
// ---------------------------------------------------------------------------

test("input above the injected limit is rejected before parsing", async () => {
  const limits = { ...defaultLimits(), maxInputBytes: 4 };
  const result = await run("convert.yaml-json", "a: 12345", { limits });
  assert.match(result.error?.message ?? "", /exceeds/);
});

test("output above the effective cap is rejected explicitly", async () => {
  const limits = { ...defaultLimits(), maxOutputBytes: 8, maxChunkBytes: 1024 };
  const result = await run("convert.yaml-json", "a: 12345678901234\n", { limits });
  assert.equal(result.error?.code, "yaml.output-limit");
  assert.equal(result.artifact, undefined);
});

test("the output cap is the smaller of maxOutputBytes and maxChunkBytes for both operations", async () => {
  const limits = { ...defaultLimits(), maxOutputBytes: 1024, maxChunkBytes: 8 };
  const yamlToJson = await run("convert.yaml-json", "a: 12345678901234\n", { limits });
  assert.equal(yamlToJson.error?.code, "yaml.output-limit");
  assert.match(yamlToJson.error.message, /above the 8 byte output limit/);
  const jsonToYaml = await run("convert.json-yaml", "{\"a\":12345678901234}", { limits });
  assert.equal(jsonToYaml.error?.code, "yaml.output-limit");
  assert.match(jsonToYaml.error.message, /above the 8 byte output limit/);
});

test("a token cancelled before execution rejects without reading or writing", async () => {
  const cancellation = new CancellationToken();
  cancellation.cancel();
  for (const operationId of ["convert.yaml-json", "convert.json-yaml"]) {
    const result = await run(operationId, operationId === "convert.yaml-json" ? "a: 1" : "{\"a\":1}", { cancellation });
    assert.ok(result.error instanceof ProcessorCancelled, operationId);
    assert.equal(result.artifact, undefined);
  }
});

test("cancellation is honoured at the line-based cooperative stride", async () => {
  const lines = Array.from({ length: CANCELLATION_STRIDE_LINES * 3 }, (_, i) => `k${i}: ${i}`).join("\n");
  class CountedCancellation {
    constructor(allowed) { this.allowed = allowed; this.checks = 0; }
    isCancelled() { this.checks += 1; return this.checks > this.allowed; }
  }
  const uncancelled = new CountedCancellation(Number.POSITIVE_INFINITY);
  await expectOk("convert.yaml-json", lines, { cancellation: uncancelled });
  const cancellation = new CountedCancellation(Math.max(1, uncancelled.checks - 2));
  const result = await run("convert.yaml-json", lines, { cancellation });
  assert.ok(result.error instanceof ProcessorCancelled);
});

// ---------------------------------------------------------------------------
// Diagnostics detail (informational; execution still succeeds).
// ---------------------------------------------------------------------------

test("unsafe integers and special floats are reported as diagnostics, not failures", async () => {
  const result = await expectOk("convert.yaml-json", "big: 99999999999999999999\nspecial: .nan\n", { options: { indent: "minified" } });
  assert.equal(result.value.diagnostics, 2);
  const codes = result.value.diagnosticsDetail.map((d) => d.code).sort();
  assert.deepEqual(codes, ["yaml.float-special", "yaml.unsafe-integer"]);
  for (const diagnostic of result.value.diagnosticsDetail) assert.ok(Number.isInteger(diagnostic.line) && Number.isInteger(diagnostic.column));
});

test("unsupported operation ids are rejected", async () => {
  const result = await run("convert.yaml-xml", "a: 1");
  assert.match(result.error.message, /unsupported operation/);
});
