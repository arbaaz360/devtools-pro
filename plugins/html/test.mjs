import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorContext, SeededRandom,
} from "../../packages/plugin-sdk/src/context.ts";
import { validateManifest } from "../../packages/plugin-contract/ts/validate.ts";
import {
  BLOCK_ELEMENTS, HtmlError, INLINE_ELEMENTS, OPERATIONS, OPTIONAL_END_TAG, RAW_TEXT_ELEMENTS, VOID_ELEMENTS,
  execute, isBlockElement, isInlineElement, normalizeOptions,
} from "./processor.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
const descriptor = JSON.parse(await readFile(new URL("./plugin.json", import.meta.url), "utf8"));

const beautifyFixtures = await fixture("beautify");
const minifyFixtures = await fixture("minify");
const largeFixtures = await fixture("large-list");
const invalidFixtures = await fixture("invalid");
const allFixtures = [
  ...beautifyFixtures.map((item) => ({ ...item, operation: "beautify" })),
  ...largeFixtures.map((item) => ({ ...item, operation: "beautify" })),
  ...minifyFixtures.map((item) => ({ ...item, operation: "minify" })),
];

/**
 * Runs one operation through the SDK context and asserts, on every single call,
 * that the source bytes handed to the reader were not modified.
 */
async function run(operation, options, input, { reader, cancellation = new CancellationToken(), limits } = {}) {
  const source = reader ?? new MemoryReader().insert("input", encoder.encode(input));
  const before = source instanceof MemoryReader ? source.inputs.get("input").slice() : null;
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(source, outputs, cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), limits);
  const report = await execute({ pluginId: "format.html", toolId: "format.html", operationId: operation, options }, context);
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
  assert.ok(caught instanceof HtmlError, `expected HtmlError, got ${caught.name}: ${caught.message}`);
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

test("beautify fixtures produce the documented output and diagnostics", async () => {
  assert.ok(beautifyFixtures.length >= 40, `expected at least 40 beautify fixtures, found ${beautifyFixtures.length}`);
  for (const item of [...beautifyFixtures, ...largeFixtures]) {
    const result = await run("beautify", item.options, item.input);
    assert.equal(result.text, item.output, `${item.name}: beautify output`);
    assertDiagnostics(result.value.annotations, item.diagnostics, item.name);
    assert.equal(result.value.diagnostics, item.diagnostics.length, `${item.name}: diagnostics count`);
  }
});

test("minify fixtures produce the documented output and diagnostics", async () => {
  assert.ok(minifyFixtures.length >= 10, `expected at least 10 minify fixtures, found ${minifyFixtures.length}`);
  for (const item of minifyFixtures) {
    const result = await run("minify", item.options, item.input);
    assert.equal(result.text, item.output, `${item.name}: minify output`);
    assertDiagnostics(result.value.annotations, item.diagnostics, item.name);
  }
});

test("every fixture name is unique and descriptive", () => {
  const names = allFixtures.map((item) => item.name);
  assert.equal(new Set(names).size, names.length, "fixture names must be unique");
  for (const name of names) assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/u, `fixture name ${name}`);
});

test("beautify then minify then beautify is byte-identical for every fixture without diagnostics", async () => {
  let checked = 0;
  for (const item of allFixtures) {
    if (item.diagnostics.length > 0) continue;
    const first = await run("beautify", item.options, item.input);
    const minified = await run("minify", item.options, first.text);
    const second = await run("beautify", item.options, minified.text);
    assert.equal(minified.value.diagnostics, 0, `${item.name}: minify of beautified output must stay clean`);
    assert.equal(second.value.diagnostics, 0, `${item.name}: re-beautify must stay clean`);
    assert.equal(second.text, first.text, `${item.name}: round trip is not byte-identical`);
    checked += 1;
  }
  assert.ok(checked >= 50, `expected at least 50 round-trip cases, checked ${checked}`);
});

test("both operations are idempotent for every fixture, tolerant cases included", async () => {
  for (const item of allFixtures) {
    for (const operation of OPERATIONS) {
      const once = await run(operation, item.options, item.input);
      const twice = await run(operation, item.options, once.text);
      assert.equal(twice.text, once.text, `${item.name}: ${operation} is not idempotent`);
    }
  }
});

