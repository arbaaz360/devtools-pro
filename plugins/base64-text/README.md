# Base64 Text

`encoding.base64-text` encodes the exact bytes of the `input` document as Base64 and decodes Base64 text back to bytes, labelling the result as UTF-8 text or as binary. It is a string tool (DU-06); the image codecs stay separate. The processor uses only the public plugin SDK (`ProcessorContext`): input is streamed with `readChunks`, cancellation is checked between chunks, and the complete result is written once to the `output` port together with a properties value.

## Options

| Option | Choices | Default | Meaning |
|---|---|---|---|
| `mode` | `encode`, `decode` | `encode` | Direction. |
| `variant` | `standard`, `url` | `standard` | Alphabet, see below. Decode accepts only the selected alphabet. |
| `padding` | `required`, `optional`, `omit` | `required` | Padding policy, see below. |
| `error-policy` | `strict`, `tolerant`, `replace` | `strict` | Whitespace, non-canonical bits and invalid UTF-8 handling. `errorPolicy` is accepted as an alias. |

Unknown choices fail with `invalid-option` naming the option and the allowed values.

## Alphabets (RFC 4648)

| Variant | Values 0–61 | 62 | 63 | Padding |
|---|---|---|---|---|
| `standard` (§4) | `A–Z a–z 0–9` | `+` | `/` | `=` |
| `url` (§5, "base64url") | `A–Z a–z 0–9` | `-` | `_` | `=` |

The two alphabets are never mixed or auto-detected. Decoding `-_8=` with `variant: standard` fails with `wrong-alphabet` and the message says which alphabet the character belongs to.

## Padding

| Policy | Encode | Decode |
|---|---|---|
| `required` | Pads with `=` to a multiple of 4 characters (canonical). | Input must be padded; `SGVsbG8` fails with `padding-missing`. |
| `optional` | Same output as `required`. | Padded and unpadded input are both accepted; padding, if present, must be complete. |
| `omit` | Never emits `=`; the last group has 2 or 3 characters. | `=` is rejected with `padding-forbidden`. |

Padding rules that hold under every policy:

- `=` may only end the input; data after padding is `data-after-padding`.
- Padding must complete a final group of 2 or 3 characters: `=` at the start, after a complete group, or after a single character is `padding-position`; a group missing padding characters is `padding-incomplete`; more than needed is `padding-excess`.
- A final group of one character can never be valid (`length`).

## Whitespace and canonical form (`error-policy`)

| Policy | ASCII whitespace (`\t \n \v \f \r` space) | Non-zero unused bits in the last character (e.g. `//==`) | Decoded bytes that are not valid UTF-8 |
|---|---|---|---|
| `strict` | Rejected: `whitespace` | Rejected: `trailing-bits` | Labelled binary (see below) |
| `tolerant` | Ignored anywhere, count reported in `whitespaceIgnored` | Accepted, bits discarded, `trailingBitsIgnored: true` | Labelled binary |
| `replace` | As tolerant | As tolerant | Decoded as text with U+FFFD substitution; `replacements` reports how many |

Every other byte is rejected: `invalid-character` for ASCII outside the alphabet, `not-ascii` for bytes ≥ 0x80 (with a hint when the input starts with a UTF-8 byte-order mark). Base64 text is ASCII by definition, so the decoder never re-decodes the input through a lossy text path.

## Diagnostics

Malformed input throws `Base64Error` with:

- `code` — one of `invalid-option`, `invalid-character`, `not-ascii`, `wrong-alphabet`, `whitespace`, `data-after-padding`, `padding-position`, `padding-incomplete`, `padding-excess`, `padding-forbidden`, `padding-missing`, `length`, `trailing-bits`, `output-limit`;
- `offset` (0-based byte offset), `line` and `column` (1-based, byte-counted) of the first offending byte, or of the end of input for end-of-input errors;
- a message that repeats the position and names the option that would accept the input when one exists.

