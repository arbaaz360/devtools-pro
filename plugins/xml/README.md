# XML plugin

`format.xml` beautifies or minifies XML with a hand-written tokenizer, never
a DOM parser. Tolerant formatting and well-formedness checking are kept
separate: formatting only fails for two conditions (an empty document, or a
document with no `<` byte anywhere); every other malformed construct is
tolerated, reported as a `warning` diagnostic, and formatted by best effort.

## Semantics

**Tokenizer.** A single byte-level pass over the immutable source recognises
the XML declaration and other processing instructions (`<? ?>`), `<!DOCTYPE
...>` including a bracketed internal subset (quote-aware, so a `>` inside a
quoted entity value does not end the subset early), comments (`<!-- -->`),
`CDATA` sections, start/end/empty-element tags with attributes in single or
double quotes, text, and entity/character references (`&name;`, `&#123;`,
`&#x1F;`), which are left untouched wherever they are syntactically valid.
Attribute values, comments, CDATA bodies and PI bodies are always emitted
byte-for-byte from the source; nothing routes through `JSON`/`DOMParser`
decoding. Building the small node tree needed to classify each element's
content (see below) is the one deliberate departure from a pure streaming
design, matching `plugins/json/`'s reference-implementation memory bound.

**Beautify.** One node per line; child elements are indented one level.
Whitespace-only text between elements is dropped. An element with no element
children is *text-like*: its significant children (text, CDATA, a lone
comment, a lone PI, or some combination) are concatenated onto the element's
own line, with leading/trailing whitespace trimmed from each text node
(`<a>  hi  </a>` → `<a>hi</a>`) — this generalises the "text-only content
stays on the element's line" requirement to the no-element-children case in
general, and keeps beautify and minify agreeing on text trimming so the
round trip below holds. An element with *both* element children and
significant text/CDATA is *mixed content*: the entire span between its start
and end tag is copied byte-for-byte onto one line, exactly as it appeared in
the source (inline markup is never reflowed, and nested tags keep their
original attribute spacing). An element with only element children (and,
optionally, comments/PIs) is *structural*: each significant child is
recursively rendered on its own indented line. `indent` selects `sp2`/`sp4`
(2/4 spaces) or `tab`.

**Minify.** Same content classification as beautify, but no newlines are
introduced anywhere except inside an `xml:space="preserve"` subtree (below).
Whitespace-only text is still dropped, and text-like content still trims
each text node's leading/trailing whitespace — this is the same rule
beautify uses, not an additional one.

**Empty elements.** `collapse-empty` (default `true`) renders any element
with no significant content as `<a/>` regardless of how it appeared in the
source; with it `false`, empty elements are always rendered `<a></a>`.
Dropping a comment because `preserve-comments` is `false` can itself make an
element empty, and is accounted for before this decision (an element whose
only child was a dropped comment collapses too).

**`xml:space="preserve"`.** An element with `xml:space="preserve"` (and,
transitively, its descendants, unless one sets `xml:space="default"`) is
rendered with its entire content span copied byte-for-byte — no dropped
whitespace, no trimming, no reflow, in both beautify and minify. Only its
own start/end tags are reformatted normally.

**Round trip.** `beautify → minify → beautify` is byte-identical for every
fixture with zero diagnostics (`fixtures/beautify.json` cases with an empty
`diagnostics` array); `test.mjs` checks this for every such fixture. Mixed
content and preserved subtrees are copied byte-for-byte regardless of
operation, and text-like content is trimmed the same way by both operations,
which is what makes the round trip hold.

## Options

Kebab-case ids with camelCase aliases; unknown keys and wrong types are
structured errors (`xml.invalid-option`).

| Option | Aliases | Type | Default | Notes |
| --- | --- | --- | --- | --- |
| `indent` | — | enum `sp2` \| `sp4` \| `tab` | `sp2` | 2 spaces, 4 spaces, or one tab per level. The contract schema's `ChoiceIdentifier` requires an enum choice id to start with a letter, so the packet's "2, 4, tab" values are spelled `sp2`/`sp4`/`tab` here and in the manifest. |
| `preserve-comments` | `preserveComments` | boolean | `true` | When `false`, every comment (prolog, in-tree, trailing) is dropped from the output; comments are still counted in the `comments` property either way. |
| `collapse-empty` | `collapseEmpty` | boolean | `true` | Controls `<a/>` vs `<a></a>` for elements with no significant content. |

## Tolerant diagnostics

Each diagnostic is `{ code, severity: "warning", message, offset, end, line,
column }`; byte offsets are authoritative, `line`/`column` are 1-based
display hints (code points, `LF`/`CR`/`CRLF` as line breaks), matching the
convention in `plugins/json/`.

