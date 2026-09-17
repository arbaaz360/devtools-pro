# Text Escaping

`text.escaping` is a v2 bundled package with three independent operations over one named
`input` text document: `text.html` (HTML character references), `text.json-string` (one JSON
string literal) and `text.backslash` (this package's own backslash grammar). Each operation
has a `mode` of `escape` or `unescape`. The three grammars never mix: `\n` is plain text to the
HTML operation, `&amp;` is plain text to the backslash operation, and the JSON string operation
handles exactly one string value, never a whole document.

Input is read through `ProcessorContext.readChunks` and must be UTF-8; the bytes are copied, so
the host's source document is never modified. The complete result is written once as the
`output` artifact together with a properties value (`operationId`, `mode`, the normalized
`options`, `inputBytes`, `outputBytes`, `sequences`, the `text`, and `complete: true`). HTML
unescape also reports `preserved` (unknown references kept as text), `replaced` (references
turned into U+FFFD) and `remapped` (C1 references remapped to windows-1252).

## Options

Option ids are the manifest's kebab-case identifiers. Unknown or misspelt ids (including
camel-cased ones) are rejected with `option.unknown`; wrong values with `option.invalid`.

| Operation | Option | Values (default first) | Applies to |
| --- | --- | --- | --- |
| all | `mode` | `escape`, `unescape` | |
| `text.html` | `numeric` | `decimal` (`&#233;`), `hex` (`&#xE9;`) | escape |
| `text.html` | `prefer-named` | `true`, `false` | escape |
| `text.html` | `encode-everything` | `false`, `true` | escape |
| `text.html` | `allow-unsafe-symbols` | `false`, `true` (ignored when `encode-everything`) | escape |
| `text.html` | `strict` | `true`, `false` | unescape |
| `text.json-string` | `quotes` | `include`, `omit` | both |
| `text.json-string` | `ascii-only` | `false`, `true` | escape |
| `text.backslash` | `quotes` | `both`, `double`, `single`, `none` | escape |
| `text.backslash` | `non-ascii` | `keep`, `unicode`, `utf16` | escape |

## HTML character references (`text.html`)

### Escape

| Input | Output |
| --- | --- |
| `&` `<` `>` `"` `'` (unsafe symbols) | `&amp;` `&lt;` `&gt;` `&quot;` `&apos;`, unless `allow-unsafe-symbols` |
| Tab, LF, CR, printable ASCII | literal, unless `encode-everything` |
| Other C0 controls and DEL | numeric reference (`&#27;`), so they become visible |
| U+0000 and U+0080–U+009F | literal: HTML has no reference for NUL, and browsers read `&#128;`–`&#159;` as windows-1252 characters |
| U+00A0 and above | named reference when `prefer-named` and a name exists, else numeric |
| Astral characters | one reference per code point (`&#x1F600;`), never surrogate halves |

`encode-everything` references every character except the literal exceptions above and
overrides `allow-unsafe-symbols`. Named references supersede the `numeric` choice. The names
that escaping may emit are the 250 HTML 4.01 names that HTML5 still defines with the same
meaning, plus `apos` (251 in total); `&lang;` and `&rang;` are never emitted because HTML5 moved
them to U+27E8/U+27E9. Hexadecimal references use upper-case digits (`&#xE9;`).

Escaping is not injective under `allow-unsafe-symbols`: an existing `&amp;` in the input is
left alone and decodes on the way back.

### Unescape

Decoding follows the WHATWG HTML tokenizer's character reference states for text content (the
attribute-value exception for legacy names is not applied). The named table is the complete
WHATWG list of 2231 names, including the 106 legacy names that decode without a semicolon;
it is generated into `html-entities.mjs` by `scripts/generate-entities.py` from the Python
standard library and pinned by SHA-256 in `test.mjs`. Names are case-sensitive
(`&AMP;` yes, `&Amp;` no). The longest table entry wins, exactly as browsers consume it:
`&notit;` is `&not` + `it;`.

`strict: true` (default) turns every HTML5 character-reference parse error into a rejection
with a byte offset. `strict: false` reproduces browser behaviour.

