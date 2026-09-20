# HTML plugin

`format.html` (DU-13) beautifies or minifies HTML. It exposes two operations,
`beautify` and `minify`, over one required text input port, `input`, and writes
one `artifact` output port, `output` (`text/html`, representations `code`,
`properties` and `annotations`).

The processor is the only implementation; there is no native executor for this
tool. It uses web platform APIs only (`TextDecoder`, `TextEncoder`,
`Uint8Array`), so it runs unchanged in the desktop webview's Worker engine and
under Node.

Formatting is tolerant: incomplete or malformed markup is still formatted, and
every recovery is reported as a `warning` diagnostic. **Tolerant beautification
is not validation** — a clean run means the formatter had nothing to recover
from, not that the document is valid HTML. Only an empty document, invalid
UTF-8, an invalid option or a limit breach fails.

## Pipeline

1. `context.readChunks("input", 65536)` reads the immutable source; the bytes
   are decoded as UTF-8 (`fatal`, so a bad sequence is `html.invalid-utf8`).
2. The tokenizer makes one forward pass. It never returns to a character it has
   left behind, and the only lookahead it holds is the fixed prefix of a markup
   construct (`<!--`, `<!DOCTYPE`, `</name`), so the buffer it needs is bounded
   by the longest element name rather than by the document.
3. The tokens become a tolerant element tree, which is where optional end tags,
   mismatched end tags and unclosed elements are resolved.
4. The tree is rendered by the beautifier or the minifier.

Cancellation is polled every 4096 tokens during tokenizing, tree building and
rendering, and between read chunks. The source bytes are never modified; every
test asserts that after every run.

## Tokenizer

| Construct | Handling |
|---|---|
| `<!DOCTYPE …>` (any case) | kept verbatim, emitted on the first line as written |
| `<!-- … -->` | comment; an unterminated comment runs to end of input |
| `<!…>` and `<?…>` | bogus comment, kept verbatim |
| `<name …>` | start tag; the name is compared lowercase and emitted as written |
| `</name …>` | end tag; the name is compared lowercase and emitted as written |
| text | everything else, including a `<` that starts no markup |
| character references | never touched; `&amp;`, `&#169;` and `&notanentity;` pass through inside text |

Attributes are parsed in all four HTML spellings and each one is emitted
**exactly as written**, separated by a single space: `href="x"` (double-quoted),
`href='x'` (single-quoted), `href=x` (unquoted) and `checked` (valueless). The
whitespace around `=` is normalised away; the quoting style never is. Attribute
names, like tag names, are compared case-insensitively and emitted as written.

**Void elements** — `area base br col embed hr img input link meta source track
wbr` — never get an end tag, and no end tag is ever invented for them. An end
tag for a void element, the classic stray `</br>`, is dropped with an
`html.void-end-tag` diagnostic.

**Raw-text elements** — `script style pre textarea` — have their content
emitted byte for byte, indentation and newlines included, by both operations.
Their content ends at the first `</name` followed by whitespace, `/`, `>` or
end of input, so `a < b`, `</p>` inside a string, and `</ ` inside a comment all
stay inside the script. `<pre>` content is therefore never altered by either
operation. Formatting the JavaScript or CSS inside `<script>` and `<style>` is
out of scope; DU-15 and DU-14 own those.

## Element categories

An element is **inline** when it is in this list: `a abbr b bdi bdo cite code
data dfn em i kbd mark q s samp small span strong sub sup time u var wbr img
input label select textarea button`. Every other element is a **block element**,
whether it is one of the named blocks (`html head body div p section article
header footer nav main aside ul ol li table thead tbody tfoot tr td th form
fieldset h1`–`h6 blockquote figure figcaption details summary dl dt dd hr br`)
or an element the formatter has never heard of, such as `<my-panel>`. Unknown
elements are blocks.

`pre`, `script` and `style` are not in the inline list, so they are block
elements; `textarea` is in it, so it stays inline.

## Beautify

- Every block element starts a new line, indented one level deeper than its
  parent, and its end tag gets a line of its own.
