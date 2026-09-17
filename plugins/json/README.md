# JSON plugin

`structured.json` is the first vertical-slice plugin. It exposes `format`,
`minify` and `inspect` (Validate) over one required text input port, `input`.
The native host currently executes `format` and `minify` through its Rust
adapter (`transform_json_bytes` in `devtools-core`); the package processor in
this directory is the SDK/headless reference implementation and the executable
specification that the fixtures below pin down. Both are lexeme-preserving and
produce the same layout.

## Semantics

**Grammar.** RFC 8259, no extensions: no comments, no trailing commas, no
single quotes, no `NaN`/`Infinity`, no leading zeros, no `+` sign, no raw
control characters (U+0000–U+001F) inside strings, only the eight two-character
escapes and `\uXXXX`. Any value, including a scalar, may be the top-level value.
Only `space`, `tab`, `LF` and `CR` are whitespace. Anything after the top-level
value other than whitespace is `json.trailing-content`.

**Bytes in, bytes out.** The input is read through `context.readChunks` and is
never modified. Every string and number lexeme in the output is a verbatim copy
of the source bytes: `"é"` stays escaped, `"é"` stays raw, `"\/"` keeps
its solidus escape, `\uD83D` keeps its hex case, `-0`, `1.2300`, `1E+2` and
`1e999` keep their spelling. Only insignificant whitespace changes.

**Format layout.** Two spaces per level, `": "` after member names, `,` at the
end of a line, empty containers stay `{}` / `[]`, no trailing newline. For input
that has no lexeme-sensitive content this is byte-identical to
`JSON.stringify(value, null, 2)`, and the test suite checks that oracle on the
cases marked `"oracle": true`. **Minify layout** drops all whitespace. Both are
fixed points and convert into each other.

**Numbers.** Lexemes are never routed through JavaScript `Number`, so
`12345678901234567890` and `18446744073709551615` survive format and minify.
`inspect` classifies lexemes by shape: `integers` (no fraction, no exponent)
and `withFractionOrExponent`. An integer lexeme whose magnitude exceeds
`2^53 - 1` is counted in `unsafeIntegers` and reported as an `info` diagnostic
`json.unsafe-integer` at its position, because a consumer that parses it with
`Number` will round it. Exponents that overflow a double (`1e999`) are
grammatical and accepted; no range check is performed.

**Duplicate member names.** `format` and `minify` keep every member in source
order, exactly like the native core (`{"a":1,"a":2}` stays `{"a":1,"a":2}`).
All three operations report each later occurrence as a `warning` diagnostic
`json.duplicate-key` whose `related[0]` span is the first occurrence. Names are
compared after escape decoding, so `"a"` and `"a"` are the same member;
comparison is case sensitive and per object, so the same name in nested or
sibling objects is not a duplicate. Consumers using `JSON.parse` will see the
last value; consumers using ordered/streaming parsers will see both.

**Encoding.** Input must be UTF-8. A leading UTF-8 BOM is not part of the JSON
value: it is skipped, reported as `json.bom` (`info`), and not copied to the
output. A UTF-16 BOM fails with `json.unsupported-encoding`. Encoding is checked
before grammar, so an invalid sequence anywhere in the document fails with
`json.invalid-utf8` at the first bad byte even if a syntax error precedes it.
Overlong forms, encoded surrogates and code points above U+10FFFF are invalid.
A lone surrogate written as an escape (`"\uDC00"`) is syntactically valid and
preserved; RFC 8259 allows it and the native core accepts it too.

**Validate result.** `inspect` writes a structured value and never an artifact.
An invalid document is a normal, complete result with `valid: false` and the
error in `diagnostics`; it is not an execution failure, because the position is
only useful as data. `format` and `minify` throw a `JsonError` whose `code` and
`diagnostic` carry the same structured information, and publish nothing.

## Structured value

Every operation writes this value on `output` (`format`/`minify` also write the
artifact; `inspect` writes only the value):

| Field | Meaning |
| --- | --- |
| `valid`, `complete` | grammar verdict; `complete` is always `true` |
| `operation`, `encoding`, `bom` | what ran, always `utf-8`, whether a BOM was skipped |
| `inputBytes`, `contentBytes` | source size including / excluding the BOM |
| `topLevel`, `maxDepth` | `object`, `array`, `string`, `number`, `boolean`, `null`; depth is 0 for a scalar |
| `counts` | `objects`, `arrays`, `members`, `elements`, `strings`, `numbers`, `booleans`, `nulls` |
| `numbers` | `integers`, `unsafeIntegers`, `withFractionOrExponent` |
| `duplicateKeys` | number of later occurrences |
| `formattedBytes`, `minifiedBytes`, `outputBytes` | sizes both layouts would produce; size actually written |
| `diagnostics`, `suppressedDiagnostics` | ordered by offset; see below |
| `limits`, `policy` | the effective limits and the semantic policies named above |

Statistics fields are `null` when `valid` is `false`.

