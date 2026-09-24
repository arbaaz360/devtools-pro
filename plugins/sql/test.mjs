import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorCancelled, ProcessorContext, SeededRandom, defaultLimits } from "../../packages/plugin-sdk/src/index.ts";
import { execute } from "./processor.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
const operation = (id) => manifest.operations.find((item) => item.id === id);
const manifestLimits = (operationId) => Object.fromEntries(Object.entries(operation(operationId).limits).map(([key, value]) => [key, Number(value)]));

function makeContext(input, { limits, cancellation = new CancellationToken() } = {}) {
  const reader = new MemoryReader().insert("input", encoder.encode(input));
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
  return { text: decoder.decode(bytes), value, artifact: outputs.artifacts.get("output") };
}

async function rejects(operationId, options, input, expected, settings) {
  const { outputs, context } = makeContext(input, settings);
  await assert.rejects(() => execute({ operationId, options }, context), expected);
  assert.equal(outputs.bytes.size, 0, "a failed run writes no artifact");
  assert.equal(outputs.values.size, 0, "a failed run writes no value");
}

for (const vector of await fixture("beautify")) {
  test(`beautify fixture: ${vector.name}`, async () => {
    const result = await run("beautify", vector.options, vector.input);
    assert.equal(result.text, vector.output);

      // Idempotency check: beautify -> minify -> beautify == beautify
      if (result.comments === 0) {
        const minified = await run("minify", vector.options, result.text);
        const reBeautified = await run("beautify", vector.options, minified.text);
        assert.equal(reBeautified.text, vector.output, "re-beautified minified text must be identical to original beautified text");
      }
  });
}

for (const vector of await fixture("minify")) {
  test(`minify fixture: ${vector.name}`, async () => {
    const result = await run("minify", vector.options, vector.input);
    assert.equal(result.text, vector.output);
  });
}

for (const vector of await fixture("invalid")) {
  test(`invalid fixture: ${vector.name}`, async () => {
    await rejects(vector.operationId, vector.options, vector.input, (error) => {
      assert.ok(error instanceof Error && !(error instanceof ProcessorCancelled));
      assert.ok(error.message.includes(vector.error), `expected "${error.message}" to include "${vector.error}"`);
      return true;
    });
  });
}

test("a cancelled token rejects both operations before any output, even for an empty document", async () => {
  for (const operationId of ["sql.beautify", "sql.minify"]) for (const input of ["SELECT 1", ""]) {
    const cancellation = new CancellationToken();
    cancellation.cancel();
    await rejects(operationId, {}, input, ProcessorCancelled, { cancellation });
  }
});

// AST-002 reopened: each dialect lexes by its own rules. No engine for these dialects runs
// here, so the expected texts are written by hand from each one's documentation:
// MySQL 8.0 manual 11.7 (comments: "--" needs a following space; /*! */ runs; /*+ */ hints)
// and 11.1.1 (string literals: "..." is a string in the default mode; backslash escapes);
// PostgreSQL 16 manual 4.1.2.2 (E'' strings), 4.1.2.4 (dollar quoting), 4.1.5 (nested
// comments); Oracle 23 SQL Language Reference, Text Literals (q'[...]' quoting).
const BS = String.fromCharCode(92);
const DIALECT_CASES = [
  // [dialect, source, exact Minify output, text Beautify must keep intact]
  ["mysql", "SELECT 1--1 AS answer;", "SELECT 1- -1 AS answer;", null],
  ["mariadb", "SELECT 1--1 AS answer;", "SELECT 1- -1 AS answer;", null],
  ["mysql", "SELECT 1-- note\n+2 AS n;", "SELECT 1+2 AS n;", "-- note"],
  ["mysql", `SELECT "a${BS}"  b" AS s;`, `SELECT"a${BS}"  b"AS s;`, `"a${BS}"  b"`],
  ["mysql", `SELECT 'it${BS}'s -- x' AS s;`, `SELECT'it${BS}'s -- x'AS s;`, `'it${BS}'s -- x'`],
  ["mysql", "SELECT /*!40001 SQL_NO_CACHE */ a FROM t;", "SELECT /*!40001 SQL_NO_CACHE */ a FROM t;", "/*!40001 SQL_NO_CACHE */"],
  ["mysql", "SELECT /*+ BKA(t) */ a FROM t;", "SELECT /*+ BKA(t) */ a FROM t;", "/*+ BKA(t) */"],
  ["plsql", "SELECT /*+ INDEX(t) */ a FROM t;", "SELECT /*+ INDEX(t) */ a FROM t;", "/*+ INDEX(t) */"],
  ["plsql", "SELECT q'[it's -- here]' AS s FROM dual;", "SELECT q'[it's -- here]'AS s FROM dual;", "q'[it's -- here]'"],
  ["postgresql", `SELECT E'a${BS}'  select b' AS s;`, `SELECT E'a${BS}'  select b'AS s;`, `E'a${BS}'  select b'`],
  ["postgresql", "SELECT /* a /* b */ still comment */ 1 AS n;", "SELECT 1 AS n;", "/* a /* b */ still comment */"],
  ["postgresql", "SELECT $tag$ a -- b $tag$ AS s, $1 AS p;", "SELECT $tag$ a -- b $tag$AS s,$1 AS p;", "$tag$ a -- b $tag$"],
  // Standard SQL keeps its own rules: -- always starts a comment, backslash is plain text.
  ["sql", "SELECT 1--1\n AS answer;", "SELECT 1 AS answer;", "--1"],
];

