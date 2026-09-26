# AG-137 — The Unix timestamp converter reads RFC 5322 and HTTP dates (DU-01)

## Branch

`antigravity/AG-137-rfc-dates` from the latest `origin/main`. Record the base SHA.

## Allowed files

```text
plugins/time/**
```

## Required reading

The DU-01 card in `docs/DEVUTILS_REQUIREMENTS.md` ("documented common-date parsing");
`docs/parity/DU-01.md`, row 4 (the one gap left); `plugins/time/README.md`;
`plugins/time/processor.mjs`; and `docs/WORKER_PROTOCOL.md`, including "Where an
expected value comes from". AG-132 and AG-134 changed this package recently, so read
their tests before adding yours.

## Goal

The tool reads only ISO 8601 and numbers. The DU-01 audit's last gap is "no
common-date parsing": `Tue, 14 Nov 2023 22:13:20 GMT`, the format of every e-mail and
HTTP header, is rejected today. Add the four date formats those standards define, and
nothing looser: guessing at `01/02/2024` stays refused.

## Requirements

- **Four new forms**, recognised under `interpretation: auto` and under a new choice
  `interpretation: rfc`, which accepts only these forms:
  1. **RFC 5322 date-time** (§3.3):
     - optional day-of-week and comma; day of month with 1 or 2 digits; month name;
       year; `hh:mm`, with optional `:ss`;
     - the zone is `+hhmm`/`-hhmm`, or one of the obsolete names `UT`, `GMT`, `EST`,
       `EDT`, `CST`, `CDT`, `MST`, `MDT`, `PST`, `PDT` (§4.3).
  2. **IMF-fixdate** (RFC 9110 §5.6.7): `Sun, 06 Nov 1994 08:49:37 GMT`.
  3. **RFC 850 date:** `Sunday, 06-Nov-94 08:49:37 GMT`.
  4. **asctime:** `Sun Nov  6 08:49:37 1994`, read as UTC. Note the two spaces before a
     one-digit day.
- **Names** (days, months, zones) match case-insensitively, as ABNF literals do
  (RFC 5234).
- **Years:**
  - a four-digit year is taken literally: `0099` is the year 99 (see AG-132);
  - a two-digit year in an RFC 5322 date follows §4.3: 00–49 → 2000–2049, 50–99 →
    1950–1999; a three-digit year gets 1900 added;
  - an RFC 850 two-digit year follows RFC 9110 §5.6.7: a year more than 50 years
    ahead of `context.clock.now()` is the most recent past year with those digits.
- **Refused**, each a structured error whose message says why:
  - a day-of-week that is not the date's own (`weekday-mismatch`, naming the real
    day; RFC 5322 §3.3: it MUST match);
  - single-letter military zones, including `Z` (`obsolete-zone`; RFC 5322 §4.3 calls
    them ambiguous);
  - an impossible date or time: 29 Feb in a common year, hour 24, minute 60
    (`invalid-date`);
  - second 60 (`leap-second`: Unix time cannot represent one).
- **The result** reports `interpretation` as `rfc5322`, `imf-fixdate`, `rfc850` or
  `asctime`, and every existing output field, `local` included, as for any other
  input.
- `README.md` lists the accepted forms with an example each, and the refusals.

## Checks

```text
node --experimental-strip-types --test plugins/time/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin time.unix --input "input=Tue, 14 Nov 2023 22:13:20 GMT"
node scripts/test-plugins.mjs
pnpm --dir apps/desktop build
git diff --check
```

## Evidence

**The expected instants come from the RFCs' own examples and from Python's
`email.utils`, not from this package.**

- **Examples to include, with hand-written expectations:**
  - RFC 5322 Appendix A.1.1: `Fri, 21 Nov 1997 09:55:06 -0600` is epoch 880127706;
  - RFC 9110 §5.6.7's three spellings of 784111777 (6 Nov 1994 08:49:37 GMT).
- **Python,** through a committed generator `plugins/time/fixtures/generate_rfc_dates.py`
  (`py -3`): `email.utils.parsedate_to_datetime` gives the epoch for the well-formed
  cases. The integrator checked these:

  | Input | Epoch |
  |---|---|
  | `Tue, 14 Nov 2023 22:13:20 +0000` | 1700000000 |
  | `Tue, 14 Nov 2023 22:13:20 GMT` | 1700000000 |
  | `14 Nov 2023 22:13:20 -0500` | 1700018000 |
  | `Tue, 14 Nov 2023 22:13 +0530` | 1699980180 |
  | `Tuesday, 14-Nov-23 22:13:20 GMT` | 1700000000 |
  | `Tue, 14 Nov 2023 17:13:20 EST` | 1700000000 |
  | `Tue, 14 Nov 2023 14:13:20 PST` | 1700000000 |

- **Where Python is not the oracle.** Python differs from the RFCs in three places, so
  these expectations are hand-written from the RFC text, with a comment citing the
  section:
  - it reads the year `0099` as 1999;
  - it accepts a wrong weekday (`Mon, 14 Nov 2023`);
  - it accepts `Z`.

Quote the table of cases and the headless output in your status.

## Out of scope

Locale dates, relative dates ("yesterday"), time zones other than those listed,
formatting output in these forms, and the shell.
