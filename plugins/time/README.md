# Unix Timestamp Converter

`time.unix` interprets one timestamp or date and reports every representation DU-01 asks for, with a bounded arithmetic grammar and a captured clock.

## Options

- `interpretation`: `auto` (default), `seconds`, `milliseconds`, `iso`.
- `milliseconds-from-digits`: integer, default `12`. In `auto` mode, a numeric input with at least that many digits is milliseconds, fewer is seconds. Explicit interpretations override this heuristic.

## Inputs

Input port `input`, kind `document`, text, `required: false`. Empty input means "now", taken from `context.clock.now()`.

Accepted input:
- An integer or decimal number of seconds or milliseconds (negative allowed).
- An ISO 8601 date or date-time with `Z` or a numeric offset.
- An arithmetic expression over numeric timestamps with `+ - * /`, decimal numbers, and one level of parentheses, evaluated with normal precedence.

Nothing else parses: no words, no locale dates, no function calls. Ambiguous forms such as `01/02/2024` are rejected with a message naming the ISO form.

## Output

Output port `output`, kind `value`, representations `["properties", "text"]`.

Outputs:
- `epochSeconds`
- `epochMilliseconds`
- `isoUtc`
- `dateUtc`
- `timeUtc`
- `timeZone`
- `utcOffset`
- `local`
- `weekday`
- `dayOfYear`
- `isoWeek`
- `leapYear`
- `relative` (phrase such as `3 days ago`)
- `interpretation`
- `expression` (when arithmetic was evaluated)

`timeZone` is an IANA name (`"Asia/Kolkata"`), read from `context.clock.timeZone()` and
never from the host's own `Date` methods. In the desktop app that is the machine's
resolved zone; a test or the headless runner supplies it explicitly (`FixedClock`'s
second argument, or `--time-zone`), defaulting to `"UTC"`.

`utcOffset` is the zone's offset at that instant, `+05:30` or `-04:00`, with seconds
when the zone's own data has them (`+05:53:28`, local mean time before a zone adopted a
standard offset). `local` is the local date-time in ISO 8601 with that offset and
millisecond precision, `2023-11-15T03:43:20.000+05:30`; UTC is written `+00:00`, never
`Z`. Both are computed with `Intl.DateTimeFormat` against the explicit zone
(`formatToParts`, `timeZoneName: "longOffset"`), so a test run on any machine gives the
same values. An unrecognized zone name is a structured `invalid-timezone` error that
names it, not a silent fallback to UTC.

Values outside ±8,640,000,000,000,000 ms are rejected with the bound in the message. Division by zero, unbalanced parentheses, and non-finite results are structured errors. Nothing is written on error.