## Diagnostics

Each diagnostic is `{ code, severity, message, offset, end, line, column,
related? }`. **Byte offsets are authoritative** and refer to the original
input including the BOM; `line` and `column` are 1-based display hints, with
`LF`, `CRLF` and lone `CR` as line breaks and columns counted in Unicode code
points (the BOM has zero width). `end` is exclusive and clamped to the input.

| Code | Severity | Position |
| --- | --- | --- |
| `json.empty` | error | end of input (no value found) |
| `json.unexpected-token` | error | the offending character; message says what was expected |
| `json.unexpected-end` | error | end of input inside a container or after `:`/`,` |
| `json.unterminated-string` | error | span from the opening quote to end of input |
| `json.invalid-escape` | error | the backslash |
| `json.control-character` | error | the raw control byte |
| `json.invalid-number` | error | the number lexeme (leading zero, bare `-`, `1.`, `1e`) |
| `json.invalid-literal` | error | a misspelled `true`/`false`/`null` |
| `json.trailing-comma` | error | the `]` or `}` after the comma |
| `json.trailing-content` | error | first byte after the top-level value |
| `json.depth-limit` | error | the bracket that would open level 257 |
| `json.invalid-utf8` | error | first byte of the invalid sequence |
| `json.unsupported-encoding` | error | offset 0 (UTF-16 BOM) |
| `json.output-limit` | error | no position |
| `json.duplicate-key` | warning | the repeated name; `related[0]` is the first occurrence |
| `json.unsafe-integer` | info | the integer lexeme |
| `json.bom` | info | bytes 0–3 |

At most 100 diagnostics per code are retained; the rest are counted in
`suppressedDiagnostics`, and `duplicateKeys` / `unsafeIntegers` still count all.

## Limits and cancellation

| Limit | Value | Enforced by |
| --- | --- | --- |
| Input size | `limits.maxInputBytes` (manifest: 64 MiB) | SDK `readChunks` before parsing |
| Output size | `min(maxOutputBytes, maxChunkBytes)` (manifest: 1 MiB effective) | processor, before allocating output |
| Nesting depth | 256 (matches native `MAX_DEPTH`) | processor |
| Diagnostics per code | 100 | processor |

The processor runs two passes over the immutable input: a validating pass that
computes statistics, diagnostics and the exact output size, then an emitting
pass into a pre-sized buffer. Validation errors therefore take precedence over
output limits, and an over-limit result is rejected with `json.output-limit`
before anything is written. Nothing partial is ever published.

Cancellation is checked by the SDK before the read, between reader chunks and
before each write, and by the processor every 64 KiB scanned during UTF-8
validation, the validating pass and the emitting pass. A cancelled job
publishes neither value nor artifact. The deadline is host-owned. Measured on
the reference machine: a 63 MiB document takes about 0.9 s to inspect, 1.4 s
to minify and 1.7 s to format; peak memory is roughly input + output plus one
map of member names per open object.

## Known compatibility gaps

- **Output cap.** `OutputSink.write` accepts one chunk per artifact and has no
  append, so the effective artifact cap is `maxChunkBytes` (1 MiB in the
  manifest), not `maxOutputBytes` (64 MiB). The processor rejects explicitly
  rather than truncating. Multi-chunk output needs an SDK change.
- **No diagnostics channel.** The v2 SDK has no processor diagnostic emitter,
  so positions travel inside the structured value (`inspect`) or on the thrown
  `JsonError` (`format`/`minify`), not as contract `Diagnostic` events.
- **Native validate.** The native host does not route `inspect` through this
  processor; the native path reports serde_json messages with its own
  line/column convention and does not report duplicate keys, unsafe integers or
  the BOM. Native `format`/`minify` output bytes match this processor.
- **Options.** DU-02 indentation choices (4 spaces, tab), permissive
  comments/trailing commas and JSONPath are not implemented; the manifest
  declares no options yet. Sorting keys is deliberately not offered because it
  would change duplicate-key semantics.
- **Memory.** The whole input and output are held in processor memory; the
  native core streams. This is acceptable for the SDK/headless reference.

## Running the package checks

From the repository root:

```text
node --experimental-strip-types --test plugins/json/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin structured.json --operation format --input 'input={"b":1.2300,"a":[12345678901234567890]}'
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin structured.json --operation minify --input 'input={ "a" : [ 1 , 2 ] }'
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin structured.json --operation inspect --input 'input={"a":1,"a":2}'
```

Fixtures live in `fixtures/`: `json-valid` (exact format/minify bytes, inspect
statistics, oracle flag), `json-invalid` (code, byte span, line/column and
message for every error class, with `inputHex` for byte-level cases),
`json-duplicate-keys` and `json-numbers`. `json-limits` and `json-cancellation`
are generated in `test.mjs` (depth 256/257, 300 KiB strings across reader
chunks, 40k-element arrays, input/output caps, diagnostic caps, cancellation
before reading, between chunks, during scanning and during emission).
