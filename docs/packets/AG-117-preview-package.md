# AG-117 — Markdown and HTML preview package (DU-25, DU-11)

## Branch

`claude/AG-117-preview-package` from the latest `origin/main`. Record the base
SHA.

## Allowed files

```text
plugins/preview/**
```

`packages/vendor/marked/` is read-only for this packet: import it, never edit
it.

## Required reading

`ARCHITECTURE.md`, `Tool Contract and Document Model.md`,
`packages/plugin-sdk/README.md`, the DU-25 and DU-11 cards in
`docs/DEVUTILS_REQUIREMENTS.md`, `packages/vendor/marked/README.md`, the
"working" rules in `docs/WORKER_PROTOCOL.md` (a processor uses web platform
APIs only), and `plugins/string-case/` for option validation.

## Goal

A new package `plugins/preview/` with plugin id `preview.documents` and two
tools: `preview.markdown` (Markdown → HTML document via the vendored
`marked`) and `preview.html` (an HTML document passed through as a preview).
Both produce a complete HTML document the shell renders in a sandboxed
frame with scripts disabled; the package itself does not sanitise and the
README says so plainly.

## Requirements

- Package files as in the reference packages;
  `tests.requirementIds: ["DU-25", "DU-11"]`. Two operations,
  `preview.markdown` and `preview.html`, each with input port `input`
  (document, text) and output port `output`, kind `artifact`, mime
  `text/html`, representations `["previewDocument", "code", "properties"]`.
- `preview.markdown` options: `gfm` boolean (default `true`), `breaks`
  boolean (default `false`), `theme` enum `light`, `dark` (default `dark`).
  Call `marked.parse(text, { gfm, breaks, async: false })` from
  `../../packages/vendor/marked/marked.mjs`; no other marked options, no
  extensions.
- Output document, both tools: `<!DOCTYPE html><html><head><meta
  charset="utf-8"><meta name="color-scheme" content="...">` and one inline
  `<style>` block carrying the package's own reset and typography (system
  font stack, 15px, line-height 1.6, code in monospace, tables with
  hairline borders, images `max-width: 100%`, light and dark palettes chosen
  by `theme`), then `<body>` with the rendered HTML. No external resources,
  no `<script>`, no `<base>`. `preview.html` wraps the input the same way
  unless the input already starts with `<!DOCTYPE` or `<html` (after
  whitespace and comments), in which case it is passed through byte-for-byte.
- Properties, both tools: `bytes`, `headings`, `links`, `images`,
  `codeBlocks`, `scripts` (count of `<script` occurrences in the output,
  reported so the shell can show that scripts are present but disabled),
  `wrapped` (boolean).
- Limits: `maxInputBytes` 4 MiB, `maxOutputBytes` 16 MiB. `preview.markdown`
  reads the whole input (marked needs it); `preview.html` streams with
  `readChunks`. Cancellation polled before and after parsing. Source bytes
  immutable, asserted per test.
- Fixtures under `fixtures/`: at least 30 Markdown cases with pinned HTML
  output (headings, emphasis, lists nested three deep, task lists, tables,
  fenced code with language, inline code, links, images, blockquotes,
  horizontal rules, raw HTML passthrough, autolinks under `gfm`, `breaks`
  on and off, both themes), and 10 HTML cases (a fragment wrapped, a full
  document passed through, a document with a leading comment, one with
  `<script>` counted, empty input rejected).

## Checks

```text
node --experimental-strip-types --test plugins/preview/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin preview.documents --operation preview.markdown --input "input=# Title

- one
- two"
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin preview.documents --operation preview.html --input "input=<p>hello <b>there</b></p>"
pnpm --dir apps/desktop build
git diff --check
```

## Evidence

Test counts, fixture counts, both headless outputs, the
`pnpm --dir apps/desktop build` summary line.

## Out of scope

Sanitisation (the shell's sandboxed frame is the boundary), syntax
highlighting inside code blocks, math, diagrams, the preview pane itself and
its refresh behaviour (shell work).