test("each dialect lexes comments and strings by its own rules (AST-002)", async () => {
  for (const [dialect, source, minified, kept] of DIALECT_CASES) {
    assert.equal((await run("minify", { dialect }, source)).text, minified, `${dialect} minify ${JSON.stringify(source)}`);
    const beautified = (await run("beautify", { dialect }, source)).text;
    if (kept) assert.ok(beautified.includes(kept), `${dialect} beautify keeps ${kept}: ${JSON.stringify(beautified)}`);
  }
  // Beautify keeps MySQL's two minus signs apart, as Minify does.
  assert.doesNotMatch((await run("beautify", { dialect: "mysql" }, "SELECT 1--1 AS answer;")).text, /--/);
});

test("Beautify is linear in its input: 432 KB well inside the 5 s deadline", async () => {
  // It was quadratic (a string read and trimmed at its end once per token): this input
  // took 54 s. Linear, it takes about a tenth of a second; the bound leaves room for CI.
  const text = "SELECT a, b + 1 AS c FROM t WHERE x = 'y' AND z <> 2;\n".repeat(8000);
  const started = performance.now();
  const result = await run("beautify", {}, text, { limits: { ...defaultLimits(), maxOutputBytes: 8 << 20, maxChunkBytes: 8 << 20 } });
  const elapsed = performance.now() - started;
  assert.ok(result.text.length > text.length, "beautify produced its output");
  assert.ok(elapsed < 3000, `beautify of ${text.length} bytes took ${Math.round(elapsed)} ms`);
});

test("oracle test: SQLite parity", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const corpus = [
    "SELECT 1 - -2 AS answer;",
    "SELECT 1 - - -2 AS answer;",
    "SELECT -(-1) AS answer;",
    "SELECT 4 / -2 AS answer;",
    "SELECT 2 * -3 AS answer;",
    "SELECT 1E+3 AS n;",
    "SELECT 1e3 AS n;",
    "SELECT 1E-3 AS n;",
    "SELECT .5 AS n;",
    "SELECT 5. AS n;",
    "SELECT 0x1F AS n;",
    "SELECT '--not a comment' AS n;",
    "SELECT '/* not a comment */' AS n;",
    "SELECT 1 AS \"--x\";",
    "SELECT 1 AS \"/*x*/\";",
    "SELECT CASE WHEN 1 THEN 2 ELSE 3 END AS n;",
    "SELECT (SELECT 1) AS n;",
    "SELECT 'a' || 'b' AS n;",
    "SELECT 1 <> 2 AS n;",
    "SELECT 1 <= 2 AS n;",
    "SELECT 1 >= 2 AS n;",
    "SELECT 1 -- kept comment \n + 2 AS n;",
    // Found verifying AG-128: an upper-case hex prefix, and Beautify joining two strings
    // into one (`'a' 'b'` is the string a aliased b; `'a''b'` is the string a'b).
    "SELECT 0X1f AS n;",
    "SELECT 'a' 'b';",
    "SELECT 'a''b' 'c';",
    "SELECT 'x' AS \"q\", 'y' \"r\";",
    // Standard SQL (and SQLite): a backslash is plain text, so this string ends at \'.
    `SELECT 'a${String.fromCharCode(92)}' AS x, 'b' AS y;`
  ];

  for (const query of corpus) {
    const originalRows = db.prepare(query).all();

    const minified = await run("minify", {}, query);
    const minifyRows = db.prepare(minified.text).all();
    assert.deepEqual(minifyRows, originalRows, `Minify changed meaning of: ${query}`);

    const beautified = await run("beautify", {}, query);
    const beautifyRows = db.prepare(beautified.text).all();
    assert.deepEqual(beautifyRows, originalRows, `Beautify changed meaning of: ${query}`);
  }
});
