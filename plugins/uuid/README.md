# UUID generator and decoder

`identity.uuid` is the DU-10 no-input generator proof. It uses only the public
`ProcessorContext` boundary: options come from `request.options`, the optional
`uuid` input port is read through `context.read`, v1/v4 entropy comes from the
injected clock and randomness services, and every result is written as one
complete newline-delimited text artifact plus one structured value on the
`uuid` output port. The operation never selects paths, never touches the shell
and never mutates its input.

## Mode selection

| Situation | Behaviour |
|---|---|
| `uuid` input port carries non-blank text | Decode that text, whatever `mode` says (detection) |
| `mode: "decode"` and the port is absent or blank | Decode the `uuid` option; empty or missing → `decode mode requires a UUID input` |
| `mode: "generate"` or omitted, port absent or blank | Generate |
| Any other `mode` | `mode must be generate or decode`, checked before the input is read |

`case` (`lower` default, `upper`) is validated in both modes and only changes
hexadecimal presentation (`uuid`, `hexadecimal`, `node`). Bytes never change.

## Generate

Options: `version` (`v1`, `v3`, `v4`, `v5`; `1`/`3`/`4`/`5` and integers are
accepted, default `v4`), `count` (integer or decimal string, 1–100, default 1),
`namespace` and `name` (v3/v5 only). Decode-only inputs are ignored.

| Version | Source of bytes | Determinism |
|---|---|---|
| v4 | 16 bytes from `context.randomness.fill`, then version/variant bits are forced | Same seed → same batch |
| v1 | `context.clock.now()` parsed as ISO 8601 → 100-ns ticks since 1582-10-15; then **8 randomness bytes per batch**: clock sequence (variant forced) and node (multicast bit forced, RFC 4122 §4.5). Value *i* of the batch uses `ticks + i`, so one batch is sortable and shares clock sequence and node | Same clock and seed → same batch |
| v3 / v5 | MD5 / SHA-1 over the 16 namespace bytes followed by the UTF-8 name, RFC 4122 §4.3 | Always; clock and randomness are not consulted |

Namespace presets `dns`, `url`, `oid`, `x500` (case-insensitive, surrounding
whitespace ignored) map to the RFC 4122 Appendix C UUIDs; any canonical UUID is
accepted as a custom namespace. The default namespace is `dns`. The name must
be a non-empty string whose UTF-8 length does not exceed
`context.limits.maxInputBytes`. There is no `random` namespace preset: a host
that wants one supplies a v4 UUID as a custom namespace.

v1 rejects clocks that are not ISO 8601 strings and clocks outside the 60-bit
range (before `1582-10-15T00:00:00Z` or after `5236-03-31T21:21:00.684Z`,
including a batch whose last tick would overflow).

The text artifact is every UUID in order, each followed by `\n`; the largest
batch (100 × 37 bytes) stays inside the declared `maxOutputBytes`. The value is:

```json
{"mode":"generate","version":4,"count":2,"case":"lower","randomness":"seed:1",
 "uuids":[{"uuid":"…","version":4,"variant":"RFC 4122","bytes":[16 numbers],"hexadecimal":"32 hex"}],
 "complete":true}
```

v1 adds `clock` (the ISO string the clock returned) at the top level and the
time fields below on every item; v3/v5 add the resolved canonical `namespace`
and the echoed `name` instead of `randomness`.

## Decode

Only the canonical 36-character form `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
(either case) is accepted; braces, `urn:uuid:` prefixes, undashed hex, interior
whitespace and multiple values are rejected with `UUID must be canonical …`.
Surrounding whitespace on the input port is ignored but kept in `source`.

```json
{"mode":"decode","origin":"input","source":"  550E8400-…\n","case":"lower",
 "uuid":"550e8400-e29b-41d4-a716-446655440000","version":4,"variant":"RFC 4122",
 "bytes":[…],"hexadecimal":"550e8400e29b41d4a716446655440000","complete":true}
```

- `origin` is `input` (port) or `option` (`uuid` option); the port wins when both exist.
- `version` is the high nibble of byte 6, reported for every variant (0–15).
- `variant` follows byte 8: `NCS` (`0xxx`), `RFC 4122` (`10xx`), `Microsoft` (`110x`), `future` (`111x`).
- Time fields are emitted only for `version === 1` **and** variant `RFC 4122`:
  `timestamp` (ISO 8601 UTC with all seven fractional digits, floor-divided so
  pre-1970 values are exact), `ticks` (decimal string of the 60-bit count),
  `clockSequence` (14 bits), `node` (six colon-separated octets) and
  `multicast` (least significant bit of the first node octet).

The text artifact is the canonical UUID in the requested case plus `\n`.

## Limits and cancellation

Input, output and chunk limits are the injected `context.limits`; the SDK
raises `read of uuid exceeds …`, `output exceeds limit` or `output chunk
exceeds limit` and nothing is written when a limit fails because the text
artifact is written before the value. Cancellation is checked before the run,
before every generated value and inside every SDK write; a cancelled run throws
`ProcessorCancelled` and leaves no value; a text artifact already written
before the cancelled write belongs to a failed run and is discarded by the host.

## Fixtures

| File | Covers |
|---|---|
| `fixtures/vectors.json` | v3/v5 for DNS, URL, OID, X500 and a custom namespace, checked against RFC 9562 A.3/A.4, RFC 4122 Appendix B (errata 1352), the Python `uuid` documentation and Python-computed values, including a Unicode name |
| `fixtures/deterministic.json` | v1/v4 text and properties for seed 42 / `2025-01-01T00:00:00.000Z` and the headless runner's seed 1 / `2025-01-01T00:00:00Z` |
| `fixtures/decode.json` | v1 time fields, uppercase input with preserved `source`, nil, max, Microsoft and NCS variants, option-origin decode, earliest, pre-epoch and maximum v1 timestamps |
| `fixtures/invalid.json` | malformed UUIDs, missing or blank decode input, unsupported modes, invalid case, versions, names, namespaces and counts |

`test.mjs` also derives the v1/v4 bytes independently from `SeededRandom` and
`FixedClock`, checks batch sizes 1–100 and both cases, verifies the manifest
bounds and defaults against the processor, and exercises limits and
cancellation with test doubles.

Run from the repository root:

```text
node plugins/uuid/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin identity.uuid --options '{"version":"v1","count":2}'
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin identity.uuid --options '{"mode":"decode"}' --input 6ba7b810-9dad-11d1-80b4-00c04fd430c8
```

The headless runner discovers a `plugins/` root, so it takes `plugins` plus
`--plugin identity.uuid`, not the package directory.
