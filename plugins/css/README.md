# CSS plugin

`format.css` beautifies or minifies CSS with a hand-written tokenizer, never
a real CSS parser or `CSSStyleSheet`. A lightweight structural pass groups
the flat token stream into rules/at-rules/declarations by brace and
semicolon boundaries alone — no selector or property grammar is validated —
which is what lets it tolerate incomplete or invalid CSS. Only an empty
document fails outright; every other malformed construct is tolerated,
formatted by best effort, and reported as a `warning` diagnostic.

## Semantics

**Tokenizer.** A single byte-level pass follows CSS Syntax Level 3 §4:
comments (`/* */`, unterminated ones run to end of input), strings (both
quotes, backslash escapes, an unterminated string closes at the next
newline), `url(` unquoted tokens (one atomic span from `url` through the
matching `)`; a quoted argument like `url("x")` is *not* a url-token — it
tokenizes as the ordinary function/string/paren sequence it is per the
spec, and its whitespace follows the normal value-formatting rules below),
numbers/dimensions/percentages, hashes (`#id`), at-keywords, the structural
punctuation (`{ } ( ) [ ] ; , :`), and everything else as single-character
delimiters. Strings, unquoted `url()` contents and comments are always
copied byte-for-byte from the source; nothing inside them is ever
reformatted, including internal whitespace.

**Structural pass.** Tokens accumulate into a "chunk" until a `;`, `{` or
`}` at bracket/paren depth 0 (relative to the current block) ends it: `;`
closes a declaration or an at-rule statement (`@import ...;`); `{` opens a
nested rule whose preceding chunk is its prelude (a selector list, or an
at-rule's own prelude — `@media`/`@supports`/`@container`/`@layer` blocks
and `@keyframes` frames are all just nested rules by this same mechanism,
so they indent uniformly); `}` closes the current block, or — at the
document's top level, where nothing opened a block — is simply skipped. A
custom property's value (`--x: ...`) is the one exception: per the CSS
Custom Properties spec its value is an opaque token sequence, so a
brace-matched block inside it (`--x: { a: b }`) is tracked as a
paren-like nesting level rather than a rule, is never further parsed, and
is emitted **byte-for-byte** with no whitespace collapsing in either
operation — its value could be arbitrary and is not this processor's to
reformat.

**Beautify.** One statement per line, indented one level inside its
enclosing block; `{` stays on the selector/prelude line, `}` on its own
line. A selector list splits only on *top-level* commas (`splitTopLevelCommas`
tracks `()`/`[]` depth), joined with `", "` — so `:is(.a, .b)` and an
attribute selector's own commas are never mistaken for the list separator,
matching the packet's requirement. A declaration is
`property: value;` with exactly one forced space after the colon (and none
before it) regardless of source spacing, and a terminating `;` is always
added even when the source omitted the last one. A value/selector/prelude's
own internal token spacing is never reformatted beyond collapsing any
whitespace run to one space (comments count as a "gap" here too when
dropped); the two exceptions the packet calls out are: no space around a
`,` inside a paren-nested function call in a **declaration value**
specifically (`rgba(0, 0, 0, .5)` → `rgba(0,0,0,.5)`; selectors' own
`:is()`/`:not()` internal commas are *not* tightened, since the packet's
tightening rule is scoped to values, not selectors), and `!important` is
always normalised to exactly one leading space with no space between `!`
and `important` (`red!important` / `red ! important` both become
`red !important`). One blank line is inserted before each top-level rule
(qualified or at-rule-with-block) that isn't the first one, when
`blank-line-between-rules` is on; this is scoped to the top level only, per
the packet's wording, and a plain top-level at-statement (`@import ...;`)
or comment doesn't itself trigger one.

