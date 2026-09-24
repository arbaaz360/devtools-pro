import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorContext, SeededRandom, defaultLimits } from "../../packages/plugin-sdk/src/index.ts";
import { execute, JsError, sameTree } from "./processor.mjs";
import { parse } from "../../packages/vendor/acorn/acorn.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

async function run(operationId, input, { limits, cancellation = new CancellationToken(), reader, request, options = {} } = {}) {
  const source = typeof input === "string" ? encoder.encode(input) : input;
  reader ??= new MemoryReader().insert("input", source);
  const before = reader instanceof MemoryReader ? reader.inputs.get("input").slice() : null;
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(reader, outputs, cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), limits ?? defaultLimits());
  let error = null;
  let returned;
  try { returned = await execute(request ?? { operationId, options }, context); } catch (caught) { error = caught; }
  if (before) assert.deepEqual(reader.inputs.get("input"), before, "source bytes must remain immutable");
  const bytes = outputs.bytes.get("output");
  const properties = outputs.values.get("output");
  return { error, returned, bytes, text: bytes ? decoder.decode(bytes) : null, properties };
}

async function expectOk(operationId, input, options) {
  const result = await run(operationId, input, { options });
  if (result.error) throw result.error;
  return result;
}

const corpus = [
  "(()=>{function f(){return\n{a:1}};return f()})()",
  "// @license MIT\nglobalThis.answer=42",
  "(1 .toString())",
  "a=1\rb=2",
  "function f(){return\n{}} f()",
  "function f(){try{throw\n1}catch(e){return e}} f()",
  "let i=0;while(i<1){i++;break\n}",
  "let i=0;while(i<1){i++;continue\n}",
  "function* f(){yield\n1} f().next().value",
  "const f = async\n()=>1; typeof f",
  "let a=1,b=1;a\n++b;a+b",
  "let a=1,b=1;a\n--b;a+b",
  "let a=()=>1;let b=2;a\n(b)",
  "let a=1,b=2;a/(b)/g",
  "function f(){return\n/a/g} f()",
  "let a=1; a/ /a/g",
  "`//`",
  "`/*`",
  "'*/'",
  "let a=1; // end",
  "let a=1\r\n++a",
  "let a=1\r++a",
  "let a=1\u2028++a",
  "let a=1\u2029++a",
  "'a'\n+'b'",
  "1\n-1",
  "`temp`\n.length",
  "(1)\n[0]",
  "lbl: while(true) { continue lbl\n}"
];

function evaluate(source) {
  const sandbox = {};
  vm.createContext(sandbox);
  try {
    const result = vm.runInContext(source, sandbox, { timeout: 50 });
    return JSON.stringify({ result, globals: sandbox });
  } catch (e) {
    return e.name;
  }
}

test("oracle test for minify and beautify", async () => {
  for (const input of corpus) {
    let sourceCompiles = true;
    try { new vm.Script(input); } catch(e) { sourceCompiles = false; }

    const inputResult = evaluate(input);
    const minified = await run("minify", input);
    if (!sourceCompiles) {
      // Not JavaScript (`throw` then a line break is a syntax error): Minify says so, and
      // where, rather than writing out a rewrite of it.
      assert.equal(minified.error?.code, "js.syntax-error", `minify refuses ${JSON.stringify(input)}`);
    } else {
      assert.ifError(minified.error);
      assert.doesNotThrow(() => new vm.Script(minified.text), `minified ${JSON.stringify(input)} must compile`);
      assert.equal(evaluate(minified.text), inputResult, `minify changes result for ${JSON.stringify(input)}`);
    }

    const beautified = await run("beautify", input);
    if (!sourceCompiles && !beautified.error) {
      // Not JavaScript, so there is no meaning to keep: laid out anyway, and marked unchecked.
      assert.equal(beautified.properties.verified, false, JSON.stringify(input));
    } else if (beautified.error) {
       assert.equal(beautified.error.code, "js.beautify.changes-meaning");
    } else {
       if (sourceCompiles) {
         assert.doesNotThrow(() => new vm.Script(beautified.text), `beautified ${JSON.stringify(input)} must compile`);
       }
       const beautResult = evaluate(beautified.text);
       assert.equal(beautResult, inputResult, `beautify changes result for ${JSON.stringify(input)}`);
    }
  }
});