The v2 SDK has no diagnostic emitter with source spans, so the error is surfaced as an execution failure; nothing is written to `output` when decoding fails.

## Output

`output` always carries the complete result as one artifact plus a properties value with `mode`, `variant`, `padding`, `errorPolicy`, `inputBytes`, `outputBytes` and `complete: true`.

| Case | Artifact bytes | Value |
|---|---|---|
| Encode | The Base64 text (ASCII) | `contentKind: "text"`, `mime: "text/plain; charset=us-ascii"`, `text`, `padded` |
| Decode, valid UTF-8 | The decoded bytes | `contentKind: "text"`, `mime: "text/plain; charset=utf-8"`, `utf8: true`, `text`, `decodedBytes` |
| Decode, not UTF-8, `strict`/`tolerant` | The decoded bytes, untouched | `contentKind: "binary"`, `mime: "application/octet-stream"`, `utf8: false`, `text: null`, `hexPreview` (first 32 bytes) |
| Decode, not UTF-8, `replace` | UTF-8 of the replaced text (lossy by request) | `contentKind: "text"`, `utf8: false`, `replacements`, `decodedBytes` (raw size) |

Decode values also report `significantCharacters`, `paddingCharacters`, `whitespaceIgnored` and `trailingBitsIgnored`. A leading U+FEFF is kept in `text` and in the bytes; nothing is stripped or normalised.

Source bytes are immutable: encode reads the input bytes as they are (invalid UTF-8, CRLF, BOM and NUL included) and the package tests assert the reader's bytes are unchanged after every run.

## Limits

| Limit | Manifest | Behaviour |
|---|---|---|
| `maxInputBytes` | 2 MiB | Enforced by the SDK reader before any output exists. |
| `maxOutputBytes` | 1 MiB | The output cap is `min(maxOutputBytes, maxChunkBytes)` of the limits the host injects. |
| `maxChunkBytes` | 1 MiB | The v2 sink accepts one write per port and caps that write at `maxChunkBytes`; the output is therefore never split. |
| `deadlineMs` | 1000 | Owned by the host scheduler; the processor checks cancellation between 64 KiB read chunks. |

With these limits encode accepts up to 786,432 input bytes (exactly 1 MiB of Base64) and decode accepts Base64 whose decoded size is at most 1 MiB. When the reader exposes the input size the check happens before reading; otherwise it happens as soon as the running output would cross the cap. Either way the failure is `output-limit` with `needed` and `limit` in bytes, and no partial artifact is written. The SDK's own defaults (16 MiB input, 16 MiB output, 1 MiB chunk) give the same 1 MiB output cap, which is why the manifest states 1 MiB instead of claiming an unreachable 16 MiB.

## Checks

From the repository root:

```text
node --experimental-strip-types --test plugins/base64-text/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin encoding.base64-text --input "input=hello"
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin encoding.base64-text --input "input=-_8" --options '{"mode":"decode","variant":"url","padding":"omit"}'
```

The suite covers UTF-8 ASCII, Unicode, empty, LF and CRLF multiline, NUL, one/two/three-byte tails, a preserved BOM, all 256 byte values, invalid UTF-8 payloads, both alphabets, every padding policy in both directions, whitespace under each error policy, twenty malformed-input diagnostics with positions, canonical-bit handling, binary labelling and replacement, chunk-boundary carries, readers without a size probe, cooperative cancellation, a 768 KiB round trip checked against Node's encoder, and the output, chunk and input limits. Fixtures live in `fixtures/base64-roundtrip.json`, `fixtures/base64-variants.json` and `fixtures/base64-errors.json`.

## Not covered

- The processor is not yet wired into the native executor; the desktop shell still runs its own Base64 image codecs. The headless runner and the package tests are the current proof.
- No MIME (RFC 2045) line wrapping on encode; wrapped input decodes under the tolerant policy.