**Minify.** Same structural rendering, but every optional space is dropped
*except* where two adjacent tokens would merge into a different token
sequence if concatenated (`needsGapForMinify`): the general rule is a
name-char/name-char adjacency check on the tokens' own boundary bytes
(covers ident/dimension/number/hash/at-keyword pairs — `a`+`b`, `1px`+
`solid`); three extras aren't caught by that alone and are handled
explicitly: a bare `+`/`-` delimiter next to *anything* on either side
(`calc()` requires whitespace around the operator on both sides regardless
of the operand's shape, and it would otherwise re-absorb into a signed
number), an ident or at-keyword directly before `(` (`and (` in a media
feature — dropping the space would turn it into a function-token), and an
at-keyword followed by anything at all (`@import` before its string). Only
an *existing* gap is ever kept as one space; minify never inserts a gap
that wasn't in the source, so already-tight input stays tight. The last
`;` before a block's closing `}` is dropped (a comment before the `}`
doesn't count as needing one; a declaration followed by a *nested rule* at
the same level still keeps its own `;`, since that's a real separator, not
a trailing one). Comments: a comment is only ever kept when
`preserve-comments` is on, and minify additionally keeps only comments
starting with `/*!` (a "license" comment) — every other comment is dropped
regardless of the option, per the packet's wording.

## Comment placement

A comment is **standalone** — gets its own beautified line at the current
indent — iff nothing but whitespace shares its source line on either side
(`isStandaloneComment`, a purely lexical byte scan, independent of the
structural parse). Otherwise it's **trailing**: it attaches to whatever
immediately precedes it (the previous declaration/rule/at-statement's line,
or the block's own opening `{` line if it's the very first thing in the
block, e.g. `.a { /* note */`) and is appended after a single space rather
than starting a new line. A comment that falls in the middle of an
already-started chunk (e.g. `color: /* x */ red;`) is left inline in that
chunk's own token span and rendered like any other atomic token (still
byte-for-byte, still subject to the same keep/drop policy) — it never
becomes a separate standalone/trailing item.

## Options

Kebab-case ids with camelCase aliases; unknown keys and wrong types are
structured errors (`css.invalid-option`).

| Option | Aliases | Type | Default | Notes |
| --- | --- | --- | --- | --- |
| `indent` | — | enum `sp2` \| `sp4` \| `tab` | `sp2` | 2 spaces, 4 spaces, or one tab per level. The contract schema's `ChoiceIdentifier` requires an enum choice id to start with a letter, so the packet's "2, 4, tab" values are spelled `sp2`/`sp4`/`tab` here and in the manifest, matching `plugins/xml/`. |
| `preserve-comments` | `preserveComments` | boolean | `true` | Beautify: `false` drops every comment. Minify: `true` keeps only `/*!` comments; `false` drops all of them. Comments are still counted in the `comments` property either way. |
| `blank-line-between-rules` | `blankLineBetweenRules` | boolean | `true` | One blank line before each top-level rule after the first, in beautify only. |

## Tolerant diagnostics

Each diagnostic is `{ code, severity: "warning", message, offset, end,
line, column }`; byte offsets are authoritative, `line`/`column` are
1-based display hints (code points, `LF`/`CR`/`CRLF` as line breaks),
matching the convention in `plugins/json/` and `plugins/xml/`.

| Code | Trigger |
| --- | --- |
| `css.unclosed-block` | A `{` never finds its matching `}`; the block is closed at end of input. Position is the opening `{`. |
| `css.unclosed-comment` | A `/*` never finds its matching `*/`; the comment runs to end of input. |
| `css.declaration-no-colon` | A statement inside a block has no top-level `:` and doesn't start with `@`; it is emitted as-is on its own line. |

Only an empty document (`css.empty`) fails the operation outright.

## Properties

Every operation writes this value on `output` (in addition to the
formatted/minified artifact):

