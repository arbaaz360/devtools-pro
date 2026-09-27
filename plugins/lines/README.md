# Line Tools

This package provides utilities for processing lines of a text document.

## Actions

The tool supports four primary operations on the lines of the input text:

- **Sort**: Arranges the lines according to a specified comparison method and order (Ascending or Descending). The sorting is stable, meaning lines that compare as equal will preserve their original relative order.
- **De-duplicate**: Removes duplicate lines. It always keeps the first occurrence of each unique line. It can optionally ignore case and ignore surrounding whitespace when comparing lines.
- **Reverse**: Reverses the order of all lines in the document.
- **Remove blank lines**: Removes any line that is empty or contains only whitespace characters.

## Sorting Comparisons

When using the **Sort** action, four comparison methods are available:

1. **Natural**: Splits each line into alternating runs of digits and non-digits. Digit runs are compared by numeric value (ignoring leading zeros), but equal numeric values are ordered such that shorter runs (fewer leading zeros) appear first. Non-digit runs are compared by Unicode code point. A digit run will always sort before a non-digit run.
   - *Example*: `9`, `10`, `a1b`, `a2`, `a02`, `a10`
2. **Numeric**: Extracts a leading number from each line (which may include a sign, decimal fraction, and exponent) and sorts lines by this numeric value. Lines that do not begin with a valid number are sorted after all numbered lines, by code point among themselves.
   - *Example*: `-1.5e2`, `0.5`, `42`, `abc`, `no number`
3. **Case Insensitive**: Converts all text to lower case before comparing by Unicode code point.
   - *Example*: `Apple`, `apple`, `Banana`
4. **Code Point**: Compares strings precisely by their Unicode code point values, unlike JavaScript's default UTF-16 code unit comparison which can produce incorrect ordering for characters outside the Basic Multilingual Plane (like emojis).
   - *Example*: `｡` (U+FF61) comes before `😀` (U+1F600).

## Line Endings

Lines are interpreted as being separated by `CRLF` (`\r\n`), `LF` (`\n`), or a lone `CR` (`\r`). 
When joining the processed lines back together to form the output document, the tool uses the most frequently occurring line ending from the original input (defaulting to `LF` in the case of a tie). A final line ending at the end of the input text will be preserved in the output, whether it is present or absent.
