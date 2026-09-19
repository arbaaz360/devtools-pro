# AG-104 — Number base converter package (DU-19)

## Branch

`antigravity/AG-104-number-base` from the latest `origin/main`. Record the base
SHA.

## Allowed files

```text
plugins/number-base/**
```

## Required reading

`ARCHITECTURE.md`, `Tool Contract and Document Model.md`,
`packages/plugin-sdk/README.md`, the DU-19 card in
`docs/DEVUTILS_REQUIREMENTS.md`, and `plugins/base64-text/` as the reference
package for layout, README and fixtures.

## Goal

A new package `plugins/number-base/` with plugin id `number.base` that converts
one exact integer between bases 2 to 36 with arbitrary precision and reports
the standard bases alongside the requested one.

## Requirements

- Package files as in the reference package; `tests.requirementIds: ["DU-19"]`.
- One operation `number.base`. Input port `input`, kind `document`, text: one
  integer literal. Surrounding whitespace is ignored; anything else on the line,
  or a second line with content, is an error naming the offending offset.
- Options: `from-base` integer 2–36 (default `10`); `to-base` integer 2–36
  (default `16`); `digits` enum `lower`, `upper` (default `lower`). Kebab-case
  ids with camelCase aliases accepted.
- Grammar, stated in the README: optional `-`; an optional prefix `0b`, `0o`,
  `0x` that must agree with `from-base` (a mismatch is an error, not a
  reinterpretation); one or more digits valid for `from-base`, case-insensitive.
  No separators, no fraction, no exponent: each is rejected with a structured
  error that names the character and its offset.
- Arithmetic uses `BigInt` only. Zero converts to `0` in every base. Negative
  values keep a leading `-`. No floating point anywhere in the processor.
- Output port `output`, kind `value`, representations `["properties", "text"]`:
  `result` (the requested base), `binary`, `octal`, `decimal`, `hexadecimal`,
  `fromBase`, `toBase`, `digits` (count of digits in the result), `negative`.
  The text representation is the `result` alone, so it is copyable as is.
- Limits: `maxInputBytes` 64 KiB (about 64,000 digits). Output bounded by the
  manifest limit; a result that would exceed it is rejected before writing.
  Cancellation is polled at least once during conversion of large inputs.
- Fixtures: `2^53 + 1` (`9007199254740993`) round-trips exactly; `2^128` and a
  300-digit decimal; negatives; zero; base 36 `zz`; base 2 with `0b` prefix;
  `0x` with `from-base: 10` rejected; digit `9` in base 8 rejected with its
  offset; fractions and separators rejected; `from-base` 1 and 37 rejected;
  upper and lower digit rendering. Source bytes immutable, asserted per test.

## Checks

```text
node --experimental-strip-types --test plugins/number-base/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin number.base --input "input=9007199254740993" --options '{"to-base":2}'
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin number.base --input "input=-0xFF" --options '{"from-base":16,"to-base":36}'
cargo run -p devtools-plugin-discovery -- generate plugins <scratch dir>
git diff --check
```

## Evidence

Test counts; the two headless outputs; the discovery generate result.

## Out of scope

The linked-fields workspace where editing any field updates the others; that
needs the shell. Fractional values.