- A block element whose children are only text, inline elements and comments
  keeps that content on the element's own line: `<td>1</td>`, `<title>x</title>`
  and `<p>See <a href="/d">the docs</a> and <b>this</b>.</p>` are each one line.
  This is what "inline elements stay inline with their surrounding text" means:
  a run of inline content is one line and is never reflowed, however long it is.
- A block element with at least one block child is split: start tag line,
  children one level deeper, end tag line. Runs of inline content between block
  children each get their own line.
- A block element with no children at all is emitted as `<div></div>`.
- Text runs have internal whitespace collapsed to a single space and are trimmed
  where they touch a **block** boundary — the edge of a block element's content,
  the edge of the document, or the side that touches a block sibling. Inside an
  inline element the edges are kept as one space, so `<b>bold </b>` does not
  lose its space. Whitespace-only text between block elements is dropped.
  HTML whitespace only: a no-break space is text, not whitespace.
- The doctype is emitted on the first line as written.
- There is no trailing newline.

## Minify

The whole document is concatenated with no added whitespace and no newline
outside a raw-text element. Text runs follow exactly the same collapse-and-trim
rule as beautify, which is what makes the round trip below a fixed point:
whitespace between block elements disappears, runs of whitespace inside text
become one space, and a space between two inline pieces survives. Attribute
quoting is preserved and raw-text content is untouched.

`beautify` → `minify` → `beautify` is byte-identical for every fixture that
produces no diagnostics, and `minify` is idempotent. Both are tested over every
fixture in `fixtures/`.

## Optional end tags

`li p dt dd tr td th option thead tbody tfoot html head body` may omit their end
tag. The formatter closes them the way the HTML parser closes them — a `<li>`
closes an open `<li>`, a `<p>` closes when a block element starts, a `<td>`
clears back to the open `<tr>`, a `<tr>` clears back to the open table section,
`<body>` closes an open `<head>` — but **the output keeps the source's choice**:
an end tag the source omitted is never added, and an end tag the source wrote is
always kept.

The paragraph rule follows the HTML parser rather than the layout categories:
`<br>` is laid out as a block element but does **not** close a paragraph, and
neither does an unknown element, which may well be phrasing content. The
elements that do close a `<p>` are the named blocks other than `<br>`, plus the
blocks HTML lists that have no layout rule of their own (`address`, `center`,
`dialog`, `dir`, `hgroup`, `listing`, `menu`, `plaintext`, `pre`, `xmp`).

```html
<ul><li>one<li>two <b>bold</b> text</ul>
```

```html
<ul>
  <li>one
  <li>two <b>bold</b> text
</ul>
```

Because omitting one of these end tags is valid HTML, closing one implicitly is
not a recovery and produces no diagnostic. Every other element that is still
open when its parent closes, or when the document ends, does produce one.

## Options

| Id | Type | Default | Meaning |
|---|---|---|---|
| `indent` | enum | `2` | `2`, `4` or `tab` |
| `preserve-comments` | boolean | `true` | keep comments; conditional comments are always kept |
| `wrap-attributes` | enum | `auto` | `auto` keeps attributes on the tag line; `force` puts one per line |
| `indent-inner-html` | boolean | `false` | indent `<head>` and `<body>` inside `<html>` |

Ids are kebab-case. Every multi-word id also accepts its camelCase alias
(`preserveComments`, `wrapAttributes`, `indentInnerHtml`); supplying both with
different values is an error. An unknown key, a value of the wrong type and a
value outside an enum are all `html.invalid-option` errors carrying the offending
key in `data`.

`indent` accepts `"2"`, `"4"` and `"tab"`, the integers `2` and `4`, and the
manifest's choice ids `"spaces-2"` and `"spaces-4"`. **The manifest declares the
choice ids `spaces-2`, `spaces-4` and `tab` rather than `2`, `4` and `tab`
because the v2 contract's `ChoiceIdentifier` must start with a letter
(`packages/plugin-contract/schema/contract.v2.schema.json`); a manifest with a
choice id of `2` is rejected by `validateManifest` and the package would not be
discovered.** The processor accepts every spelling so the option behaves as
DU-13 and the packet describe it.