| Field | Meaning |
| --- | --- |
| `operation`, `inputBytes`, `outputBytes`, `bytes` | what ran; `bytes` matches `outputBytes`. |
| `rules` | qualified rules, counted at every nesting depth (a `@keyframes` frame counts as a rule, not an at-rule, since structurally it's prelude + declaration block just like a qualified rule). |
| `declarations` | declaration statements, at every depth. |
| `atRules` | at-rules, both the block form (`@media`, ...) and the statement form (`@import ...;`), at every depth. |
| `comments` | every comment found, regardless of `preserve-comments` or whether minify would drop it. |
| `diagnostics` | diagnostic **count**, per the packet's Properties list. |
| `diagnosticsDetail` | the full diagnostic array (not part of the packet's minimal list, but needed for testing and UI detail, matching `plugins/xml/`). |
| `limits` | the effective `maxInputBytes`/`maxOutputBytes` (the smaller of the manifest's `maxOutputBytes` and `maxChunkBytes`, since the SDK output sink takes one chunk per artifact). |

## Limits and cancellation

| Limit | Value |
| --- | --- |
| Input size | `maxInputBytes`, 16 MiB |
| Output size | `maxOutputBytes`, 32 MiB (the manifest sets `maxChunkBytes` equal to it, so the SDK's one-chunk-per-artifact sink is never the binding constraint) |

Input is read with `context.readChunks`. The tokenizer polls cancellation
every 4096 tokens; the structural pass polls again every 1024 items
processed. A cancelled job publishes neither value nor artifact.

## Round trip

`beautify → minify → beautify` is byte-identical for every fixture with
zero diagnostics, *except* a fixture whose input contains a comment minify
is required to drop by design (an ordinary comment always vanishes in
minify; a `/*!` one only survives with `preserve-comments` true) — that
step is inherently lossy by the packet's own comment policy, independent
of anything this processor could format differently, so `test.mjs` excludes
those specific fixtures from the round-trip check and checks the rest
(≥30). Where minify's *safe* whitespace stripping (dropping a space that
isn't protected by `needsGapForMinify`, e.g. around a selector combinator,
inside `:is()`, or in a feature query's `(min-width:600px)`) would also be
lossy for round-trip purposes, the beautify fixtures were written already
tight at that specific point rather than relying on a space minify would
remove anyway — this is a fixture-authoring choice, not a formatting rule;
beautify never removes spacing that wasn't already collapsible.

## Out of scope

Property/selector validation, vendor-prefix handling, colour or unit
rewriting, LESS/SCSS syntax, and syntax highlighting (shell work) — per the
packet. Also not attempted: fully validating an unquoted `url()` token's
interior (a real tokenizer would flag internal whitespace not at the edges
as a bad-url-token; this one simply preserves whatever is between the
parens byte-for-byte in both operations) and any CSS grammar-level
whitespace requirement beyond calc()'s `+`/`-` operator and the specific
merge cases listed above — this is a tokenizer, not a full parser, and does
not claim to validate every context where CSS's grammar (as opposed to its
tokenization) requires component separation.

## Running the package checks

From the repository root:

```text
node --experimental-strip-types --test plugins/css/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin format.css --operation beautify --input "input=a,b>c{color:red;margin:0 auto!important}@media (min-width:600px){.x{display:none}}"
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin format.css --operation minify --input "input=/*! keep */ .a { color : red ; } /* drop */ .b { }"
```

Fixtures live in `fixtures/`: `beautify.json` (56 cases) and `minify.json`
(15 cases), each `{ name, options, input, output, diagnostics }`. They
cover the DU-14 sample, selector lists and combinators, attribute selectors
with commas inside strings, `:is()`/`:not()` lists, pseudo-elements,
`@media`/`@supports`/`@container`/`@layer` (both forms) nesting,
`@keyframes` frames, `@font-face`, `@import` (both `url()` and string
forms), `@charset`, `@namespace`, `@page`, `!important` with odd spacing,
`url()` with and without quotes and with spaces, a string containing `{`
and `;`, custom properties with a complex brace value, `calc()` with
nested parentheses, `unicode-range`, comments in every position (leading,
trailing, right after `{`, between rules) including a `/*!` license
comment surviving minify, indent variants, both boolean options, and one
fixture per tolerant diagnostic case.
