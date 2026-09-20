# AG-112 — XML beautifier and minifier package (DU-16)

## Branch

`claude/AG-112-xml-formatter` from the latest `origin/main`. Record the
base SHA.

## Allowed files

```text
plugins/xml/**
```

## Required reading

`ARCHITECTURE.md`, `Tool Contract and Document Model.md`,
`packages/plugin-sdk/README.md`, the DU-16 card in
`docs/DEVUTILS_REQUIREMENTS.md`, the "working" rules in
`docs/WORKER_PROTOCOL.md` (a processor uses web platform APIs only), and two
reference packages: `plugins/json/` for a streaming formatter with
diagnostics and `plugins/string-case/` for option validation.

## Goal

A new package `plugins/xml/` with plugin id `format.xml` that beautifies or
minifies XML with a tokenizer. Tolerant formatting and well-formedness
checking are separate: formatting never fails on incomplete input, and the
well-formedness problems it noticed are reported as diagnostics.

## Requirements

- Package files as in the reference packages; `tests.requirementIds: ["DU-16"]`.
- One tool `format.xml`, category `converter`, two operations `beautify` and
  `minify`. Input port `input` (document, text); output port `output`, kind
  `artifact`, representations `["code", "properties", "annotations"]`, mime
  `application/xml`.
- Options: `indent` enum `2`, `4`, `tab` (default `2`); `preserve-comments`
  boolean (default `true`); `collapse-empty` boolean (default `true`, render
  `<a></a>` as `<a/>`). Kebab-case ids, camelCase aliases, structured errors
  for unknown keys and wrong types.
- Tokenizer, stated in the README: XML declaration and processing
  instructions (`<? ?>`), `<!DOCTYPE ...>` including an internal subset in
  `[...]`, comments, `CDATA` sections, start/end/empty-element tags with
  attributes in single or double quotes, text, entity and character
  references left untouched. Attribute values, comments, CDATA and PI bodies
  are emitted byte-for-byte.
- Beautify: one node per line; child elements indented one level; text-only
  content stays on the element's line (`<a>text</a>`); mixed content (text
  and elements together) is kept inline exactly as in the source, whitespace
  included, so inline markup is not reflowed; whitespace-only text between
  elements is dropped; attributes stay on the tag line, single-spaced;
  `xml:space="preserve"` subtrees are emitted byte-for-byte.
- Minify: whitespace-only text dropped, leading/trailing whitespace of text
  nodes outside `xml:space="preserve"` trimmed, comments removed unless
  `preserve-comments`, no newlines except inside preserved content.
- Tolerance and diagnostics: an unclosed element, a mismatched end tag, an
  unquoted attribute, a stray `<` or `&`, or trailing content after the
  root each produce a diagnostic (`severity: "warning"`, byte offset, line,
  column, message naming the tag) and formatting continues by best effort:
  unclosed elements are closed at end of input, a mismatched end tag closes
  the nearest open element with that name. Only an empty document or one
  with no `<` at all is an error.
- Properties: `elements`, `attributes`, `comments`, `depth`, `wellFormed`
  (no diagnostics), `diagnostics` (count), `bytes`.
- Round-trip: beautify → minify → beautify is byte-identical for every
  well-formed fixture; test it.
- Limits: `maxInputBytes` 16 MiB, `maxOutputBytes` 32 MiB. Read with
  `readChunks`, tokenize in one pass with a bounded lookahead buffer, poll
  cancellation every 4096 tokens. Source bytes immutable, asserted per test.
- Fixtures under `fixtures/`: at least 40 `beautify` cases and 10 `minify`
  cases as `{ name, options, input, output, diagnostics }`: declaration with
  encoding, DOCTYPE with internal subset, namespaces and prefixed attributes,
  nested elements five deep, empty elements both styles, CDATA with `<`
  inside, comments between and inside elements, mixed content paragraphs,
  `xml:space="preserve"`, entity references, a 2000-element flat list, and
  the tolerant cases (each producing the documented diagnostic and output).

## Checks

```text
node --experimental-strip-types --test plugins/xml/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin format.xml --operation beautify --input "input=<?xml version='1.0'?><root a='1'><item>one</item><item><b>two</b> and text</item><empty></empty><!-- note --></root>"
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin format.xml --operation beautify --input "input=<root><open><inner>x</inner></root>"
pnpm --dir apps/desktop build
git diff --check
```

The second headless call must succeed with one diagnostic naming `open`.

## Evidence

Test counts, fixture counts, both headless outputs, the
`pnpm --dir apps/desktop build` summary line.

## Out of scope

Schema or DTD validation, entity expansion, encoding conversion (input is
UTF-8 text), syntax highlighting (shell work).