| Input | Strict | Permissive |
| --- | --- | --- |
| `&amp;` `&#233;` `&#xE9;` `&#Xe9;` `&#0233;` | decoded | decoded |
| `&#9;` `&#10;` `&#12;` `&#32;` | decoded (ASCII whitespace) | decoded |
| Bare `&` before space, `&`, end, or a non-name (`AT&T`, `&foo` without `;`) | text | text |
| `&foo;` (unknown name) | `html.unknown-named-reference` | kept as text (`preserved`) |
| `&copy` `&#233` (missing semicolon) | `html.reference-missing-semicolon` | decoded |
| `&#;` `&#x;` (no digits) | `html.numeric-reference-empty` | kept as text |
| `&#0;` | `html.numeric-reference-null` | U+FFFD (`replaced`) |
| `&#xD800;` (surrogate) | `html.numeric-reference-surrogate` | U+FFFD |
| `&#x110000;` and larger | `html.numeric-reference-out-of-range` | U+FFFD |
| `&#x80;`–`&#x9F;` with a windows-1252 mapping | `html.numeric-reference-control` | remapped (`&#x80;` → `€`, `remapped`) |
| `&#13;`, other C0/C1 controls, DEL | `html.numeric-reference-control` | decoded to the control |
| `&#xFFFE;` and other noncharacters | `html.numeric-reference-noncharacter` | decoded |

Because escaping writes `&#27;` for ESC (and `&#13;` for CR under `encode-everything`), such
output round-trips only through permissive unescape; the strict rejection says so.

## JSON string literal (`text.json-string`)

The operation is deliberately distinct from JSON document formatting: input that starts a
document (`{`, `[`, a number, `true`) is rejected with `json.expected-string` and a pointer to
the JSON tool.

### Escape

The output is the RFC 8259 literal for the input text, identical to `JSON.stringify`:
`"` → `\"`, `\` → `\\`, U+0008/000C/000A/000D/0009 → `\b \f \n \r \t`, other C0 controls →
`\u00XX` (lower-case hex). `/`, DEL, U+2028/U+2029 and all non-ASCII text stay literal.
`ascii-only` additionally writes every code unit above U+007E as `\uXXXX`, so astral characters
become surrogate pairs (`😀`). `quotes: omit` writes the body without the surrounding
double quotes.

### Unescape

```
literal  := ws* '"' body '"' ws*             (quotes: include)
body     := ( char | escape )*               (quotes: omit reads the whole input as body)
char     := any code point except '"', '\' and U+0000–U+001F
escape   := '\' ( '"' | '\' | '/' | 'b' | 'f' | 'n' | 'r' | 't' | 'u' HEX{4} )
ws       := ' ' | TAB | LF | CR
```

A `\uD800`–`\uDBFF` escape must be followed immediately by a `\uDC00`–`\uDFFF` escape; the pair
is combined. Rejections, each with a byte offset: `json.expected-string`,
`json.unterminated-string`, `json.trailing-content` (anything after the closing quote),
`json.unescaped-control`, `json.unescaped-quote` (raw `"` inside a body), `json.invalid-escape`
(`\x`, `\'`, `\0`, `\v`, `\U`, line continuations, with the JSON spelling in the hint),
`json.invalid-unicode-escape`, `json.incomplete-escape` and `json.lone-surrogate`. For every
valid literal the result equals `JSON.parse`; lone surrogates are the one place this operation
is stricter, because the artifact must be valid UTF-8.

## Backslash sequences (`text.backslash`)

The grammar is this package's own and is independent of HTML and of JSON literals.

```
escape := '\' ( '\' | 'n' | 'r' | 't' | 'b' | 'f' | 'v' | '0' | '"' | "'"
             | 'x' HEX{2}                       code point U+0000–U+007F only
             | 'u' HEX{4}                       UTF-16 code unit; a surrogate pair is combined
             | 'u{' HEX{1,6} '}' )              scalar value U+0000–U+10FFFF
```

### Escape