| Code | Trigger |
| --- | --- |
| `xml.unclosed-element` | An open element reaches end of input without a matching end tag, or is implicitly closed because an ancestor's end tag was seen first. |
| `xml.unmatched-end-tag` | An end tag names an element that is not open anywhere on the stack (or has no name at all); the stray end tag is ignored and the stack is untouched. |
| `xml.unquoted-attribute` | An attribute value is not wrapped in `"`/`'`; the run of non-whitespace, non-`>`, non-`/` bytes is taken as the value and copied through unquoted. |
| `xml.stray-lt` | A `<` that does not start a tag, comment, CDATA section, PI or DOCTYPE; it is kept as a literal text character. |
| `xml.stray-ampersand` | A `&` that does not start a valid `&name;`/`&#123;`/`&#x1F;` reference; it is kept as a literal text character. |
| `xml.trailing-content` | Non-whitespace content (text, a second top-level element, a stray end tag) appears at the top level after the root element has closed. Only the *first* such position is diagnosed; scanning stops there and everything from that point on is dropped from the output — comments and PIs after the root are always legal and never trigger this. |

**Mismatched end tags** are handled as a special case of unclosed elements,
not a separate diagnostic: when an end tag matches an ancestor further up
the stack than the innermost open element, every element between the top of
the stack and that ancestor is popped and reported as `xml.unclosed-element`
(named individually), then the matched ancestor is popped normally with no
diagnostic of its own. For `<root><open><inner>x</inner></root>`, `</root>`
matches the outer `root` two levels up; `open` is auto-closed and reported,
`inner` was already closed properly, and `root` closes without a diagnostic
of its own — exactly one diagnostic, naming `open`.

Text before the root element, and any `<`/`&` inside such text, is silently
dropped without a diagnostic (the packet defines diagnostics for the five
cases above and for trailing content *after* the root; prolog text is
outside both, and is rare enough in practice not to warrant inventing a new
code for it here).

## Properties

Every operation writes this value on `output` (in addition to the
formatted/minified artifact):

| Field | Meaning |
| --- | --- |
| `operation`, `inputBytes`, `outputBytes`, `bytes` | what ran; `bytes` is the produced output's size, matching `outputBytes`. |
| `elements`, `attributes`, `comments` | counts across the whole document (attributes counts every occurrence, including duplicates and unquoted ones; comments counts every comment found, regardless of `preserve-comments`). |
| `depth` | maximum element nesting depth; the root is depth 1. |
| `wellFormed` | `true` iff no diagnostics were raised. |
| `diagnostics` | diagnostic **count**, per the packet's Properties list. |
| `diagnosticsDetail` | the full diagnostic array, for callers that need positions and messages (not part of the packet's minimal Properties list, but needed for testing and UI detail). |
| `limits` | the effective `maxInputBytes`/`maxOutputBytes` (the smaller of the manifest's `maxOutputBytes` and `maxChunkBytes`, since the SDK output sink takes one chunk per artifact). |

## Limits and cancellation

| Limit | Value |
| --- | --- |
| Input size | `maxInputBytes`, 16 MiB |
| Output size | `maxOutputBytes`, 32 MiB (the manifest sets `maxChunkBytes` equal to it, so the SDK's one-chunk-per-artifact sink is never the binding constraint) |

Input is read with `context.readChunks`. The tokenizer polls cancellation
every 4096 tokens (each tag, comment, CDATA section, PI, DOCTYPE and
non-empty text run counts as one token), plus an additional check every 64
KiB scanned *inside* a single text run, so one pathologically large run of
plain text without any markup cannot starve cancellation between token
boundaries. A cancelled job publishes neither value nor artifact.

## Out of scope

Schema/DTD validation, entity expansion, encoding conversion (input is
UTF-8 text; tag/attribute names are matched as opaque byte runs, so
non-ASCII names pass through without a Unicode `Name` production check),
and syntax highlighting.

## Running the package checks

From the repository root:

```text
node --experimental-strip-types --test plugins/xml/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin format.xml --operation beautify --input "input=<?xml version='1.0'?><root a='1'><item>one</item><item><b>two</b> and text</item><empty></empty><!-- note --></root>"
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin format.xml --operation beautify --input "input=<root><open><inner>x</inner></root>"
```

Fixtures live in `fixtures/`: `beautify.json` (53 cases) and `minify.json`
(12 cases), each `{ name, options, input, output, diagnostics }`. They cover
declarations with encoding, a DOCTYPE with an internal subset, namespaces
and prefixed attributes, five levels of nesting, both empty-element styles,
CDATA with `<` inside, comments between and inside elements, mixed-content
paragraphs, `xml:space="preserve"` (including inheritance and reset),
entity references, a 2000-element flat list, and one fixture per tolerant
diagnostic category (plus the mismatched-end-tag and stray-end-tag variants
described above).
