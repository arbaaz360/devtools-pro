import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { mkdtempSync, writeFileSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorContext, SeededRandom,
} from "../../packages/plugin-sdk/src/context.ts";
import { validateManifest } from "../../packages/plugin-contract/ts/validate.ts";
import { execute, format, JsxError, normalizeOptions } from "./processor.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
const descriptor = JSON.parse(await readFile(new URL("./plugin.json", import.meta.url), "utf8"));

const fixtureFiles = (await readdir(new URL("./fixtures", import.meta.url))).filter(f => f.endsWith(".json"));
const allFixtures = [];
for (const file of fixtureFiles) {
  const content = await readFile(new URL(`./fixtures/${file}`, import.meta.url), "utf8");
  allFixtures.push(JSON.parse(content));
}

async function run(operation, options, input, { reader, cancellation = new CancellationToken(), limits } = {}) {
  const source = reader ?? new MemoryReader().insert("input", encoder.encode(input));
  const before = source instanceof MemoryReader ? source.inputs.get("input").slice() : null;
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(source, outputs, cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), limits);
  const report = await execute({ pluginId: "convert.jsx", toolId: "convert.jsx", operationId: operation, options }, context);
  if (before) assert.deepEqual(source.inputs.get("input"), before, "source bytes must be untouched");
  const bytes = outputs.bytes.get("output");
  return { report, value: outputs.values.get("output"), bytes, text: bytes ? decoder.decode(bytes) : undefined, outputs };
}

async function rejects(operation, options, input, code, extra = {}) {
  const sink = new MemoryOutputSink();
  let caught;
  try {
    const context = new ProcessorContext(new MemoryReader().insert("input", encoder.encode(input)), sink, new CancellationToken(), new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), extra.limits);
    await execute({ operationId: operation, options }, context);
  } catch (error) { caught = error; }
  assert.ok(caught, `expected ${code} for ${JSON.stringify(input).slice(0, 60)}`);
  assert.ok(caught instanceof JsxError, `expected JsxError, got ${caught.name}: ${caught.message}`);
  assert.equal(caught.code, code, caught.message);
  assert.equal(sink.bytes.size + sink.values.size, 0, "no output may be written on failure");
  return caught;
}

function assertDiagnostics(actual, expected, name) {
  assert.equal(actual.length, expected.length, `${name}: expected ${expected.length} diagnostics, got ${JSON.stringify(actual)}`);
  for (let index = 0; index < expected.length; index += 1) {
    for (const [key, value] of Object.entries(expected[index])) {
      assert.deepEqual(actual[index][key], value, `${name}: diagnostic ${index} field ${key}`);
    }
  }
}

test("fixtures produce the expected output or error", async () => {
  assert.ok(allFixtures.length >= 40, `expected at least 40 fixtures, found ${allFixtures.length}`);
  for (const item of allFixtures) {
    if (item.error) {
      const caught = await rejects(item.operationId, item.options, item.input.input, item.error);
      assert.ok(caught, `fixture ${item.id} should fail`);
    } else {
      const result = await run(item.operationId, item.options, item.input.input);
      assert.equal(result.text, item.output.output, `fixture ${item.id} output`);
      assertDiagnostics(result.value.annotations, item.diagnostics, item.id);
      assert.equal(result.value.diagnostics, item.diagnostics.length, `${item.id}: diagnostics count`);
    }
  }
});

test("the manifest is contract-valid and matches the processor", () => {
  validateManifest(manifest);
  assert.equal(descriptor.processor, "processor.mjs");
  assert.equal(descriptor.manifest, "manifest.json");
  assert.equal(manifest.id, "convert.jsx");
  assert.deepEqual(manifest.tests.requirementIds, ["DU-24"]);
});

test("normalizeOptions accepts every declared indent spelling", () => {
  assert.equal(normalizeOptions({ indent: "spaces-2" }).indent, "2");
  assert.equal(normalizeOptions({ indent: "spaces-4" }).indent, "4");
  assert.equal(normalizeOptions({ indent: "tab" }).indent, "tab");
});

