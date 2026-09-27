# Unix Timestamp Converter

`time.unix` interprets one timestamp or date and reports every representation DU-01 asks for, with a bounded arithmetic grammar and a captured clock.

## Options

- `interpretation` ("Interpretation"): `auto` (default), `seconds`, `milliseconds`, `iso`, `rfc` (labelled "RFC 5322 / HTTP date").
- `milliseconds-from-digits` ("Milliseconds when at least N digits"): integer, default `12`. In `auto` mode, a numeric input with at least that many digits is milliseconds, fewer is seconds. Explicit interpretations override this heuristic, so the option is shown only while `interpretation` is `auto`.

## Inputs

Input port `input`, kind `document`, text, `required: false`. Empty input means "now", taken from `context.clock.now()`.

Accepted input:
- An integer or decimal number of seconds or milliseconds (negative allowed).
- An ISO 8601 date or date-time with `Z` or a numeric offset.
- RFC Dates: RFC 5322 (`Fri, 21 Nov 1997 09:55:06 -0600`), IMF-fixdate (`Sun, 06 Nov 1994 08:49:37 GMT`), RFC 850 (`Sunday, 06-Nov-94 08:49:37 GMT`), and asctime (`Sun Nov  6 08:49:37 1994`).
  - Year rules: Four digits are taken literally. RFC 5322 two-digit years below 50 add 2000, and 50-99 add 1900. Three-digit years add 1900. RFC 850 two-digit years are mapped to the current century unless that places them more than 50 years in the future, in which case they belong to the previous century.
  - Zones: Accepted zone names are `UT`, `GMT`, `EST`, `EDT`, `CST`, `CDT`, `MST`, `MDT`, `PST`, `PDT`, or a numeric offset like `+0530`.
- An arithmetic expression over numeric timestamps with `+ - * /`, decimal numbers, and one level of parentheses, evaluated with normal precedence.

Nothing else parses: no words, no locale dates, no function calls. Ambiguous forms such as `01/02/2024` are rejected with a message naming the ISO form.

The tool also specifically refuses:
- Mismatched weekdays in RFC dates (e.g., `Mon, 14 Nov 2023 22:13:20 GMT` when the date is a Tuesday).
- Obsolete military time zones (like `Z`) in RFC dates.
- Impossible dates or times (like 29 Feb in a common year, hour 24, or minute 60).
- Leap seconds (e.g., second 60, since Unix time cannot represent them).

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

Values outside ±8,640,000,000,000,000 ms are rejected with the bound in the message. Division by zero, unbalanced parentheses, and non-finite results are structured errors. Input that is none of the accepted forms is the `invalid-token` error "Not a Unix timestamp, ISO 8601 date, RFC date or arithmetic expression: " followed by the input as typed (surrounding whitespace trimmed, inner spaces and line breaks kept), cut to 60 characters with an ellipsis when longer. Nothing is written on error.
