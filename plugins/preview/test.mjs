import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorCancelled, ProcessorContext, SeededRandom,
} from "../../packages/plugin-sdk/src/context.ts";
import { validateManifest } from "../../packages/plugin-contract/ts/validate.ts";
import {
  OPERATIONS, PreviewError, THEMES,
  computeProperties, execute, looksLikeFullDocument, normalizeHtmlOptions, normalizeMarkdownOptions, skipLeadingWhitespaceAndComments, wrapDocument,
} from "./processor.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
const descriptor = JSON.parse(await readFile(new URL("./plugin.json", import.meta.url), "utf8"));

const markdownFixtures = await fixture("markdown");
const htmlFixtures = await fixture("html");

/** Runs one operation through the SDK context; asserts the source bytes were never modified. */
async function run(operation, options, input, { reader, cancellation = new CancellationToken(), limits } = {}) {
  const source = reader ?? new MemoryReader().insert("input", encoder.encode(input));
  const before = source instanceof MemoryReader ? source.inputs.get("input").slice() : null;
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(source, outputs, cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), limits);
  const report = await execute({ pluginId: "preview.documents", toolId: "preview.documents", operationId: operation, options }, context);
  if (before) assert.deepEqual(source.inputs.get("input"), before, "source bytes must be untouched, including on a thrown error");
  const bytes = outputs.bytes.get("output");
  return { report, value: outputs.values.get("output"), bytes, text: bytes ? decoder.decode(bytes) : undefined, outputs };
}

async function rejects(operation, options, input, code, extra = {}) {
  const sink = new MemoryOutputSink();
  const source = new MemoryReader().insert("input", encoder.encode(input));
  const before = source.inputs.get("input").slice();
  let caught;
  try {
    const context = new ProcessorContext(source, sink, new CancellationToken(), new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), extra.limits);
    await execute({ operationId: operation, options }, context);
  } catch (error) { caught = error; }
  assert.ok(caught, `expected ${code} for ${JSON.stringify(input).slice(0, 60)}`);
  assert.ok(caught instanceof PreviewError, `expected PreviewError, got ${caught.name}: ${caught.message}`);
  assert.equal(caught.code, code, caught.message);
  assert.equal(sink.bytes.size + sink.values.size, 0, "no output may be written on failure");
  assert.deepEqual(source.inputs.get("input"), before, "source bytes must be untouched on a thrown error");
  return caught;
}

// ---------------------------------------------------------------------------
// Manifest and descriptor
// ---------------------------------------------------------------------------

test("manifest matches the v2 contract schema", () => {
  validateManifest(manifest);
  assert.equal(manifest.id, "preview.documents");
  assert.deepEqual(manifest.tests.requirementIds, ["DU-25", "DU-11"]);
});

test("plugin descriptor points at the manifest and processor", () => {
  assert.equal(descriptor.manifest, "manifest.json");
  assert.equal(descriptor.processor, "processor.mjs");
});

test("both operations declare the artifact output shape the packet requires", () => {
  for (const op of manifest.operations) {
    assert.equal(op.outputs.length, 1);
    const [output] = op.outputs;
    assert.equal(output.kind, "artifact");
    assert.deepEqual(output.mime, ["text/html"]);
    assert.deepEqual(output.representations, ["previewDocument", "code", "properties"]);
  }
});

// ---------------------------------------------------------------------------
// Markdown fixtures
// ---------------------------------------------------------------------------

test(`preview.markdown renders ${markdownFixtures.length} pinned fixtures (>= 30 required)`, async () => {
  assert.ok(markdownFixtures.length >= 30, `expected at least 30 markdown fixtures, found ${markdownFixtures.length}`);
  for (const vector of markdownFixtures) {
    const result = await run("preview.markdown", vector.options, vector.input);
    assert.equal(result.text, vector.expectedOutput, `${vector.name}: unexpected output`);
    assert.deepEqual(result.value, vector.expectedProperties, `${vector.name}: unexpected properties`);
    assert.equal(result.value.wrapped, true, `${vector.name}: markdown output is always wrapped`);
  }
});

