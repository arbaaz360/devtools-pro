# AG-135 — Hex ↔ text converter (new package)

## Branch

`antigravity/AG-135-hex-text` from the latest `origin/main`. Record the base SHA.

## Allowed files

```text
plugins/hex/**
```

## Required reading

`ARCHITECTURE.md`; `packages/plugin-sdk/README.md`; `docs/WORKER_PROTOCOL.md`,
including "Where an expected value comes from"; and **`plugins/base64-text/`** in full.
It is the reference for this package: the same shape (one tool, a `mode` option, the
input's exact bytes in, text or bytes out) and the same way of labelling decoded bytes
that are not UTF-8.

## Goal

A new package `plugins/hex/`, plugin id `encoding.hex`, that turns text (its exact
bytes) into hexadecimal and hexadecimal back into bytes. It is in the target catalogue
("hex ↔ ASCII", `docs/PARITY_AND_BUILDING_BLOCKS.md`) and not yet built.

## Requirements

- **Package files as in `plugins/base64-text/`:** `manifest.json`, `plugin.json`,
  `processor.mjs`, `test.mjs`, `README.md`, `fixtures/`. The manifest's
  `tests.requirementIds` is `[]`. This is not one of the 27 DevUtils cards, and the
  contract only accepts `DU-01`…`DU-27` there.
- **The tool:** one tool `encoding.hex`, title `Hex ↔ Text`, category `converter`, and
  one operation `encoding.hex`.
  - Input and output ports, trigger modes and debounce exactly as base64-text's.
  - Limits: `maxInputBytes` 2097152, `maxOutputBytes` 8388608, `maxChunkBytes`
    8388608, `deadlineMs` 1000.
- **Options:** kebab-case ids, camelCase aliases accepted, and a structured error for
  unknown keys and wrong types.
  - `mode`: `encode` | `decode`, default `encode`.
  - `case`: `lower` | `upper`, default `lower`. Encode only.
  - `separator`: `none` | `space` | `colon`, default `none`. Encode only.
  - `bytes-per-line`: integer 0–256, default `0` (one line). Encode only.
- **Encode** writes the input's **exact bytes**. A BOM, CRLF, NUL and invalid UTF-8 are
  all encoded as they are, never re-encoded through text.
- **Decode** accepts:
  - hex digits in either case;
  - ASCII whitespace, `:`, `-` or `,` between bytes;
  - `0x`/`0X` before each byte or once before a run;
  - `\x` before each byte (`\x48\x69`).

  Each run of digits between separators must have an even length. Anything else is a
  structured error carrying the **0-based character offset** of the first offending
  character:
  - `hex.invalid-character` for a character outside the forms above;
  - `hex.odd-length` for a run with an odd number of digits, at the run's start.
- **Decoded bytes** are labelled exactly as base64-text labels them:
  - valid UTF-8: text, with properties `utf8: true` and `text`;
  - otherwise: binary (`application/octet-stream`), `utf8: false`, and the bytes
    untouched.
- **Properties:**
  - encode: `bytes` (input bytes), `characters` (output length), `case`,
    `separator`;
  - decode: `bytes` (decoded), `utf8`, `contentKind`.
- **Round trip:** decoding what encode wrote returns the input bytes, for all 256 byte
  values.
- **Plumbing:** cancellation is checked between chunks; source bytes stay immutable
  (assert it, as base64-text's tests do); an over-limit result fails explicitly.
- `README.md` documents the options, the accepted decode forms and every error code.

## Checks

```text
node --experimental-strip-types --test plugins/hex/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin encoding.hex --input "input=Hi"
node scripts/test-plugins.mjs
pnpm --dir apps/desktop build
git diff --check
```

## Evidence

**The expected values come from Python, not from this package.** Commit a generator,
`plugins/hex/fixtures/generate.py`, run with `py -3`. It writes the fixture JSON the
tests read, using only Python's own `bytes.hex(sep)`, `str.upper()` and
`bytes.fromhex()`:

- `fromhex` accepts whitespace between bytes only;
- for the other accepted separators, strip them in the generator and say so in a
  comment.

The test reads that JSON and never computes an expectation with the package.

Cover:
- empty input; ASCII; UTF-8 with 2-, 3- and 4-byte characters (`é`, `€`, an emoji);
- CRLF plus a BOM, encoded as their bytes;
- all 256 byte values (encode, then decode back);
- every `case` × `separator` combination, and `bytes-per-line` 1, 16 and 0;
- decode of every accepted form;
- each error code with its offset: an odd run in the middle and at the end, and a
  non-hex letter;
- non-UTF-8 bytes (`ff fe 00`) decoded and labelled binary;
- a 1 MiB round trip inside the deadline.

Quote the fixture counts and the headless output in your status.

## Out of scope

Hex-dump views (offsets plus an ASCII column), other bases (the number base converter
has them), and the shell.