try {
  const beautifyCases = await fixture("beautify");
  for (const item of beautifyCases) {
    test(`beautify: ${item.name}`, async () => {
      const formatted = await expectOk("beautify", item.input, item.options);
      assert.equal(formatted.text, item.output);
    });
  }
} catch (e) {
  console.log("No beautify fixtures yet.");
}

try {
  const minifyCases = await fixture("minify");
  for (const item of minifyCases) {
    test(`minify: ${item.name}`, async () => {
      if (item.refused) {
        // The input is not JavaScript: a refusal naming the reason, and nothing written.
        const result = await run("minify", item.input, { options: item.options });
        assert.equal(result.error?.code, item.refused, `expected a refusal, got ${JSON.stringify(result.text)}`);
        assert.equal(result.bytes, undefined);
        return;
      }
      const minified = await expectOk("minify", item.input, item.options);
      assert.equal(minified.text, item.output);
    });
  }
} catch (e) {
  console.log("No minify fixtures yet.");
}

test("idempotent round trip", async () => {
  const cases = [
    "function foo(a, b) {\n    return a + b;\n}",
    "const a = 'hello \\'world\\'';",
    "const b = `template ${foo} string`;",
    "const c = /regex\\/here/g;"
  ];
  
  for (const input of cases) {
    const f1 = await expectOk("beautify", input);
    const m1 = await expectOk("minify", f1.text);
    const f2 = await expectOk("beautify", m1.text);
    assert.equal(f2.text, f1.text, "minify(beautify(x)) beautified again equals beautify(x)");
  }
});

test("literal preservation", async () => {
  const inputs = [
    { name: "strings", text: "const a = 'hello world';" },
    { name: "templates", text: "const b = `hello world`;" },
    { name: "regexes", text: "const c = /hello world/g;" }
  ];
  
  for (const item of inputs) {
    const minified = await expectOk("minify", item.text);
    const expectedLiteral = item.text.substring(item.text.indexOf("=") + 2, item.text.length - 1);
    assert.ok(minified.text.includes(expectedLiteral), `${item.name} must be byte-identical before and after minify`);
  }
});

// ---------------------------------------------------------------------------
// AST-001 (third review): the programs a hand-written tokenizer got wrong. The oracle is
// node's vm: the source and the output, each run in a fresh context, give the same value
// and the same globals, or Beautify refuses. Line separators are named by code, so no
// editing tool can turn the escapes into the characters.
// ---------------------------------------------------------------------------

const CR = String.fromCharCode(13), LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
const REVIEW_PROGRAMS = [
  "(()=>{function f(){return\n`hello`};return f()})()",
  "if(true) /a  b/.test(\"a  b\")",
  "if(false){} /[ ]/.test(\" \")",
  "if(true)/[/*]/.test('*')",
  "(()=>{let π = 3; return π})()",
  "(()=>{let 変数 = 3; return 変数})()",
  `(()=>{function f(){return/*${CR}*/{a:1}};return f()})()`,
  `(()=>{function f(){return/*${LS}*/{a:1}};return f()})()`,
  `(()=>{function f(){return/*${PS}*/{a:1}};return f()})()`,
  "var a={b:{c:1}};a?.b?.c",
  "var n=null;n?.x ?? 'd'",
  "`a${`b${1+1}`}c`",
  "var a=1;a- --a",
  "var a=1;-a- -a",
  "var s='a/b';s.split(/\\//).length",
  "var a=4,g=2;a/2/g",
  "var o={get x(){return 1}};o.x",
  "class C{#p=1;has(o){return #p in o}};new C().has(new C())",
  "var n=1_000_000+10n.toString().length;n",
  "var f=async\nfunction g(){};typeof g",
  "var a=[1]\n[0]\na",
];

test("AST-001: the third review's programs mean the same after both operations", async () => {
  for (const source of REVIEW_PROGRAMS) {
    const expected = evaluate(source);
    const minified = await run("minify", source);
    assert.ifError(minified.error);
    assert.equal(evaluate(minified.text), expected, `minify ${JSON.stringify(source)} -> ${JSON.stringify(minified.text)}`);
    assert.equal(minified.properties.verified, true);
    const beautified = await run("beautify", source);
    if (beautified.error) assert.equal(beautified.error.code, "js.beautify.changes-meaning", JSON.stringify(source));
    else assert.equal(evaluate(beautified.text), expected, `beautify ${JSON.stringify(source)} -> ${JSON.stringify(beautified.text)}`);
  }
  // The one js-beautify would change is refused, not written: a template after `return`.
  assert.equal((await run("beautify", REVIEW_PROGRAMS[0])).error?.code, "js.beautify.changes-meaning");
});