test("invalid options and empty documents produce structured errors", async () => {
  for (const item of invalidFixtures) {
    await rejects("beautify", item.options, item.input, item.errorCode);
    await rejects("minify", item.options, item.input, item.errorCode);
  }
});

test("an unsupported operation is refused before the input is read", async () => {
  const error = await rejects("validate", {}, "<p>x</p>", "html.unsupported-operation");
  assert.deepEqual(error.diagnostic.data.supported, [...OPERATIONS]);
});

test("kebab-case ids and camelCase aliases agree", async () => {
  const input = "<html><head><title>x</title></head><body><div class=\"a\" id=\"b\"><!-- c --><p>y</p></div></body></html>";
  const kebab = await run("beautify", { "preserve-comments": false, "wrap-attributes": "force", "indent-inner-html": true }, input);
  const camel = await run("beautify", { preserveComments: false, wrapAttributes: "force", indentInnerHtml: true }, input);
  assert.equal(camel.text, kebab.text);
  assert.ok(!kebab.text.includes("<!--"), "preserve-comments: false must drop the comment");
  assert.ok(kebab.text.includes("    <div\n      class=\"a\"\n      id=\"b\">"), `wrap-attributes: force must break the tag:\n${kebab.text}`);
  assert.ok(kebab.text.includes("\n  <head>"), `indent-inner-html: true must indent <head>:\n${kebab.text}`);
});

test("normalizeOptions accepts every declared indent spelling and reports the canonical value", () => {
  for (const [supplied, expected] of [["2", "2"], [2, "2"], ["spaces-2", "2"], ["4", "4"], [4, "4"], ["spaces-4", "4"], ["tab", "tab"]]) {
    assert.equal(normalizeOptions({ indent: supplied }).indent, expected, `indent ${JSON.stringify(supplied)}`);
  }
  const defaults = normalizeOptions(undefined);
  assert.deepEqual(
    { indent: defaults.indent, preserveComments: defaults.preserveComments, wrapAttributes: defaults.wrapAttributes, indentInnerHtml: defaults.indentInnerHtml },
    { indent: "2", preserveComments: true, wrapAttributes: "auto", indentInnerHtml: false },
  );
});

test("indent choices emit two spaces, four spaces and one tab", async () => {
  const input = "<div><p>x</p></div>";
  assert.equal((await run("beautify", { indent: "2" }, input)).text, "<div>\n  <p>x</p>\n</div>");
  assert.equal((await run("beautify", { indent: "4" }, input)).text, "<div>\n    <p>x</p>\n</div>");
  assert.equal((await run("beautify", { indent: "tab" }, input)).text, "<div>\n\t<p>x</p>\n</div>");
});

test("void elements never get an end tag and a stray </br> is dropped with a diagnostic", async () => {
  for (const name of VOID_ELEMENTS) {
    const result = await run("beautify", {}, `<div><${name}></div>`);
    assert.ok(!result.text.includes(`</${name}>`), `${name}: an end tag must not be invented, got ${result.text}`);
    assert.equal(result.value.diagnostics, 0, `${name}: a void element alone is not a problem`);
  }
  const stray = await run("beautify", {}, "<p>one</br>two</p>");
  assert.equal(stray.text, "<p>onetwo</p>");
  assert.equal(stray.value.annotations[0].code, "html.void-end-tag");
  assert.equal(stray.value.annotations[0].severity, "warning");
  assert.match(stray.value.annotations[0].message, /<br>/u);
});

test("raw-text element content is emitted byte for byte by both operations", async () => {
  const bodies = {
    script: "\n  if (a < b) { f('</p>'); }\n\t// </ not a tag\n",
    style: "\n  a { color: red }\n\n  b { color: blue }\n",
    pre: "  keep\n   this\n\tand\ttabs",
    textarea: "line one\n  line two\n\n\nline five  ",
  };
  for (const [name, body] of Object.entries(bodies)) {
    const input = `<div>\n  <${name}>${body}</${name}>\n</div>`;
    for (const operation of OPERATIONS) {
      const result = await run(operation, {}, input);
      assert.ok(result.text.includes(`>${body}</${name}>`), `${name}/${operation}: content changed:\n${result.text}`);
    }
  }
});

