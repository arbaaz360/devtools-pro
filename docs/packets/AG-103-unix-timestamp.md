# AG-103 — Unix timestamp converter package (DU-01)

## Branch

`antigravity/AG-103-unix-timestamp` from the latest `origin/main`. Record the
base SHA.

## Allowed files

```text
plugins/time/**
```

## Required reading

`ARCHITECTURE.md`, `Tool Contract and Document Model.md`,
`packages/plugin-sdk/README.md`, the DU-01 card in
`docs/DEVUTILS_REQUIREMENTS.md`, and two reference packages:
`plugins/base64-text/` for layout and fixtures, `plugins/uuid/` for a package
that reads `context.clock` and pins headless output in fixtures.

## Goal

A new package `plugins/time/` with plugin id `time.unix` that interprets one
timestamp or date and reports every representation DU-01 asks for, with a
bounded arithmetic grammar and a captured clock.

## Requirements

- Package files as in the reference packages; `tests.requirementIds: ["DU-01"]`.
- One operation `time.unix`. Input port `input`, kind `document`, text, `required: false`;
  empty input means "now", taken only from `context.clock.now()`.
- Options: `interpretation` enum `auto`, `seconds`, `milliseconds`, `iso`
  (default `auto`); `milliseconds-from-digits` integer, default `12`: in `auto`,
  a numeric input with at least that many digits is milliseconds, fewer is
  seconds. Explicit interpretations override the heuristic.
- Accepted input, and the README lists exactly these: an integer or decimal
  number of seconds or milliseconds (negative allowed); an ISO 8601 date or
  date-time with `Z` or a numeric offset; an arithmetic expression over numeric
  timestamps with `+ - * /`, decimal numbers and one level of parentheses,
  evaluated with normal precedence. Nothing else parses: no words, no locale
  dates, no function calls. Ambiguous forms such as `01/02/2024` are rejected
  with a message naming the ISO form.
- Output port `output`, kind `value`, representations `["properties", "text"]`:
  `epochSeconds`, `epochMilliseconds`, `isoUtc`, `dateUtc`, `timeUtc`,
  `weekday`, `dayOfYear`, `isoWeek`, `leapYear`, `relative` (a phrase such as
  `3 days ago` computed against `context.clock.now()`), `interpretation`
  (which rule applied), and `expression` when arithmetic was evaluated. The
  text representation lists the rows one per line as `label: value`, so each
  row is copyable.
- Range: values outside ±8,640,000,000,000,000 ms (the ECMAScript date range)
  are rejected with the bound in the message. Division by zero, unbalanced
  parentheses and non-finite results are structured errors. Nothing is written
  on error.
- Fixtures: epoch zero, negative timestamps, millisecond precision (`1700000000123`),
  the leap day `2024-02-29`, `2023-02-29` rejected, offsets `+05:30` and `-08:00`,
  the boundary of the digit heuristic on both sides, explicit unit overriding a
  short number, arithmetic (`1700000000 + 86400 * 7`, `(1 + 2) * 3`), invalid
  arithmetic, and out-of-range values. Relative-time fixtures use a
  `FixedClock`.
- Limits: `maxInputBytes` 4 KiB. Source bytes immutable, asserted per test.

## Checks

```text
node --experimental-strip-types --test plugins/time/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin time.unix --input "input=1700000000"
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin time.unix --input "input=2024-02-29T12:00:00+05:30"
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin time.unix --input "input=1700000000 + 86400 * 7"
cargo run -p devtools-plugin-discovery -- generate plugins <scratch dir>
git diff --check
```

## Evidence

Test counts; the three headless outputs; the discovery generate result.

## Out of scope

Local-timezone rendering (the shell's job), a ticking relative time, the
auto-detection range editor, and the linked-fields view.