test("input that is not JavaScript: Minify refuses and says where; Beautify formats and says it was not checked", async () => {
  const minified = await run("minify", "let a b c;");
  assert.equal(minified.error?.code, "js.syntax-error");
  assert.deepEqual([minified.error.diagnostic.data.line, minified.error.diagnostic.data.column], [1, 7]);
  const beautified = await run("beautify", "const el = <div>{a}</div>;");
  assert.ifError(beautified.error);
  assert.equal(beautified.properties.verified, false);
  assert.match(beautified.properties.note, /^Not checked: the input does not parse as JavaScript \(line 1, column 12\)/);
  // Valid code says it was checked.
  assert.equal((await run("beautify", "const a = 1;")).properties.verified, true);
});

test("a CommonJS top-level return, a hashbang and a module all read as what they are", async () => {
  assert.equal((await expectOk("minify", "if (a) return b;\nelse throw c;")).text, "if(a)return b;else throw c;");
  assert.equal((await expectOk("minify", "#!/usr/bin/env node\nconsole.log( 1 )\n")).text, "#!/usr/bin/env node\nconsole.log(1)");
  assert.equal((await expectOk("minify", "import x from 'y';\nexport const z = await x;")).text, "import x from'y';export const z=await x;");
});

test("a kept licence comment stays where the grammar needs it", async () => {
  assert.equal((await expectOk("minify", "a = 1 /*! keep */ + 2;")).text, "a=1 /*! keep */+2;");
  // A line break inside a kept comment's gap is kept: here it ends the return.
  const kept = await expectOk("minify", "function f(){ return /*! keep */\n 1 }");
  assert.equal(kept.text, "function f(){return\n/*! keep */\n1}");
  assert.equal(evaluate(`${kept.text};f()`), evaluate("function f(){ return /*! keep */\n 1 };f()"));
});

test("sameTree compares programs, not their layout", () => {
  const tree = (source) => parse(source, { ecmaVersion: "latest" });
  assert.ok(sameTree(tree("let a = b - -c;"), tree("let a=b- -c")));
  assert.ok(!sameTree(tree("let a = b - -c;"), tree("let a = b - c;")));
  assert.ok(!sameTree(tree("x = /a/g"), tree("x = /a/i")));
  assert.ok(!sameTree(tree("x = 1"), tree("x = 2")));
  assert.ok(!sameTree(tree("x = `a${b}`"), tree("x = `a ${b}`")), "a template's own text counts");
  assert.ok(sameTree(tree("x = 0x10"), tree("x = 16")), "a literal is its value, not its spelling");
  assert.ok(!sameTree(tree("function f(){return\n1}"), tree("function f(){return 1}")));
  // Deep nesting is walked without recursion.
  const deep = `${"[".repeat(500)}${"]".repeat(500)}`;
  assert.ok(sameTree(tree(deep), tree(deep)));
});

test("nesting deeper than the parser can follow is refused, not crashed on", async () => {
  const result = await run("minify", `x = ${"[".repeat(5000)}${"]".repeat(5000)};`);
  assert.equal(result.error?.code, "js.syntax-error");
  assert.match(result.error.message, /stack/);
});

test("a 1 MiB program minifies and beautifies well inside the 5 s deadline", async () => {
  const unit = "function f(a, b) { if (a > b) { return a - -b; } else { return `${a}/${b}`; } }\n";
  const source = unit.repeat(Math.ceil((1 << 20) / unit.length));
  const limits = { ...defaultLimits(), maxInputBytes: 4 << 20, maxOutputBytes: 8 << 20, maxChunkBytes: 8 << 20 };
  for (const operationId of ["minify", "beautify"]) {
    const started = performance.now();
    const result = await run(operationId, source, { limits });
    assert.ifError(result.error);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 3000, `${operationId} of ${source.length} bytes took ${Math.round(elapsed)} ms`);
  }
});