test("tag and attribute names are compared case-insensitively and emitted as written", async () => {
  const result = await run("beautify", {}, "<DIV CLASS=\"a\"><P>one</p><BR></DIV>");
  assert.equal(result.text, "<DIV CLASS=\"a\">\n  <P>one</p>\n  <BR>\n</DIV>");
  assert.equal(result.value.diagnostics, 0, "</p> must close <P>");
});

test("optional end tags close implicitly and no omitted end tag is added", async () => {
  const cases = [
    ["<ul><li>a<li>b</ul>", "<ul>\n  <li>a\n  <li>b\n</ul>", ["li"]],
    ["<div><p>a<div>b</div></div>", "<div>\n  <p>a\n  <div>b</div>\n</div>", ["p"]],
    ["<dl><dt>t<dd>d</dl>", "<dl>\n  <dt>t\n  <dd>d\n</dl>", ["dt", "dd"]],
    ["<table><tr><td>a<td>b</table>", "<table>\n  <tr>\n    <td>a\n    <td>b\n</table>", ["tr", "td"]],
    ["<table><tbody><tr><td>a<tr><td>b</tbody></table>", "<table>\n  <tbody>\n    <tr>\n      <td>a\n    <tr>\n      <td>b\n  </tbody>\n</table>", ["tr", "td"]],
    ["<ul><li><span>x<li>y</ul>", "<ul>\n  <li><span>x\n  <li>y\n</ul>", ["li", "span"]],
    ["<select><option>a<option>b</select>", "<select><option>a<option>b</select>", ["option"]],
    ["<html><head><title>t</title><body><p>x</p></body></html>", "<html>\n<head>\n  <title>t</title>\n<body>\n  <p>x</p>\n</body>\n</html>", ["head"]],
  ];
  for (const [input, expected, omitted] of cases) {
    const result = await run("beautify", {}, input);
    assert.equal(result.text, expected, `input ${input}`);
    for (const name of omitted) {
      assert.equal(result.text.includes(`</${name}>`), false, `</${name}> must not be invented for ${input}: ${result.text}`);
    }
  }
});

test("a paragraph is closed by a block element but not by <br> or an unknown element", async () => {
  const closed = await run("beautify", {}, "<div><p>a<section>b</section></div>");
  assert.equal(closed.text, "<div>\n  <p>a\n  <section>b</section>\n</div>");
  assert.equal(closed.value.diagnostics, 0);
  for (const input of ["<p>one<br>two</p>", "<p>one<custom-tag>x</custom-tag>two</p>"]) {
    const kept = await run("beautify", {}, input);
    assert.equal(kept.value.diagnostics, 0, `${input} must not orphan the </p>: ${JSON.stringify(kept.value.annotations)}`);
    assert.ok(kept.text.trimEnd().endsWith("</p>"), `${input} keeps its own end tag:\n${kept.text}`);
  }
});

test("tolerant recovery reports a warning with byte offset, line and column", async () => {
  const cases = [
    { input: "<div>\n<span>text</div>", code: "html.mismatched-end-tag", tag: "div", line: 2, column: 11 },
    { input: "<div>\ntext</div>\n</section>", code: "html.stray-end-tag", tag: "section", line: 3, column: 1 },
    { input: "<div>\n<p>text</p>", code: "html.unclosed-element", tag: "div", line: 1, column: 1 },
    { input: "<p>x</p>\n</br>", code: "html.void-end-tag", tag: "br", line: 2, column: 1 },
    { input: "<a href=x\"y>t</a>", code: "html.unquoted-attribute", tag: "a", line: 1, column: 9 },
    { input: "<html><body><p>x</p></body></html>\n<p>after</p>", code: "html.content-after-html", tag: "html", line: 2, column: 1 },
  ];
  for (const item of cases) {
    const result = await run("beautify", {}, item.input);
    const diagnostic = result.value.annotations.find((entry) => entry.code === item.code);
    assert.ok(diagnostic, `${item.code} was not reported for ${JSON.stringify(item.input)}`);
    assert.equal(diagnostic.severity, "warning");
    assert.equal(diagnostic.data.tag, item.tag);
    assert.equal(diagnostic.line, item.line, `${item.code}: line`);
    assert.equal(diagnostic.column, item.column, `${item.code}: column`);
    assert.ok(Number.isInteger(diagnostic.offset) && diagnostic.offset >= 0, `${item.code}: byte offset`);
    assert.ok(diagnostic.end >= diagnostic.offset, `${item.code}: end offset`);
    assert.match(diagnostic.message, new RegExp(item.tag, "u"), `${item.code}: the message names the tag`);
    assert.ok(result.text.length > 0, `${item.code}: formatting must still produce output`);
  }
});

