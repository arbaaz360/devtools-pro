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
- `weekday`
- `dayOfYear`
- `isoWeek`
- `leapYear`
- `relative` (phrase such as `3 days ago`)
- `interpretation`
- `expression` (when arithmetic was evaluated)

Values outside ±8,640,000,000,000,000 ms are rejected with the bound in the message. Division by zero, unbalanced parentheses, and non-finite results are structured errors. Nothing is written on error.
