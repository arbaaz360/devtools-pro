# AG-114 — HTML beautifier and minifier package (DU-13)

## Branch

`claude/AG-114-html-formatter` from the latest `origin/main`. Record the base
SHA.

## Allowed files

```text
plugins/html/**
```

## Required reading

`ARCHITECTURE.md`, `Tool Contract and Document Model.md`,
`packages/plugin-sdk/README.md`, the DU-13 card in
`docs/DEVUTILS_REQUIREMENTS.md`, the "working" rules in
`docs/WORKER_PROTOCOL.md` (a processor uses web platform APIs only), and two
reference packages: `plugins/json/` for a streaming formatter with
diagnostics and `plugins/string-case/` for option validation. Read
`docs/packets/AG-112-xml-formatter.md` too: the two formatters share a shape,
and HTML differs from XML exactly where this packet says so.

## Goal

A new package `plugins/html/` with plugin id `format.html` that beautifies or
minifies HTML with a tokenizer that knows HTML's own rules: void elements,
raw-text elements, optional end tags and inline elements. Incomplete markup
formats without failing.

## Requirements

- Package files as in the reference packages; `tests.requirementIds: ["DU-13"]`.
- One tool `format.html`, category `converter`, two operations `beautify` and
  `minify`. Input port `input` (document, text); output port `output`, kind
  `artifact`, representations `["code", "properties", "annotations"]`, mime
  `text/html`.
- Options: `indent` enum `2`, `4`, `tab` (default `2`); `preserve-comments`
  boolean (default `true`; conditional comments `<!--[if` are always kept);
  `wrap-attributes` enum `auto`, `force` (default `auto`: attributes stay on
  the tag line; `force`: one attribute per line indented one level when a tag
  has more than one attribute); `indent-inner-html` boolean (default `false`:
  `<head>` and `<body>` children are not indented relative to `<html>`).
  Kebab-case ids, camelCase aliases, structured errors for unknown keys and
  wrong types.
- Tokenizer, stated in the README: doctype, comments, start and end tags
  with attributes (double-quoted, single-quoted, unquoted, and valueless),
  text, character references left untouched. **Void elements** (`area base br
  col embed hr img input link meta source track wbr`) never get end tags and
  a stray `</br>` is dropped with a diagnostic. **Raw-text elements**
  (`script style pre textarea`) have their content emitted byte-for-byte,
  including indentation and newlines. Tag and attribute names are compared
  case-insensitively and emitted as written.
- Beautify: **block elements** (`html head body div p section article
  header footer nav main aside ul ol li table thead tbody tfoot tr td th
  form fieldset h1`–`h6 blockquote figure figcaption details summary dl dt dd
  hr br` plus every unknown element) each on their own line with children
  indented one level; **inline elements** (`a abbr b bdi bdo cite code data
  dfn em i kbd mark q s samp small span strong sub sup time u var wbr img
  input label select textarea button`) stay inline with their surrounding
  text so paragraph content is not reflowed; text runs are trimmed at block
  boundaries and internal whitespace collapsed to one space outside raw-text
  elements; whitespace-only text between block elements is dropped;
  attributes single-spaced, quoting style preserved; the doctype on the first
  line as written.
- Optional end tags: `li`, `p`, `dt`, `dd`, `tr`, `td`, `th`, `option`,
  `thead`, `tbody`, `tfoot` and `html`/`head`/`body` close implicitly the way
  the HTML parser closes them (a `<li>` closes an open `<li>`; a `<p>` closes
  when a block element starts) and the output keeps the source's choice: no
  end tag is added that the source omitted.
- Minify: comments removed per the option, whitespace between block
  elements removed, runs of whitespace in text collapsed to one space, raw-
  text content untouched, attribute quoting preserved, no newlines outside
  raw-text elements. `<pre>` content is never altered by either operation.
- Tolerance and diagnostics: an unclosed non-void element closes at end of
  input, a mismatched end tag closes the nearest open element with that
  name (or is dropped if none is open), an unquoted attribute with `>` or
  `"` inside, and content after `</html>` each produce a diagnostic
  (`severity: "warning"`, byte offset, line, column, message naming the
  tag). Formatting never fails; only an empty document is an error.
- Properties: `elements`, `attributes`, `comments`, `depth`, `diagnostics`
  (count), `bytes`.
- Round-trip: beautify → minify → beautify is byte-identical for every
  fixture without diagnostics; test it.
- Limits: `maxInputBytes` 16 MiB, `maxOutputBytes` 32 MiB. Read with
  `readChunks`, tokenize in one pass with a bounded lookahead buffer, poll
  cancellation every 4096 tokens. Source bytes immutable, asserted per test.
- Fixtures under `fixtures/`: at least 40 `beautify` and 10 `minify` cases as
  `{ name, options, input, output, diagnostics }`: the DU-13 screenshot
  sample, a full document with head and body, nested lists, a table, a
  paragraph with inline `<a>`, `<b>` and `<code>` mixed with text, void
  elements with and without `/`, `<pre>` with indentation inside, `<script>`
  containing `<` and `</`, `<style>` with braces, `<textarea>` with newlines,
  each attribute quoting style, boolean attributes, a conditional comment,
  unclosed `<li>` and `<p>` sequences, mismatched end tag, a stray `</br>`,
  `wrap-attributes: force`, `indent-inner-html: true`, and a 3000-element
  list.

## Checks

```text
node --experimental-strip-types --test plugins/html/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin format.html --operation beautify --input "input=<!DOCTYPE html><html><head><title>x</title></head><body><ul><li>one<li>two <b>bold</b> text</ul><pre>  keep
   this</pre><br><img src=a.png></body></html>"
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin format.html --operation minify --input "input=<div>
  <p>  hello   <em>there</em>  </p>
  <!-- gone -->
</div>"
pnpm --dir apps/desktop build
git diff --check
```

## Evidence

Test counts, fixture counts, both headless outputs, the
`pnpm --dir apps/desktop build` summary line.

## Out of scope

Formatting the JavaScript or CSS inside `<script>` and `<style>` (raw text
is preserved; DU-15 and DU-14 own those). Entity decoding, validation,
syntax highlighting (shell work). HTML Preview (DU-11) is a different tool.