test("byte offsets stay ahead of code-unit offsets in a multi-byte document", async () => {
  const input = "<p>ééé \u{1f600}</p>\n</section>";
  const result = await run("beautify", {}, input);
  const diagnostic = result.value.annotations[0];
  assert.equal(diagnostic.code, "html.stray-end-tag");
  assert.equal(diagnostic.offset, encoder.encode("<p>ééé \u{1f600}</p>\n").byteLength);
  assert.equal(diagnostic.line, 2);
  assert.equal(diagnostic.column, 1);
});

test("CRLF counts as one line break when a position is derived", async () => {
  const input = "<div>\r\n<p>a</p>\r\n</section>";
  const result = await run("beautify", {}, input);
  const stray = result.value.annotations.find((entry) => entry.code === "html.stray-end-tag");
  assert.equal(stray.line, 3);
  assert.equal(stray.column, 1);
  assert.equal(stray.offset, encoder.encode("<div>\r\n<p>a</p>\r\n").byteLength);
});

test("input that is not UTF-8 is a structured error", async () => {
  const reader = new MemoryReader();
  reader.inputs.set("input", new Uint8Array([0x3c, 0x70, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x70, 0x3e]));
  const sink = new MemoryOutputSink();
  const context = new ProcessorContext(reader, sink, new CancellationToken(), new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets());
  await assert.rejects(
    () => execute({ operationId: "beautify", options: {} }, context),
    (error) => error instanceof HtmlError && error.code === "html.invalid-utf8",
  );
  assert.equal(sink.bytes.size + sink.values.size, 0);
});

test("properties report elements, attributes, comments, depth, diagnostics and bytes", async () => {
  const input = "<html><body><div class=\"a\" id=\"b\"><!-- c --><p title=\"t\">x</p><br></div></body></html>";
  const result = await run("beautify", {}, input);
  assert.equal(result.value.elements, 5);
  assert.equal(result.value.attributes, 3);
  assert.equal(result.value.comments, 1);
  assert.equal(result.value.depth, 4);
  assert.equal(result.value.diagnostics, 0);
  assert.equal(result.value.bytes, encoder.encode(result.text).byteLength);
  assert.equal(result.value.inputBytes, encoder.encode(input).byteLength);
  assert.equal(result.value.operation, "beautify");
  assert.deepEqual(result.value.options, { indent: "2", "preserve-comments": true, "wrap-attributes": "auto", "indent-inner-html": false });
  assert.equal(result.bytes.byteLength, result.value.bytes);
});

test("the 3000-element list fixture is counted and formatted line by line", async () => {
  const item = largeFixtures[0];
  assert.equal(item.name, "list-3000-elements");
  const result = await run("beautify", item.options, item.input);
  assert.equal(result.value.elements, 3001);
  assert.equal(result.value.attributes, 1);
  assert.equal(result.value.depth, 2);
  const lines = result.text.split("\n");
  assert.equal(lines.length, 3002);
  assert.equal(lines[0], "<ul class=\"items\">");
  assert.equal(lines[1], "  <li>Item 1</li>");
  assert.equal(lines[3000], "  <li>Item 3000</li>");
  assert.equal(lines[3001], "</ul>");
});

