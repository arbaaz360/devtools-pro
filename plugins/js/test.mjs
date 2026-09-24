import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorContext, SeededRandom, defaultLimits } from "../../packages/plugin-sdk/src/index.ts";
import { execute, JsError } from "./processor.mjs";

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

    const minified = await expectOk("minify", input);

    if (sourceCompiles) {
       assert.doesNotThrow(() => new vm.Script(minified.text), `minified ${JSON.stringify(input)} must compile`);
    }
    const inputResult = evaluate(input);
    const minResult = evaluate(minified.text);
    assert.equal(minResult, inputResult, `minify changes result for ${JSON.stringify(input)}`);

    const beautified = await run("beautify", input);
    if (beautified.error) {
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