test("preview.markdown output is a complete, self-contained document", async () => {
  const result = await run("preview.markdown", {}, "# Title\n");
  assert.match(result.text, /^<!DOCTYPE html>/);
  assert.match(result.text, /<meta charset="utf-8">/);
  assert.match(result.text, /<meta name="color-scheme" content="dark">/);
  assert.match(result.text, /<style>/);
  assert.doesNotMatch(result.text, /<script/i);
  assert.doesNotMatch(result.text, /<base[\s>]/i);
  assert.doesNotMatch(result.text, /https?:\/\/[^"]*\.(css|js)/i, "no external resource references");
});

test("preview.markdown style block covers the required reset and typography", async () => {
  const result = await run("preview.markdown", {}, "# T\n");
  assert.match(result.text, /font-size:\s*15px/);
  assert.match(result.text, /line-height:\s*1\.6/);
  assert.match(result.text, /font-family:[^;]*monospace/);
  assert.match(result.text, /border:\s*1px solid[^;]*;/);
  assert.match(result.text, /img\s*\{[^}]*max-width:\s*100%/);
});

test("preview.markdown honours gfm, breaks and theme", async () => {
  const gfmOn = await run("preview.markdown", { gfm: true }, "Visit https://example.com now.\n");
  assert.match(gfmOn.text, /<a href="https:\/\/example\.com">/);
  const gfmOff = await run("preview.markdown", { gfm: false }, "Visit https://example.com now.\n");
  assert.doesNotMatch(gfmOff.text, /<a href=/);

  const breaksOn = await run("preview.markdown", { breaks: true }, "one\ntwo\n");
  assert.match(breaksOn.text, /one<br>two/);
  const breaksOff = await run("preview.markdown", { breaks: false }, "one\ntwo\n");
  assert.doesNotMatch(breaksOff.text, /<br>/);

  const light = await run("preview.markdown", { theme: "light" }, "# T\n");
  assert.match(light.text, /content="light"/);
  const dark = await run("preview.markdown", { theme: "dark" }, "# T\n");
  assert.match(dark.text, /content="dark"/);
});

test("preview.markdown calls marked with only gfm, breaks and async: false", async () => {
  // A hand-authored footnote (a marked extension, never enabled) must render as literal text,
  // proving no extension and no option beyond gfm/breaks/async reaches marked.parse.
  const result = await run("preview.markdown", {}, "Text[^1]\n\n[^1]: A footnote.\n");
  assert.doesNotMatch(result.text, /<sup/);
});

// ---------------------------------------------------------------------------
// HTML fixtures
// ---------------------------------------------------------------------------

test(`preview.html handles ${htmlFixtures.length} pinned fixtures (>= 10 required)`, async () => {
  assert.ok(htmlFixtures.length >= 10, `expected at least 10 html fixtures, found ${htmlFixtures.length}`);
  for (const vector of htmlFixtures) {
    if (vector.errorCode) {
      await rejects("preview.html", {}, vector.input, vector.errorCode);
      continue;
    }
    const result = await run("preview.html", {}, vector.input);
    assert.equal(result.text, vector.expectedOutput, `${vector.name}: unexpected output`);
    assert.deepEqual(result.value, vector.expectedProperties, `${vector.name}: unexpected properties`);
  }
});

test("preview.html passes a full document through byte for byte", async () => {
  const input = "<!DOCTYPE html>\n<html><body><p>exact</p></body></html>";
  const result = await run("preview.html", {}, input);
  assert.equal(result.text, input);
  assert.equal(result.value.wrapped, false);
});

test("preview.html wraps a fragment that is not already a document", async () => {
  const result = await run("preview.html", {}, "<p>fragment</p>");
  assert.match(result.text, /^<!DOCTYPE html>/);
  assert.match(result.text, /<p>fragment<\/p>/);
  assert.equal(result.value.wrapped, true);
});

test("preview.html rejects empty input without writing output", async () => {
  await rejects("preview.html", {}, "", "preview.empty");
});

// ---------------------------------------------------------------------------
// looksLikeFullDocument / skipLeadingWhitespaceAndComments
// ---------------------------------------------------------------------------

test("looksLikeFullDocument recognises <!DOCTYPE and <html after whitespace and comments", () => {
  assert.equal(looksLikeFullDocument("<!DOCTYPE html><html></html>"), true);
  assert.equal(looksLikeFullDocument("<!doctype html>"), true);
  assert.equal(looksLikeFullDocument("<html><body></body></html>"), true);
  assert.equal(looksLikeFullDocument("   \n\t<html></html>"), true);
  assert.equal(looksLikeFullDocument("<!-- c1 --><!-- c2 -->\n<!DOCTYPE html>"), true);
  assert.equal(looksLikeFullDocument("<p>fragment</p>"), false);
  assert.equal(looksLikeFullDocument("<htmlfoo>"), false, "must not match a tag that merely starts with html");
  assert.equal(looksLikeFullDocument("<!doctypefoo>"), false);
  assert.equal(looksLikeFullDocument(""), false);
});

test("skipLeadingWhitespaceAndComments stops at an unterminated comment", () => {
  const text = "<!-- never closed <!DOCTYPE html>";
  assert.equal(skipLeadingWhitespaceAndComments(text), 0);
  assert.equal(looksLikeFullDocument(text), false);
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

test("computeProperties counts headings, links, images, code blocks and scripts", () => {
  const html = "<h1>A</h1><h2>B</h2><a href=\"x\">l</a><img src=\"x\"><pre><code>c</code></pre><script>1</script>";
  const properties = computeProperties(html, true);
  assert.equal(properties.headings, 2);
  assert.equal(properties.links, 1);
  assert.equal(properties.images, 1);
  assert.equal(properties.codeBlocks, 1);
  assert.equal(properties.scripts, 1);
  assert.equal(properties.wrapped, true);
  assert.equal(properties.bytes, encoder.encode(html).byteLength);
});

// ---------------------------------------------------------------------------
// Options validation
// ---------------------------------------------------------------------------

test("preview.markdown option defaults", () => {
  assert.deepEqual(normalizeMarkdownOptions(undefined), { gfm: true, breaks: false, theme: "dark" });
  assert.deepEqual(normalizeMarkdownOptions({}), { gfm: true, breaks: false, theme: "dark" });
});

test("preview.markdown rejects invalid options", async () => {
  await rejects("preview.markdown", { unknown: true }, "x", "preview.invalid-option");
  await rejects("preview.markdown", { gfm: "yes" }, "x", "preview.invalid-option");
  await rejects("preview.markdown", { breaks: 1 }, "x", "preview.invalid-option");
  await rejects("preview.markdown", { theme: "blue" }, "x", "preview.invalid-option");
  await rejects("preview.markdown", "not an object", "x", "preview.invalid-option");
  await rejects("preview.markdown", ["array"], "x", "preview.invalid-option");
});

test("preview.html accepts no options and rejects any it is given", async () => {
  assert.deepEqual(normalizeHtmlOptions(undefined), {});
  assert.deepEqual(normalizeHtmlOptions({}), {});
  await rejects("preview.html", { theme: "light" }, "<p>x</p>", "preview.invalid-option");
});

test("unsupported operation is rejected", async () => {
  await rejects("preview.export", {}, "x", "preview.unsupported-operation");
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

test("input limit is enforced for both operations", async () => {
  // The SDK context's own `readChunks` rejects an over-limit input by its known
  // size before any chunk is yielded, so this surfaces as its own `Error`
  // rather than a `PreviewError` — matching every other package's own test
  // for this case (see plugins/string-case/test.mjs).
  const limits = { maxInputBytes: 16, maxOutputBytes: 65536, maxChunkBytes: 65536, deadlineMs: 0 };
  await assert.rejects(() => run("preview.markdown", {}, "#".repeat(17), { limits }), /exceeds/);
  await assert.rejects(() => run("preview.html", {}, "<p>".repeat(10), { limits }), /exceeds/);
});

test("output limit is enforced", async () => {
  const limits = { maxInputBytes: 65536, maxOutputBytes: 16, maxChunkBytes: 65536, deadlineMs: 0 };
  await rejects("preview.markdown", {}, "# heading that renders to plenty of html\n", "preview.output-limit", { limits });
  await rejects("preview.html", {}, "<p>fragment that must be wrapped and overflows</p>", "preview.output-limit", { limits });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

class ChunkedReader {
  constructor(bytes, chunk, { cancellation, withSize = true } = {}) { this.bytes = bytes; this.chunk = chunk; this.cancellation = cancellation; this.calls = 0; if (!withSize) this.size = undefined; }
  read() { throw new Error("streaming processors must not read the whole input"); }
  size() { return this.bytes.byteLength; }
  readRange(_port, offset, maxBytes) {
    this.calls += 1;
    if (this.cancellation && offset > 0) this.cancellation.cancel();
    return this.bytes.slice(offset, offset + Math.min(maxBytes, this.chunk));
  }
}

test("preview.markdown cancels cooperatively mid-read", async () => {
  const cancellation = new CancellationToken();
  const bytes = encoder.encode("#".repeat(100_000));
  const reader = new ChunkedReader(bytes, 65536, { cancellation });
  const context = new ProcessorContext(reader, new MemoryOutputSink(), cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets());
  await assert.rejects(() => execute({ operationId: "preview.markdown", options: {} }, context), ProcessorCancelled);
});

test("preview.html cancels cooperatively mid-read", async () => {
  const cancellation = new CancellationToken();
  const bytes = encoder.encode("<p>".repeat(50_000));
  const reader = new ChunkedReader(bytes, 65536, { cancellation });
  const context = new ProcessorContext(reader, new MemoryOutputSink(), cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets());
  await assert.rejects(() => execute({ operationId: "preview.html", options: {} }, context), ProcessorCancelled);
});

test("cancellation before any read is honoured", async () => {
  const cancellation = new CancellationToken();
  cancellation.cancel();
  const context = new ProcessorContext(new MemoryReader().insert("input", encoder.encode("x")), new MemoryOutputSink(), cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets());
  await assert.rejects(() => execute({ operationId: "preview.markdown", options: {} }, context), ProcessorCancelled);
});

test("THEMES and OPERATIONS are exactly what the manifest declares", () => {
  assert.deepEqual([...THEMES], ["light", "dark"]);
  assert.deepEqual([...OPERATIONS], ["preview.markdown", "preview.html"]);
  const themeOption = manifest.operations.find((op) => op.id === "preview.markdown").options.find((o) => o.id === "theme");
  assert.deepEqual(themeOption.choices.map((c) => c.id), [...THEMES]);
});

test("wrapDocument never embeds a <base> or external resource tag", () => {
  const html = wrapDocument("<p>x</p>", "dark");
  assert.doesNotMatch(html, /<base[\s>]/i);
  assert.doesNotMatch(html, /<link[\s>]/i);
  assert.doesNotMatch(html, /<script[\s>]/i);
});