test("the processor imports no Node built-in", async () => {
  const source = await readFile(new URL("./processor.mjs", import.meta.url), "utf8");
  assert.equal(/\bfrom\s+["']node:/u.test(source), false, "processor.mjs must not import a node: module");
  assert.equal(/\brequire\s*\(/u.test(source), false, "processor.mjs must not call require()");
});

test("every package file uses LF line endings", async () => {
  const files = ["processor.mjs", "test.mjs", "manifest.json", "plugin.json", "README.md"];
  for (const file of files) {
    let text;
    try {
      text = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
    } catch { continue; }
    assert.equal(text.includes("\r"), false, `${file} must use LF line endings`);
  }
});

// AG-129: the independent review (AST-014/015/016) found that this converter could change
// what an HTML fragment means while reporting success. A fixture that compares this tool's
// own output against a hand-recorded copy of that same output cannot catch that class of
// bug (see "Where an expected value comes from" in docs/WORKER_PROTOCOL.md): it would keep
// passing while the tool is wrong. So this corpus is judged by an oracle the converter does
// not share: the TypeScript 7 compiler (for "does this JSX mean what we think"), and text,
// attribute and style expectations written by hand from the HTML, never produced by running
// the converter itself.
const ORACLE_CASES = [
  // AST-014 reproduction: text beside an inline element must not lose its spaces.
  { id: "DU-24-ORACLE-text-inline-space", html: "<p>Hello <b>world</b> !</p>", expectedText: "Hello world !" },
  { id: "DU-24-ORACLE-inline-at-start", html: "<p><b>Start</b> middle text</p>", expectedText: "Start middle text" },
  { id: "DU-24-ORACLE-inline-at-end", html: "<p>leading text <b>End</b></p>", expectedText: "leading text End" },
  { id: "DU-24-ORACLE-nested-inline", html: "<p>a <b>bold <i>and italic</i> end</b> z</p>", expectedText: "a bold and italic end z" },
  // JSX text decodes named character references itself (a language-level rule, independent
  // of this converter), so &nbsp; in the source becomes a literal U+00A0 in the rendered text.
  { id: "DU-24-ORACLE-nbsp", html: "<p>a &nbsp;<b>b</b></p>", expectedText: "a  b" },
  { id: "DU-24-ORACLE-several-spaces", html: "<p>a    <b>b</b>    c</p>", expectedText: "a b c" },
  // <pre> text is exact: no collapsing, no reflowing.
  { id: "DU-24-ORACLE-pre", html: "<pre>  line one\n  line two  </pre>", expectedText: "  line one\n  line two  " },

  // AST-015 reproduction: an unquoted attribute value ends only at whitespace or '>'.
  {
    id: "DU-24-ORACLE-unquoted-value-chars",
    html: "<a href=http://x.com/a?b=c&d=e>link</a>",
    check: (root) => assert.equal(root.props.href, "http://x.com/a?b=c&d=e"),
  },

  // AST-016 reproductions: style objects keep what they were given.
  {
    id: "DU-24-ORACLE-custom-property",
    html: '<div style="--brand-color: red; color: var(--brand-color)"></div>',
    check: (root) => {
      assert.equal(root.props.style["--brand-color"], "red");
      assert.equal(root.props.style.color, "var(--brand-color)");
    },
  },
  {
    id: "DU-24-ORACLE-data-url-style",
    html: '<div style="background-image: url(data:image/png;base64,YQ==)"></div>',
    check: (root) => assert.equal(root.props.style.backgroundImage, "url(data:image/png;base64,YQ==)"),
  },
  {
    id: "DU-24-ORACLE-quoted-semicolon-style",
    html: "<div style='content: \"a;b\"; color: red'></div>",
    check: (root) => {
      assert.equal(root.props.style.content, '"a;b"');
      assert.equal(root.props.style.color, "red");
    },
  },
  {
    id: "DU-24-ORACLE-svg-presentation",
    html: '<svg viewBox="0 0 10 10"><path stroke-width="2" fill-opacity="0.5" /></svg>',
    check: (root) => {
      assert.equal(root.props.viewBox, "0 0 10 10");
      const path = root.children.find((c) => c && c.type === "path");
      assert.ok(path, "expected an svg <path> child");
      assert.equal(path.props.strokeWidth, "2");
      assert.equal(path.props.fillOpacity, "0.5");
    },
  },
];

// Every JSXText node must sit on a single source line, so we strip format()'s outer
// fragment wrapper (added for every case regardless of the "wrap" option) and return the
// element expression as-is; this keeps the compiled tree's root the case's own element.
function unwrapFragment(output) {
  const match = /^<>\n([\s\S]*)\n<\/>$/.exec(output);
  assert.ok(match, `expected format() to wrap output in a fragment: ${output}`);
  return match[1];
}

function textOf(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "children" in node) return node.children.map(textOf).join("");
  return "";
}

test("independent oracle: emitted JSX compiles and renders the HTML's meaning (AG-129)", async () => {
  let tscPath;
  try {
    const desktopRequire = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
    tscPath = join(dirname(desktopRequire.resolve("typescript/package.json")), "bin/tsc");
  } catch (error) {
    assert.fail(
      `TypeScript must be installed at apps/desktop for this oracle (run "pnpm --dir apps/desktop install --frozen-lockfile" first): ${error.message}`,
    );
  }

  const preamble = [
    "declare global {",
    "  const React: { createElement: (...args: unknown[]) => unknown; readonly Fragment: unique symbol };",
    "  namespace JSX { interface IntrinsicElements { [name: string]: unknown } interface Element {} }",
    "}",
    "",
  ].join("\n");

  let source = preamble;
  for (const [index, testCase] of ORACLE_CASES.entries()) {
    const result = format(testCase.html, testCase.options ?? {}, () => {});
    source += `\nexport function Case${index}() {\n  return (\n${unwrapFragment(result.output)}\n  );\n}\n`;
  }

  const dir = mkdtempSync(join(tmpdir(), "jsx-oracle-"));
  const tsxFile = join(dir, "oracle.tsx");
  writeFileSync(tsxFile, source, "utf8");

  const compiled = spawnSync(process.execPath, [tscPath, "--ignoreConfig", "--jsx", "react", "--target", "ES2020", tsxFile], { encoding: "utf8" });
  assert.equal(compiled.status, 0, `emitted JSX must compile with no diagnostics:\n${compiled.stdout}${compiled.stderr}`);

  const jsFile = tsxFile.replace(/\.tsx$/, ".js");
  const mjsFile = tsxFile.replace(/\.tsx$/, ".mjs");
  renameSync(jsFile, mjsFile);

  const previousReact = globalThis.React;
  globalThis.React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    Fragment: Symbol("Fragment"),
  };
  try {
    const compiledModule = await import(pathToFileURL(mjsFile).href);
    for (const [index, testCase] of ORACLE_CASES.entries()) {
      const root = compiledModule[`Case${index}`]();
      if (testCase.expectedText !== undefined) {
        assert.equal(textOf(root), testCase.expectedText, `${testCase.id}: rendered text`);
      }
      if (testCase.check) testCase.check(root);
    }
  } finally {
    globalThis.React = previousReact;
  }
});
