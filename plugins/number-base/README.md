# Number Base Converter

`number.base` converts an exact integer between bases 2 to 36 with arbitrary precision. It operates strictly on integers without limits on value, subject only to memory limits for very large results.

## Options

| Option | Choices | Default | Meaning |
|---|---|---|---|
| `from-base` | `2` to `36` | `10` | The base of the input number. |
| `to-base` | `2` to `36` | `16` | The base to convert the number into. |
| `digits` | `lower`, `upper` | `lower` | The casing of alphabetic digits in the result. |

Unknown options or bases outside the `2` to `36` range are rejected with `invalid-option`.

## Grammar

Input values must adhere to the following grammar:
- Surrounding whitespace is ignored.
- The input must be a single line of text; a second line with content is rejected.
- An optional `-` sign indicating a negative number.
- An optional prefix: `0b` or `0B` for binary, `0o` or `0O` for octal, and `0x` or `0X` for hexadecimal. If present, the prefix must correspond exactly to the configured `from-base` (2, 8, or 16).
- One or more digits valid for `from-base`, which are case-insensitive.

### Invalid Inputs
- **Prefix Mismatch**: A prefix that does not match the `from-base` fails with `prefix-mismatch`.
- **Invalid Digits**: Any character not valid in the specified `from-base` fails with `invalid-character`, naming the character and its offset.
- **Fractions & Separators**: No decimals, thousands separators, or exponent notations are permitted.

## Diagnostics

Errors are structured as `NumberBaseError` with a `code`:
- `invalid-option`
- `empty-input`
- `invalid-character`
- `prefix-mismatch`
- `no-digits`
- `output-limit`

Errors report the 0-based `offset` of the first offending byte.

## Output

`output` carries the converted result in the requested base as the text artifact.
The associated properties value contains:
- `result`: The value formatted in `to-base`.
- `binary`: The value formatted in base 2.
- `octal`: The value formatted in base 8.
- `decimal`: The value formatted in base 10.
- `hexadecimal`: The value formatted in base 16.
- `fromBase`: The base used to parse the input.
- `toBase`: The base used to format the primary result.
- `digits`: The number of digits in the `result` (excluding any sign).
- `negative`: Boolean indicating if the value is mathematically less than zero. (Input `-0` evaluates to `0` and is not negative).

## Limits

- `maxInputBytes`: 64 KiB (approx. 65,536 digits).
- `maxOutputBytes`: 1 MiB. The processor preemptively checks the length of the string result and throws an `output-limit` error before writing if the size exceeds this boundary.

## Checks

From the repository root:

```text
node --experimental-strip-types --test plugins/number-base/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin number.base --input "input=9007199254740993" --options '{"to-base":2}'
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin number.base --input "input=-0xFF" --options '{"from-base":16,"to-base":36}'
```
