# AG-113 — CSS beautifier and minifier package (DU-14)

## Branch

`claude/AG-113-css-formatter` from the latest `origin/main`. Record the
base SHA.

## Allowed files

```text
plugins/css/**
```

## Required reading

`ARCHITECTURE.md`, `Tool Contract and Document Model.md`,
`packages/plugin-sdk/README.md`, the DU-14 card in
`docs/DEVUTILS_REQUIREMENTS.md`, the "working" rules in
`docs/WORKER_PROTOCOL.md` (a processor uses web platform APIs only), and two
reference packages: `plugins/json/` for a streaming formatter with
diagnostics and `plugins/string-case/` for option validation.

## Goal

A new package `plugins/css/` with plugin id `format.css` that beautifies or
minifies CSS with a tokenizer, tolerating incomplete stylesheets and never
altering a value, selector or string.

## Requirements

- Package files as in the reference packages; `tests.requirementIds: ["DU-14"]`.
- One tool `format.css`, category `converter`, two operations `beautify` and
  `minify`. Input port `input` (document, text); output port `output`, kind
  `artifact`, representations `["code", "properties", "annotations"]`, mime
  `text/css`.
- Options: `indent` enum `2`, `4`, `tab` (default `2`); `preserve-comments`
  boolean (default `true`; `minify` keeps only comments starting with `/*!`
  when true and none when false); `blank-line-between-rules` boolean
  (default `true`). Kebab-case ids, camelCase aliases, structured errors for
  unknown keys and wrong types.
- Tokenizer per CSS Syntax Level 3 §4, stated in the README: comments,
  strings (both quotes, backslash escapes, unterminated string closes at end
  of line with a diagnostic), `url(` unquoted tokens, numbers with units and
  percentages, hashes, at-keywords, functions, `{ } ( ) [ ] ; , :`, and
  delimiters. Strings, `url()` contents and comments are emitted
  byte-for-byte.
- Beautify: each rule's selector list on one line with `, ` between
  selectors (selectors inside `:is()`, `:not()` and attribute brackets are
  not split); `{` on the selector line; one declaration per line indented
  one level, `property: value;` with exactly one space after the colon and a
  terminating `;` even when the source omitted the last one; `}` on its own
  line; nested at-rules (`@media`, `@supports`, `@layer`, `@container`,
  `@keyframes` frames) indent their block one level; statement at-rules
  (`@import`, `@charset`, `@namespace`) on their own line; `!important`
  normalised to ` !important`; a comment stays where it was, on its own line
  if it was on its own line; one blank line between top-level rules when
  `blank-line-between-rules`. Values are never reformatted beyond
  collapsing runs of whitespace outside strings and `url()` to one space and
  removing spaces around `,` inside function arguments.
- Minify: all whitespace outside strings, `url()` and comments removed
  except where two tokens would merge (`a b`, `1px solid`, `and (`), the
  last `;` in each block dropped, comments per the option, no newlines.
- Tolerance: an unclosed block is closed at end of input, an unclosed
  comment runs to end of input, a declaration without a colon is emitted
  as-is on its own line; each produces a diagnostic (`severity: "warning"`,
  byte offset, line, column, message). Only an empty document is an error.
- Properties: `rules`, `declarations`, `atRules`, `comments`, `diagnostics`
  (count), `bytes`.
- Round-trip: beautify → minify → beautify is byte-identical for every
  fixture without diagnostics; test it.
- Limits: `maxInputBytes` 16 MiB, `maxOutputBytes` 32 MiB. Read with
  `readChunks`, tokenize in one pass, poll cancellation every 4096 tokens.
  Source bytes immutable, asserted per test.
- Fixtures under `fixtures/`: at least 40 `beautify` and 10 `minify` cases as
  `{ name, options, input, output, diagnostics }`: the DU-14 screenshot
  sample, selector lists, attribute selectors with commas inside, `:is()`
  and `:not()` lists, pseudo-elements, `@media` with nested rules,
  `@keyframes`, `@font-face`, `@import url()` and string forms, `!important`
  with odd spacing, `url()` with and without quotes and with spaces,
  strings containing `{` and `;`, custom properties with complex values
  (`--x: { a: b }` emitted byte-for-byte), `calc()` with nested parentheses,
  unicode-range, comments in every position, a `/*!` license comment through
  minify, and each tolerant case with its diagnostic.

## Checks

```text
node --experimental-strip-types --test plugins/css/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin format.css --operation beautify --input "input=a,b>c{color:red;margin:0 auto!important}@media (min-width:600px){.x{display:none}}"
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin format.css --operation minify --input "input=/*! keep */ .a { color : red ; } /* drop */ .b { }"
pnpm --dir apps/desktop build
git diff --check
```

## Evidence

Test counts, fixture counts, both headless outputs, the
`pnpm --dir apps/desktop build` summary line.

## Out of scope

Property validation, vendor-prefix handling, colour or unit rewriting,
LESS/SCSS syntax, syntax highlighting (shell work).
