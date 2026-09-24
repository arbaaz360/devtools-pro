# AG-134 — The Unix timestamp converter shows local time (DU-01, issue #104)

## Branch

`claude/AG-134-local-time` from the latest `origin/main`. Record the base SHA.

## Allowed files

```text
packages/plugin-sdk/src/context.ts
packages/plugin-sdk/src/context.test.ts
packages/plugin-sdk/scripts/headless.ts
packages/plugin-sdk/README.md
apps/desktop/src/plugins/engine.worker.ts
plugins/time/**
scripts/native/checks.mjs
docs/MANUAL_TEST_PLAN.md
```

## Required reading

The DU-01 card in `docs/DEVUTILS_REQUIREMENTS.md` ("local and UTC/ISO
representations"); issue #104; `docs/parity/DU-01.md`; `plugins/time/README.md`;
`packages/plugin-sdk/README.md`; and `docs/WORKER_PROTOCOL.md`, including "Where an
expected value comes from".

## Goal

The DU-01 card asks for local time. The tool cannot show it, because the SDK's clock
reports an instant and no zone:

```ts
export interface Clock { now(): string; }            // packages/plugin-sdk/src/context.ts
```

A processor that reached for `Date`'s local methods would read the host's zone, and
its tests would then depend on the machine that runs them. So AG-125 correctly
reported the limit instead of working around it (#104). The plan's TL-TIME-02 says
"local time also shown", and today that is not true.

## Requirements

- **The clock gains a zone.** `Clock` becomes
  `{ now(): string; timeZone(): string }`, where `timeZone()` returns an IANA name
  (`"Asia/Kolkata"`). `FixedClock` takes it as an optional second argument, defaulting
  to `"UTC"`, so existing tests keep their meaning. `now()` is unchanged.
- **The desktop worker gives the machine's zone:**
  `timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone` in
  `engine.worker.ts`. The headless runner takes `--time-zone <IANA>`, default `UTC`.
- **`time.unix` adds three outputs**, computed from the instant and
  `context.clock.timeZone()` only:
  - `timeZone`: the zone's name;
  - `utcOffset`: `+05:30` or `-04:00`, with seconds when the offset has them
    (`+05:53:28`, local mean time before 1854);
  - `local`: the local date-time in ISO 8601 with that offset and milliseconds,
    `2023-11-15T03:43:20.000+05:30`. UTC is written `+00:00`, not `Z`.
- **Never the host's zone.** Use `Intl.DateTimeFormat` with an explicit `timeZone`
  (`formatToParts`), never `getHours`, `getTimezoneOffset` or `toLocale*String` without
  a zone. A test run on any machine must give the same values.
- Years 0000–9999 are right, including 0–99 (see AG-132). `Intl` reports years before
  1 CE with `era: "BC"`; year 0 is 1 BC.
- An unknown zone name (possible only through the headless runner) is an error that
  names it, not a silent UTC.
- `plugins/time/README.md` documents the three outputs and where the zone comes from.

## Checks

```text
node --experimental-strip-types --test packages/plugin-sdk/src/context.test.ts
node --experimental-strip-types --test plugins/time/test.mjs
node scripts/test-plugins.mjs
pnpm --dir apps/desktop build
node scripts/check-plan-coverage.mjs
git diff --check
```

and, on Windows with a debug build:
`node scripts/native-suite.mjs --only TL-TIME` (see Evidence).

## Evidence

**The zone rules come from the tz database, not from this package.** Each expected
value below was computed by the integrator twice, with Node's ICU and with Windows'
own zone data (`[TimeZoneInfo]::ConvertTime`), and the two agree. Put them in the test
as written. Do not recompute them with the code under test.

| Zone | Instant (UTC) | `local` |
|---|---|---|
| America/New_York | 2024-03-10T06:59:59.999Z | 2024-03-10T01:59:59.999-05:00 |
| America/New_York | 2024-03-10T07:00:00.000Z | 2024-03-10T03:00:00.000-04:00 (DST starts) |
| America/New_York | 2024-11-03T05:59:59.000Z | 2024-11-03T01:59:59.000-04:00 |
| America/New_York | 2024-11-03T06:00:00.000Z | 2024-11-03T01:00:00.000-05:00 (DST ends; 01:xx again) |
| Europe/London | 2024-03-31T00:59:59.000Z | 2024-03-31T00:59:59.000+00:00 |
| Europe/London | 2024-03-31T01:00:00.000Z | 2024-03-31T02:00:00.000+01:00 |
| Asia/Kolkata | 2023-11-14T22:13:20.000Z | 2023-11-15T03:43:20.000+05:30 (the day changes) |
| Asia/Kathmandu | 2023-11-14T22:13:20.000Z | 2023-11-15T03:58:20.000+05:45 |
| Australia/Lord_Howe | 2024-10-05T15:29:59.000Z | 2024-10-06T01:59:59.000+10:30 |
| Australia/Lord_Howe | 2024-10-05T15:30:00.000Z | 2024-10-06T02:30:00.000+11:00 (a half-hour DST jump) |
| Pacific/Chatham | 2024-01-15T00:00:00.000Z | 2024-01-15T13:45:00.000+13:45 |
| Pacific/Chatham | 2024-07-15T00:00:00.000Z | 2024-07-15T12:45:00.000+12:45 |
| UTC | 0099-01-01T00:00:00.000Z | 0099-01-01T00:00:00.000+00:00 |
| Asia/Kolkata | 1800-01-01T00:00:00.000Z | 1800-01-01T05:53:28.000+05:53:28 (local mean time) |

Add a native check **TL-TIME-08 (suite)** and its plan row. Run the tool on
`1700000000` in the real window, and compare the displayed `utcOffset` and `local` with
what Windows says for that instant. Get Windows' answer from PowerShell:
`[TimeZoneInfo]::ConvertTime([DateTimeOffset]::FromUnixTimeSeconds(1700000000), [TimeZoneInfo]::Local)`,
formatted `yyyy-MM-ddTHH:mm:ss.fffzzz`. That is Windows' zone data, independent of
WebView2's ICU. Note that Windows zone ids are not IANA names, so compare the offset
and the date-time, not the name. Also correct TL-TIME-02's row if its wording no longer
matches.

Quote the table and the native result in your status.

## Out of scope

- Choosing a zone in the UI, and converting *to* another zone.
- The Rust SDK's `Clock` (`packages/plugin-sdk/src/lib.rs`): no native executor needs
  local time yet.
- Any tool other than `time.unix`.