`preserve-comments: false` drops ordinary comments from the token stream before
anything else looks at them, so the text on either side becomes adjacent and
`a <!-- c --> b` minifies to `a b` rather than `ab`. A comment whose first
characters are `<!--[if` is a conditional comment and is always kept, in both
operations, whatever the option says.

`wrap-attributes: force` breaks a tag that has **more than one** attribute:

```html
<div
  class="card wide"
  id="main"
  data-role="panel">
  <p class="only">text</p>
</div>
```

The `>` (or `/>`) stays on the last attribute's line. Wrapping applies to the
tags the beautifier puts on their own lines; inline elements inside a run keep
their attributes on the tag line, because breaking them would reflow paragraph
content. `minify` ignores the option entirely.

`indent-inner-html: false`, the default, leaves `<head>` and `<body>` at the
level of `<html>`; their own children are still indented one level.

```html
<html>
<head>
  <title>x</title>
</head>
<body>
  <div>y</div>
</body>
</html>
```

With `indent-inner-html: true` the two sections are indented inside `<html>`
like any other child.

## Diagnostics

Every diagnostic is a `warning`, carries the byte `offset` and `end` plus the
derived `line` and `column` (code points, CRLF counted as one break), and names
the tag in both `message` and `data.tag`. Formatting always continues.

| Code | When |
|---|---|
| `html.unclosed-element` | a non-void element with a required end tag is closed by end of input or by an enclosing tag |
| `html.mismatched-end-tag` | an end tag closes the nearest open element of that name and something else was still open inside it |
| `html.stray-end-tag` | an end tag has no open element of that name; it is dropped |
| `html.void-end-tag` | an end tag was written for a void element, such as `</br>`; it is dropped |
| `html.unquoted-attribute` | an unquoted attribute value contains `"`, `'`, `` ` ``, `<` or `=` |
| `html.content-after-html` | the first non-whitespace content after `</html>` |

`html.unquoted-attribute` is how the packet's "unquoted attribute with `>` or
`"` inside" is reported. A `>` inside an unquoted value cannot be observed after
the fact — it ends the tag, and what follows becomes text — so the diagnostic
fires on the characters that *can* be seen (`"` and the other characters the
HTML spec calls parse errors there) and its message states that an unquoted
value ends at the first whitespace or `>`.

Errors, which do stop the run, are `html.empty` (a document with no
non-whitespace content), `html.invalid-utf8`, `html.invalid-option`,
`html.unsupported-operation`, `html.input-limit` and `html.output-limit`.
No output is written when one is raised.

## Properties

The `output` value carries:

| Field | Meaning |
|---|---|
| `elements` | start tags in the source, void and self-closing included |
| `attributes` | attributes across all start tags |
| `comments` | comments in the source, before `preserve-comments` is applied |
| `depth` | deepest element nesting |
| `diagnostics` | how many diagnostics were reported |
| `bytes` | output byte length |

`operation`, `inputBytes`, the normalized `options` and the `annotations` array
(the diagnostics themselves, for the `annotations` representation) are also
included.

## Limits

`maxInputBytes` is 16 MiB and `maxOutputBytes` is 32 MiB. An input above the
limit is `html.input-limit`; an output above `min(maxOutputBytes,
maxChunkBytes)` is `html.output-limit` and nothing is written, because the SDK
sink accepts one chunk per artifact and a truncated document would be worse than
no document.

## Fixtures

`fixtures/beautify.json` (71 cases), `fixtures/minify.json` (16 cases),
`fixtures/large-list.json` (a 3000-element list, a 72nd beautify case) and
`fixtures/invalid.json` (17 rejected option and empty-document cases). Each
formatting case is `{ name, options, input, output, diagnostics }` and the
diagnostics are compared field by field, positions included. Eighty of the
eighty-eight formatting cases produce no diagnostic and are driven through the
round trip; all eighty-eight are checked for idempotence in both operations.

```text
node --experimental-strip-types --test plugins/html/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin format.html --operation beautify --input "input=<p>x</p>"
```

## Out of scope

Formatting the JavaScript inside `<script>` (DU-15) or the CSS inside `<style>`
(DU-14); entity decoding; validation; syntax highlighting, which is shell work.
HTML Preview (DU-11) is a different tool.
