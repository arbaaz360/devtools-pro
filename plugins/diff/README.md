# Text Diff plugin

`text.compare` compares two required named text inputs, `left` and `right`,
using a deterministic line-oriented longest-common-subsequence diff. The
processor returns a complete structured value on the `output` port:

- `complete` is always `true` for a successful result.
- `summary` reports identity, newline-only changes, byte and line counts, and
  added/removed/hunk counts.
- `hunks` contains renderer-friendly ranges. Each line has `kind` (`context`,
  `added`, or `removed`), text including its newline delimiter, and old/new
  line numbers (`null` on the side where it does not exist).
- `provenance` records the operation, newline policy, context size, and input
  names.

The `newline` option is `preserve` (default), `lf`, `crlf`, or `ignore`.
`lf`/`crlf` normalize both inputs before comparing; `ignore` uses LF for
comparison. `contextLines` defaults to 3 and is capped at 64.

Inputs are read through the SDK's named, bounded reader and `readChunks`, so
input limits and cooperative cancellation are enforced before diffing. The
LCS matrix is capped at four million cells and line count defaults to 100,000.
An output larger than the injected SDK output limit is rejected explicitly;
the complete structured value is never silently truncated.

The package uses only `@devtools/plugin-sdk` public APIs. The current SDK
headless runner accepts one `--input` value and therefore cannot exercise two
named inputs from its command line. Package tests construct both named reader
ports directly; the host runner must supply `left` and `right` when its
multi-input invocation support is available.
