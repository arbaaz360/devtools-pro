# Hash Generator

`encoding.hash` streams the named `input` document through six digest algorithms in one pass and emits all results together: MD5, SHA-1, SHA-224, SHA-256, SHA-384 and SHA-512. Each output port carries a copyable hexadecimal text artifact and a properties value with exactly these fields: `algorithm`, `digest`, `case`, `source` (the input port), `inputBytes`, `encoding` (`hex`) and `complete: true`.

## Bytes in, bytes hashed

The processor forwards every chunk to every hasher unchanged. There is no decoding, trimming, newline normalization or Unicode normalization: NUL bytes, invalid UTF-8, a byte order mark, CRLF versus LF and NFC versus NFD all produce different digests, and `inputBytes` counts UTF-8 bytes, not characters. `fixtures/bytes.json` pins these cases with hex-encoded inputs so JSON cannot alter them.

Input is consumed through the SDK `ProcessorContext.readChunks("input")` API, so a host range reader is never asked for more than `maxChunkBytes` at a time and the whole document is never materialized in the processor. The test suite streams the full declared limit (64 MiB in 1 MiB chunks) and asserts that live ArrayBuffer memory stays under four chunks. Outputs are emitted only after the whole input has been read, so a cancelled job never publishes partial digests.

## Options and diagnostics

`case` is the only option: `lower` (default) or `upper`. It changes hexadecimal presentation only; the bytes hashed, `inputBytes` and every other field are identical between the two. Invalid requests fail before any input is read, with a diagnostic that names the problem:

| Request | Diagnostic |
| --- | --- |
| `{"case":"mixed"}` | `case must be "lower" or "upper", received "mixed"` |
| `{"Case":"upper"}` | `unknown option "Case"; encoding.hash accepts only "case"` |
| options `[]` or `"upper"` | `options must be a JSON object, received ...` |
| `operationId: "encoding.md4"` | `unsupported operation "encoding.md4"; this package provides only "encoding.hash"` |
| missing `input` port | `encoding.hash requires the named input port "input"` |
| 17 bytes with a 16-byte limit | `input is 17 bytes, which exceeds the 16-byte limit declared for encoding.hash; no digest was produced` |

Oversized input is rejected before any byte is read when the reader reports its size. For a size-less stream the SDK stops requesting bytes once the limit is reached and would otherwise report a truncated digest as complete; the processor probes one byte past the limit and rejects the stream instead. Cancellation is reported as the SDK `ProcessorCancelled` error, never as a diagnostic.

## Why MD2 and MD4 are not included

The DevUtils reference (DU-23) lists eight algorithms. This package ships six because the bundled runtime cannot compute the other two: Node's `crypto` on OpenSSL 3 has no MD2 digest at all (`getHashes()` does not list it; `createHash("md2")` throws `Digest method not supported`), and MD4 lives only in the OpenSSL legacy provider, so `createHash("md4")` throws `ERR_OSSL_EVP_UNSUPPORTED` unless the process is started with `--openssl-legacy-provider`, which the desktop host does not do. Shipping a JavaScript reimplementation would add an unverified digest to a checksum tool, and shipping an output port that never produces a value would be a placeholder. `test.mjs` asserts both facts about the runtime so the omission is revisited if the runtime changes. Adding them later means a verified implementation plus published vectors (RFC 1319 for MD2, RFC 1320 for MD4), not a manifest edit.

## Verification

`fixtures/vectors.json` holds published vectors with their sources: RFC 1321 Appendix A.5 for MD5, RFC 3174 section 7.3 for SHA-1 and RFC 6234 section 8.5 / FIPS 180-4 for the SHA-2 family, including the empty message, `abc`, the 56- and 112-byte two-block messages, the 640-byte ten-block message and one million `a` bytes. Every vector is also re-run through prime-sized chunks that never align with a block boundary.

```text
node plugins/hash/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin encoding.hash --operation encoding.hash --input "input=abc" --options '{"case":"upper"}'
```

These legacy hashes are compatibility/checksum tools and should not be used for password storage or secure signatures.
