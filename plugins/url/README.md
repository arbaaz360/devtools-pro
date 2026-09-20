# URL utilities plugin

Bundled v2 package `web.url` with two tools: `text.url` (`url.transform`) percent-encodes or decodes a text document as an RFC 3986 component or as `application/x-www-form-urlencoded` data, and `web.url-parser` (`url.parse-query`) parses query parameters from a raw query, a leading `?`, or an absolute URL. The processor uses only the public `ProcessorContext` boundary, works on the source bytes directly, and never mutates them.

Run from the repository root:

```text
node --experimental-strip-types --test plugins/url/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin web.url --operation url.transform --input "input=café / ?+" --options '{"mode":"encode","encoding":"rfc3986"}'
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin web.url --operation url.parse-query --input "input=?a=1&a=2&tag[]=x+y" --options '{"indent":0}'
```

## Input

Both operations read the whole `input` document through `context.readChunks` in 64 KiB ranges and require it to be valid UTF-8. Invalid input fails with `input is not valid UTF-8 text: byte 0xNN at byte offset N ...` before any output is written. Encoding never operates on non-UTF-8 bytes, even though percent encoding could represent them.

## `url.transform`

Options: `mode` (`encode` | `decode`, default `encode`) and `encoding` (`rfc3986` | `form`, default `rfc3986`). Nothing is trimmed; every input byte is transformed.

| | `rfc3986` | `form` |
|---|---|---|
| Kept as-is when encoding | `A-Z a-z 0-9 - . _ ~` (RFC 3986 unreserved) | `A-Z a-z 0-9 * - . _` (WHATWG form-urlencoded safe set) |
| Space | `%20` | `+` |
| Everything else | `%XX` per UTF-8 byte, uppercase hex | `%XX` per UTF-8 byte, uppercase hex |
| `+` when decoding | literal `+` | space |
| `%XX` when decoding | one byte, upper- or lowercase hex accepted | same |

Reserved characters such as `/ ? # & = : @ ! $ ' ( ) * , ;` are always encoded in `rfc3986` mode (unlike `encodeURIComponent`, which leaves `!'()*` alone). In `form` mode `~` becomes `%7E` and `*` is kept, matching `URLSearchParams`. Newlines are encoded as `%0A` / `%0D%0A`, never normalised.

Decoding is one pass over the input: `%2520` becomes `%20` and is never decoded again. Every `%` must be followed by exactly two hexadecimal digits, and the decoded bytes must be valid UTF-8 (RFC 3629: no overlongs, surrogates, or code points above U+10FFFF). WHATWG's lenient form decoding, which leaves malformed escapes alone, is deliberately not used. Errors name the offending token and the byte offset in the source document:

```text
percent escape "%G0" at byte offset 0 must use two hexadecimal digits
percent escape "%4" at byte offset 3 is truncated; expected two hexadecimal digits
decoded bytes are not valid UTF-8: byte 0xE2 produced at input byte offset 0 does not begin a well-formed sequence
```

The structured value is `{ mode, encoding, text, inputBytes, outputBytes, complete: true }`.

## `url.parse-query`

Option: `indent` (integer or decimal string 0–8, default 2) for the JSON artifact.

### Where the query is

Leading and trailing ASCII whitespace (space, tab, CR, LF) is ignored; the count is reported as `trimmedBytes`. The rest is classified once, in this order:

| `form` | Rule | `components.path` |
|---|---|---|
| `url` | Starts with `scheme://`. The text must parse with the WHATWG URL parser, otherwise `input looks like an absolute URL but is malformed`. | WHATWG-normalised `pathname`; `href`, `scheme`, `host` (with port) are also filled |
| `query` | Starts with `?` | `""` |
| `reference` | Contains a `?` before any `#` (for example `example.test/p?a=1` or `/p?a=1`) | verbatim text before the `?` |
| `raw` | No `?` before any `#` | `null` |

In every form the first unencoded `?` starts the query and the first `#` ends it; a second `?` is data (`?a=1?b=2` → `a` = `1?b=2`). Without a `?` the whole text up to `#` is the query. `components.query` and `components.fragment` are always the source text, not WHATWG-normalised. Interior newlines in the query are kept as data, while the `href` component follows WHATWG and strips them. A literal `?` or `#` inside a parameter must be percent-encoded.