test("element classification follows the documented lists", () => {
  for (const name of INLINE_ELEMENTS) assert.ok(isInlineElement(name) && !isBlockElement(name), `${name} is inline`);
  for (const name of BLOCK_ELEMENTS) {
    if (INLINE_ELEMENTS.has(name)) continue;
    assert.ok(isBlockElement(name), `${name} is a block element`);
  }
  assert.ok(isBlockElement("my-widget"), "an unknown element is a block element");
  assert.deepEqual([...VOID_ELEMENTS].sort(), ["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
  assert.deepEqual([...RAW_TEXT_ELEMENTS].sort(), ["pre", "script", "style", "textarea"]);
  assert.deepEqual([...OPTIONAL_END_TAG].sort(), ["body", "dd", "dt", "head", "html", "li", "option", "p", "tbody", "td", "tfoot", "th", "thead", "tr"]);
});

test("minify writes no newline outside a raw-text element", async () => {
  for (const item of allFixtures) {
    const result = await run("minify", item.options, item.input);
    const withoutRaw = result.text.replace(/<(script|style|pre|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, "");
    assert.equal(withoutRaw.includes("\n"), false, `${item.name}: minify output has a newline outside raw text:\n${result.text}`);
  }
});

test("wrap-attributes auto keeps every attribute on the tag line", async () => {
  const input = "<div class=\"a\" id=\"b\" data-x=\"c\"><p>t</p></div>";
  const auto = await run("beautify", { "wrap-attributes": "auto" }, input);
  assert.equal(auto.text, "<div class=\"a\" id=\"b\" data-x=\"c\">\n  <p>t</p>\n</div>");
  const forced = await run("beautify", { "wrap-attributes": "force" }, input);
  assert.equal(forced.text, "<div\n  class=\"a\"\n  id=\"b\"\n  data-x=\"c\">\n  <p>t</p>\n</div>");
  const single = await run("beautify", { "wrap-attributes": "force" }, "<div class=\"a\"><p>t</p></div>");
  assert.equal(single.text, "<div class=\"a\">\n  <p>t</p>\n</div>", "one attribute is not more than one");
});

test("attributes are single-spaced and their quoting style is preserved", async () => {
  const result = await run("beautify", {}, "<a    href = \"x\"\n   title='y'     rel=next   empty=\"\"  flag  >t</a>");
  assert.equal(result.text, "<a href=\"x\" title='y' rel=next empty=\"\" flag>t</a>");
  assert.equal(result.value.attributes, 5);
});

test("conditional comments survive preserve-comments: false in both operations", async () => {
  const input = "<head><!--[IF IE]><p>ie</p><![endif]--><!-- ordinary --><title>t</title></head>";
  for (const operation of OPERATIONS) {
    const result = await run(operation, { "preserve-comments": false }, input);
    assert.ok(result.text.includes("<!--[IF IE]>"), `${operation}: a conditional comment is always kept:\n${result.text}`);
    assert.equal(result.text.includes("ordinary"), false, `${operation}: an ordinary comment is dropped`);
  }
});

test("cancellation is polled while tokens are processed, not only between chunks", async () => {
  let polls = 0;
  const cancellation = { isCancelled: () => (polls += 1) > 3 };
  const context = new ProcessorContext(
    new MemoryReader().insert("input", encoder.encode(`<ul>${"<li>item</li>".repeat(50000)}</ul>`)),
    new MemoryOutputSink(), cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(),
  );
  await assert.rejects(
    () => execute({ operationId: "beautify", options: {} }, context),
    (error) => error.name === "ProcessorCancelled",
  );
  assert.ok(polls > 3, "the processor must keep polling cancellation while it works");
});

test("the input limit is enforced before formatting", async () => {
  const limits = { maxInputBytes: 16, maxOutputBytes: 1024, maxChunkBytes: 1024, deadlineMs: 0 };
  await rejects("beautify", {}, `<p>${"a".repeat(64)}</p>`, "html.input-limit", { limits });
});

test("the output limit is enforced and no partial artifact is written", async () => {
  const limits = { maxInputBytes: 65536, maxOutputBytes: 32, maxChunkBytes: 32, deadlineMs: 0 };
  await rejects("beautify", {}, "<div><p>one</p><p>two</p><p>three</p></div>", "html.output-limit", { limits });
});

class ChunkedReader {
  constructor(bytes, chunk, { cancellation } = {}) { this.bytes = bytes; this.chunk = chunk; this.cancellation = cancellation; }
  read() { throw new Error("streaming processors must not read the whole input"); }
  size() { return this.bytes.byteLength; }
  readRange(_port, offset, maxBytes) {
    if (this.cancellation && offset > 0) this.cancellation.cancel();
    return this.bytes.slice(offset, offset + Math.min(maxBytes, this.chunk));
  }
}

test("the input is read through readChunks, not a whole-document read", async () => {
  const input = `<ul>${"<li>item</li>".repeat(20000)}</ul>`;
  const reader = new ChunkedReader(encoder.encode(input), 64 * 1024);
  const result = await run("minify", {}, undefined, { reader });
  assert.equal(result.text, input);
  assert.equal(result.value.elements, 20001);
});

test("cooperative cancellation is observed between chunks", async () => {
  const cancellation = new CancellationToken();
  const reader = new ChunkedReader(encoder.encode(`<ul>${"<li>item</li>".repeat(20000)}</ul>`), 64 * 1024, { cancellation });
  const context = new ProcessorContext(reader, new MemoryOutputSink(), cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets());
  await assert.rejects(
    () => execute({ operationId: "beautify", options: {} }, context),
    (error) => error.name === "ProcessorCancelled",
  );
});

test("cancellation before the run starts is observed", async () => {
  const cancellation = new CancellationToken();
  cancellation.cancel();
  await assert.rejects(
    () => run("beautify", {}, "<p>x</p>", { cancellation }),
    (error) => error.name === "ProcessorCancelled",
  );
});

test("the manifest is contract-valid and matches the processor", () => {
  validateManifest(manifest);
  assert.equal(descriptor.processor, "processor.mjs");
  assert.equal(descriptor.manifest, "manifest.json");
  assert.equal(manifest.id, "format.html");
  assert.deepEqual(manifest.tests.requirementIds, ["DU-13"]);
  assert.deepEqual(manifest.tools[0].operationIds, [...OPERATIONS]);
  assert.equal(manifest.tools[0].category, "converter");
  for (const operation of manifest.operations) {
    assert.deepEqual(operation.inputs.map((port) => [port.id, port.kind, port.contentKinds]), [["input", "document", ["text"]]]);
    const [output] = operation.outputs;
    assert.equal(output.id, "output");
    assert.equal(output.kind, "artifact");
    assert.deepEqual(output.representations, ["code", "properties", "annotations"]);
    assert.deepEqual(output.mime, ["text/html"]);
    assert.equal(operation.limits.maxInputBytes, String(16 * 1024 * 1024));
    assert.equal(operation.limits.maxOutputBytes, String(32 * 1024 * 1024));
    assert.deepEqual(operation.options.map((option) => option.id), ["indent", "preserve-comments", "wrap-attributes", "indent-inner-html"]);
    const defaults = Object.fromEntries(operation.options.map((option) => [option.id, option.default]));
    assert.deepEqual(defaults, { indent: "spaces-2", "preserve-comments": true, "wrap-attributes": "auto", "indent-inner-html": false });
    for (const option of operation.options) {
      if (option.type !== "enum") continue;
      for (const choice of option.choices) assert.doesNotThrow(() => normalizeOptions({ [option.id]: choice.id }), `${option.id}=${choice.id} must be accepted by the processor`);
    }
  }
  assert.deepEqual(manifest.tests.fixtures.sort(), ["beautify", "invalid", "large-list", "minify"]);
});

test("the processor imports no Node built-in", async () => {
  const source = await readFile(new URL("./processor.mjs", import.meta.url), "utf8");
  assert.equal(/\bfrom\s+["']node:/u.test(source), false, "processor.mjs must not import a node: module");
  assert.equal(/\brequire\s*\(/u.test(source), false, "processor.mjs must not call require()");
});

test("every package file uses LF line endings", async () => {
  const files = ["processor.mjs", "test.mjs", "manifest.json", "plugin.json", "README.md", "fixtures/beautify.json", "fixtures/minify.json", "fixtures/large-list.json", "fixtures/invalid.json"];
  for (const file of files) {
    const text = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
    assert.equal(text.includes("\r"), false, `${file} must use LF line endings`);
  }
});
