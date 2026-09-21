# Preview plugin

`preview.documents` (DU-25, DU-11) renders a complete, self-contained HTML
document for the shell to display in a sandboxed frame with scripts disabled.
It exposes two operations over one required text input port, `input`, and
writes one `artifact` output port, `output` (`text/html`, representations
`previewDocument`, `code` and `properties`):

- `preview.markdown` renders Markdown to HTML with the vendored `marked` and
  always wraps the result in the package's own document shell.
- `preview.html` wraps its input the same way, unless the input already looks
  like a full document, in which case it is passed through byte for byte.

**This package does not sanitise its output.** Raw HTML in Markdown source,
and all of `preview.html`'s input, reaches the rendered document unchanged.
Safety is the shell's sandboxed frame — scripts disabled, no navigation, no
bridge access — not this processor. See DU-11's acceptance criteria.

The processor is the only implementation; there is no native executor for
these tools. It uses web platform APIs only (`TextDecoder`, `TextEncoder`,
`crypto` is not needed here), so it runs unchanged in the desktop webview's
Worker engine and under Node.

## Pipeline

1. `context.readChunks("input", 65536)` reads the immutable source; the bytes
   are decoded as UTF-8 (`fatal`, so a bad sequence is `preview.invalid-utf8`).
2. `preview.markdown` calls `marked.parse(text, { gfm, breaks, async: false })`
   from `../../packages/vendor/marked/marked.mjs` — no other marked option and
   no extension is ever passed — and wraps the returned HTML fragment.
   `preview.html` decides whether to wrap or pass its input through.
3. The final document's properties (`bytes`, `headings`, `links`, `images`,
   `codeBlocks`, `scripts`, `wrapped`) are computed from the final HTML and
   written to the `properties` representation; the document bytes are written
   to `code`/`previewDocument`.

Cancellation is polled between read chunks (inherited from
`context.readChunks`) and again immediately before and after rendering/passthrough,
per operation. The source bytes are never modified; every test asserts that,
including on a thrown error.

## The document shell

Both operations wrap with the same template:

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light|dark">
<style>…</style>
</head>
<body>
…rendered or passed-through content…
</body>
</html>
```

The inline `<style>` block is the package's own reset and typography: a
system font stack, 15px body text, 1.6 line height, monospace `code`/`pre`,
hairline-bordered tables, and `img { max-width: 100% }`. Colors are the light
or dark palette selected by `theme` at generation time (not
`prefers-color-scheme`, since `theme` is an explicit choice, not a system
default). There is no `<script>`, no `<base>` and no reference to an external
resource anywhere in the shell.

`preview.html` has no `theme` option; when it wraps a fragment it always uses
the dark palette, matching the operation's own default.

## `preview.markdown`

Options:

| Id | Type | Default | Meaning |
|---|---|---|---|
| `gfm` | boolean | `true` | GitHub-flavoured Markdown (tables, task lists, strikethrough, bare-URL autolinks, …) |
| `breaks` | boolean | `false` | a single newline renders as `<br>` |
| `theme` | enum (`light`, `dark`) | `dark` | palette used by the document shell |

These three fields are the *only* thing passed to `marked.parse`, alongside
`async: false`; no `renderer`, `tokenizer`, `extensions` or `hooks` override
ever reaches it. An unknown option key, a value of the wrong type, or a
`theme` outside the enum is `preview.invalid-option`.

The rendered fragment is always wrapped — `preview.markdown`'s `wrapped`
property is always `true` — because Markdown source is never itself a full
HTML document.

## `preview.html`

Takes no options; any option key at all is `preview.invalid-option`.

The input is passed through byte for byte when, after skipping leading
whitespace and complete `<!-- … -->` comments, it starts with `<!DOCTYPE` or
`<html` (case-insensitive, and only at a tag/word boundary — `<htmlfoo>` does
not count). An unterminated comment is never skipped past, so a document that
opens with a comment that never closes is treated as a fragment. Otherwise the
input is wrapped exactly like a rendered Markdown fragment, with the `dark`
palette.

Empty input (zero bytes after decoding) is rejected as `preview.empty` — there
is nothing to preview. `preview.markdown` has no equivalent rejection: empty
Markdown renders to an empty, but still valid and still wrapped, document.

## Properties

The `output` value carries, for both operations:

| Field | Meaning |
|---|---|
| `bytes` | output document byte length |
| `headings` | count of `<h1>`–`<h6>` start tags in the output |
| `links` | count of `<a>` start tags in the output |
| `images` | count of `<img>` tags in the output |
| `codeBlocks` | count of `<pre>` start tags in the output |
| `scripts` | count of `<script` occurrences in the output — reported, not removed, so the shell can show that scripts are present but disabled |
| `wrapped` | `true` when this processor generated the document shell, `false` when `preview.html` passed its input through byte for byte |

Counts are taken from the final output document (shell included), by tag
occurrence; they are not a DOM parse.

## Limits

`maxInputBytes` is 4 MiB and `maxOutputBytes` is 16 MiB, for both operations.
An input above the limit fails inside the SDK context's own `readChunks` (a
plain `Error`, not a `PreviewError`, matching every other package's own
handling of this case); an output above `min(maxOutputBytes, maxChunkBytes)`
is `preview.output-limit`, and nothing is written — the SDK sink accepts one
chunk per artifact, and a truncated preview would be worse than no preview.

## Fixtures

`fixtures/markdown.json` (32 cases) and `fixtures/html.json` (10 cases). Each
entry is `{ name, input, options?, expectedOutput, expectedProperties }`, or
`{ name, input, errorCode }` for the one rejected case (empty input). Expected
values were generated by running this processor's own `marked.parse` /
`wrapDocument` / `computeProperties` once and pinning the result, so the
fixtures catch a behavior change in this code or in the vendored `marked`,
not an independent Markdown conformance suite.

`fixtures/markdown.json` covers headings (all six levels), bold/italic/
strikethrough emphasis, unordered and ordered lists nested three deep, GFM
task lists, tables (plain and with column alignment), fenced code with and
without a language, inline code, links (plain and titled), images (plain and
titled), blockquotes (plain and nested), horizontal rules (both spellings),
raw HTML passthrough, autolinks (a bare URL gated by `gfm`, and an
angle-bracket autolink that is not gated by `gfm`), `breaks` on and off, both
themes, a mixed-formatting document, blank-line handling, backslash-escaped
emphasis markers, and multiple paragraphs.

`fixtures/html.json` covers a fragment that gets wrapped, a full document
passed through by its `<!DOCTYPE`, a full document passed through by a bare
`<html>` tag, a document preceded by a leading comment, a document preceded
by leading whitespace, a `<script>` counted inside a wrapped fragment, a
`<script>` counted inside a passed-through document, a fragment with links and
images (property counts), a table fragment, and empty input being rejected.

```text
node --experimental-strip-types --test plugins/preview/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin preview.documents --operation preview.markdown --input "input=# Title

- one
- two"
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin preview.documents --operation preview.html --input "input=<p>hello <b>there</b></p>"
```

## Out of scope

Sanitisation (the shell's sandboxed frame is the boundary), syntax
highlighting inside code blocks, math, diagrams, the preview pane itself and
its refresh behaviour (shell work) — all as the packet states.