| Input | Output |
| --- | --- |
| `\` LF CR TAB BS FF VT | `\\` `\n` `\r` `\t` `\b` `\f` `\v` |
| U+0000 | `\0`, or `\x00` when an ASCII digit follows (so the output is never ambiguous) |
| Other C0 controls and DEL | `\xHH` (lower-case) |
| `"` `'` | `\"` `\'` according to `quotes` |
| U+0080–U+009F | always `\u00HH` |
| U+00A0 and above | `non-ascii: keep` literal; `unicode` `\uHHHH` for the BMP and `\u{HHHHH}` above it; `utf16` `\uHHHH` per code unit (surrogate pairs) |

Literal newlines in the input are escaped; on unescape a literal newline stays a newline while
`\n` is interpreted. Escaped text under any option combination unescapes back to the original.

### Unescape rejections

| Input | Code | Why |
| --- | --- | --- |
| trailing `\` | `backslash.incomplete-escape` | |
| `\q`, `\a`, `\e`, `\/`, `\U0001F600`, `\7`, backslash-newline | `backslash.unknown-escape` | hint names the supported spelling (`\x07`, `\x1b`, JSON tool, `\u{…}`, `\xHH`, `\n`) |
| `\012` | `backslash.ambiguous-octal` | `\0` + digit is octal in some languages and NUL + digit in others |
| `\xc3` (`\x80`–`\xff`) | `backslash.ambiguous-hex-escape` | a UTF-8 byte in some languages, U+00C3 in others; use `Ã` |
| `\x4`, `\xZZ` | `backslash.invalid-hex-escape` | exactly two hex digits |
| `\u12`, `\u{}`, `\u{1234567}`, `\u{12G}` | `backslash.invalid-unicode-escape` | |
| `\u{1F600` | `backslash.unterminated-unicode-escape` | |
| `\u{110000}` | `backslash.unicode-escape-out-of-range` | |
| `\ud83d` alone, `\ud83dA`, `\ude00`, `\u{D800}` | `backslash.lone-surrogate` | |

## Diagnostics

Every rejection is an `EscapeError` with `code` (a contract `Identifier` such as
`html.unknown-named-reference`), `byteOffset` (UTF-8 offset of the offending sequence, the
authoritative location per the tool contract), `line` and `column` (1-based display hints,
column in code points) and `hint`. The message repeats them:
`"&foo;" is not a named character reference at byte offset 3 (line 1, column 4); …`. Invalid
UTF-8 input is rejected as `input.invalid-utf8` with the offset of the first bad byte. The v2
SDK has no diagnostic emitter, so these fields travel on the thrown error until a host maps
them to `Diagnostic` events.

## Limits and cancellation

Reads use `readChunks` with 64 KiB chunks; the SDK enforces `maxInputBytes` (4 MiB in the
manifest). Cancellation is checked between chunks, every 4096 iterations of each transform,
and by the SDK before each write. Output is measured before writing and rejected with
`limit.output` when it exceeds `min(maxOutputBytes, maxChunkBytes)`; nothing is written in
that case. `deadlineMs` is the host scheduler's responsibility.

SDK gaps observed while building this package: the v2 `OutputSink` replaces the artifact on
each `write`, so an artifact is effectively bounded by `maxChunkBytes` (1 MiB) rather than the
manifest's 16 MiB `maxOutputBytes`; the headless runner uses `defaultLimits()` rather than the
manifest limits; and there is no processor-side diagnostic channel.

## Checks

```text
node plugins/escaping/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin text.escaping --operation text.html --input 'input=<p>Tom & Jerry</p>' --options '{"mode":"escape","numeric":"hex"}'
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin text.escaping --operation text.json-string --input 'input="line\né"' --options '{"mode":"unescape"}'
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin text.escaping --operation text.backslash --input 'input=a\tb' --options '{"mode":"unescape"}'
python plugins/escaping/scripts/generate-entities.py
```

Fixtures live in `fixtures/` and are listed in the manifest: one escape, one unescape and one
errors file per grammar. Error vectors pin the code, byte offset and, where useful, line,
column and a message fragment; `inputBytes` vectors feed raw bytes for UTF-8 cases.