### Parameters

- Segments are split on `&`; empty segments (`&&`, leading or trailing `&`) are skipped and counted in `counts.emptySegments`.
- The first `=` splits name and value; later `=` are part of the value. A segment without `=` has value `""` and `hadEquals: false`. Empty names are ordinary parameters.
- Names and values are decoded once with form semantics: `+` is a space, `%XX` is a byte, and the result must be valid UTF-8. Encoded delimiters stay data: `a%3Db=c%26d` is the single parameter `a=b` = `c&d`. Errors say which parameter and which byte offset of the input: `percent escape "%zz" in the value of parameter 2 at byte offset 7 must use two hexadecimal digits`.
- **Brackets:** a decoded name that ends in `[]` is an array parameter stored under the name without the `[]`; a single occurrence still yields an array. Exactly one terminal `[]` is removed; every other bracket is literal, so `n[0]`, `n[a]` are scalar names and `d[][]` is the array `d[]`. `a%5B%5D` is `a[]` (decoding happens first) while `a%255B%255D` is the literal name `a%5B%5D`. A name that appears both as `a` and `a[]` is one parameter; values merge in encounter order.
- A repeated name becomes an array in encounter order (`a=1&a=2` → `["1","2"]`). Blank values are kept.
- Names such as `__proto__`, `constructor` or `toString` are ordinary own properties.

### Output

The artifact is the `parameters` object as JSON in first-encounter order (`b=1&2=x&a=3` → `{"b":"1","2":"x","a":"3"}`). The structured value contains:

| Field | Meaning |
|---|---|
| `form`, `components` | classification above; `components` always has `href`, `scheme`, `host`, `path`, `query`, `fragment` (null when absent) |
| `parameters` | `{ name: string \| string[] }`. JavaScript objects list integer-like names first, so read `entries` or the artifact for the exact sequence |
| `entries[]` | `{ key, name, value, arrayNotation, hadEquals, offset }` per non-empty segment, in order; `name` is the decoded name as written (`tag[]`), `key` is the parameter it landed in, `offset` is the segment's byte offset in the input |
| `counts` | `parameters` (rows), `names`, `nodes`, `emptySegments` |
| `limits` | the row and node limits that applied |
| `trimmedBytes`, `bracketSemantics`, `inputBytes`, `outputBytes`, `complete` | |

## Limits and cancellation

| Limit | `url.transform` | `url.parse-query` | Enforced by |
|---|---|---|---|
| `maxInputBytes` | 1 MiB | 1 MiB | SDK `readChunks` |
| `maxOutputBytes` | 4 MiB | 4 MiB | processor (encode checks before allocating; decode and parse check before writing: `output of N bytes exceeds the M byte output limit`), then the sink |
| `maxChunkBytes` | 4 MiB | 4 MiB | the artifact is written as one chunk, so the manifest sets it equal to `maxOutputBytes` |
| `maxRows` | – | 10 000 non-empty segments; the excess is rejected before it is decoded | processor |
| `maxNodes` | – | 20 000 = properties + array elements of `parameters` | processor |
| `deadlineMs` | 2 000 | 2 000 | host scheduler, not the processor |

Encoding expands at most 3:1, so a full 1 MiB input always fits the output limit; the encoded text of a 1 MiB input can, however, exceed the input limit when decoded back. `maxRows` and `maxNodes` are package constants that mirror `manifest.json` (the test asserts this); the SDK `Limits` type does not carry them, so a host that puts `maxRows` / `maxNodes` on `context.limits` overrides the defaults. Cancellation is polled before reading, every 4096 bytes while encoding or decoding, and per segment while parsing; a cancelled job rejects with `ProcessorCancelled` and writes nothing. The SDK has no diagnostic emitter for processors, so malformed input is an execution error with the byte offset in its message rather than a span.

## Fixtures

`fixtures/url-transform.json` (encode/decode vectors with round trips), `fixtures/url-parse-query.json` (artifact text plus expected structured value per case) and `fixtures/url-invalid.json` (exact error substrings, including raw non-UTF-8 inputs as `inputHex`) are deterministic and are the cases `test.mjs` runs first; the remaining tests cover limits, cancellation polling, reader immutability, chunked reads and the UTF-8 validator against the platform decoder.
