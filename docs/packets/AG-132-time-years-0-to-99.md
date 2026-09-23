# AG-132 — Dates in years 0 to 99 get correct calendar fields (DU-01)

## Branch

`antigravity/AG-132-time-years-0-to-99` from the latest `origin/main`. Record the base SHA.

## Allowed files

```text
plugins/time/**
```

## Required reading

The DU-01 card in `docs/DEVUTILS_REQUIREMENTS.md`; `docs/parity/DU-01.md`;
`plugins/time/README.md`; and `docs/WORKER_PROTOCOL.md`, including "Where an
expected value comes from".

## Goal

An independent review (finding AST-005, reproduced by the integrator) found:

```text
input         field        got         expected
0099-01-01    dayOfYear    -693959     1
0099-01-01    isoWeek      -99137      1  (it is a Thursday, so week 1 of 0099)
0000-02-29    (whole)      rejected    accepted: year 0 is a leap year in the proleptic Gregorian calendar
```

`Date.UTC(y, …)` maps a numeric year 0–99 to 1900–1999, while the input's own ISO
parse keeps the year as written. The two disagree for exactly these years. The review
traced it to `plugins/time/processor.mjs` near lines 124, 158 and 163 (at `5866a49`).

## Requirements

- Build every calendar anchor without the two-digit-year remapping (for example
  `new Date(0)` then `setUTCFullYear(y, m, d)`), everywhere the processor derives a
  field from a year.
- Year 0000 is valid; `0000-02-29` is a real date.
- Nothing changes for years 100 and later.

## Checks

```text
node --experimental-strip-types --test plugins/time/test.mjs
node scripts/test-plugins.mjs
pnpm --dir apps/desktop build
git diff --check
```

## Evidence

**The oracles are calendar invariants and the ISO 8601 week rule, not this package.**
January 1 is day 1 of its year. December 31 is day 365, or 366 in a leap year
(Gregorian rule: divisible by 4, except centuries not divisible by 400; year 0 is
divisible by 400). An ISO week is between 1 and 53, and week 1 contains the year's
first Thursday. Compute the expected ISO weeks with that rule in the test, not by
calling the processor.

Cover years 0, 1, 4, 99, 100, 400, 1900, 1970, 2000 and 9999, at January 1,
February 29 (where it exists), and December 31. Quote the table in your status.

## Out of scope

Local time and zones (issue #104), negative years, the shell.
