# Find & Replace

`text.find-replace` searches one UTF-8 text input for a literal query and
optionally replaces the first or every occurrence. It publishes one JSON report
on the `output` port with exact counts, bounded match offsets, and the result
text. The query is never compiled into a regular expression, the replacement is
inserted verbatim, and the source document is never modified.

## Options

| Id | Alias | Type | Default | Meaning |
|---|---|---|---|---|
| `query` | | string | `""` | Literal text to find. Every character, including `.`, `*`, `\`, `$` and newlines, is matched as itself. |
| `replacement` | | string | `""` | Literal text inserted for each replaced match. `$&`, `$1`, `\n` and similar sequences are inserted unchanged. |
| `mode` | | `find` \| `replace` \| `replaceAll` | `find` | `find` reports matches only; `replace` replaces the leftmost match; `replaceAll` replaces every match. |
| `case-sensitive` | `caseSensitive` | boolean | `true` | `false` compares simple case foldings (see below). |
| `whole-word` | `wholeWord` | boolean | `false` | `true` keeps only matches bounded by non-word characters or the document edges. |

Options are validated before the input is read. An absent option takes its
default; `null`, a wrong type, an unknown key, a value outside the enum, a
query or replacement longer than 1,048,576 UTF-16 code units, or a string with
a lone surrogate is rejected with `find.invalid-option`. The kebab-case ids are
the manifest identifiers; the camelCase aliases are what the desktop shell
uses. Supplying both spellings with different values is rejected.

## Matching semantics

- **Encoding.** The input must be valid UTF-8 (overlong forms and encoded
  surrogates are rejected with `find.invalid-utf8`). A leading byte order mark
  is kept as the character U+FEFF, so `find` mode returns the source bytes
  unchanged and offsets count it.
- **No normalization.** Code points are compared as written: `café` does not
  match `cafe` + U+0301, and `ß` never matches `ss`.
- **Left to right, non-overlapping.** After an accepted match the scan resumes
  at the match end, so `aa` occurs twice in `aaaa` and `aba` once in `ababa`.
  Replacements are never rescanned: replacing `a` with `aa` in `aaa` gives
  `aaaaaa` and three replacements.
- **Multiline.** A newline is an ordinary character. `\n` in the query matches
  the LF inside a CRLF pair; `\r\n` matches only CRLF. Nothing is normalized.
- **Empty query.** Matches nothing in every mode, leaves the text unchanged and
  adds the `find.empty-query` info diagnostic.
- **Case-insensitive.** Each code point of the text and the query is mapped
  with Unicode *simple* case folding (CaseFolding.txt statuses C and S), which
  is exactly the equivalence ECMAScript applies to `u`-mode `i` regular
  expressions. The package test proves this against the engine for every cased
  code point. Consequences: `Σ`, `σ` and final `ς` are equal; `K` (Kelvin sign)
  equals `k`; `ẞ` equals `ß`; `ß` does not equal `ss` (no full folding);
  dotless `ı` and dotted `İ` stay distinct from `i`/`I`. Offsets always refer
  to the source text, even when a folded form has a different length.
- **Whole word.** A match is kept when the code point before its start and the
  code point after its end are both absent (document edge) or not word
  characters. Word characters are `\p{L}`, `\p{N}`, `\p{M}` and `_`, so digits,
  combining marks and ideographs join words. The query itself may contain
  non-word characters. After a rejected candidate the scan resumes one code
  unit later rather than at the candidate end, so `--` is found once in
  `x--- ` (at offset 2). Whole word combines with case-insensitive matching.

## Modes and counts

| Mode | `text` | `replacementCount` | `matches` / `matchCount` |
|---|---|---|---|
| `find` | identical to the source | `0` | every occurrence (offsets bounded, count exact) |
| `replace` | leftmost occurrence replaced | `0` or `1` | every occurrence in the source |
| `replaceAll` | every occurrence replaced | `matchCount` | every occurrence in the source |

Match offsets always describe the **source** document, never the result.

## Report

`output` carries the same report as a structured value and as UTF-8 JSON bytes
(pretty-printed, two-space indent, one match and one diagnostic per line,
trailing newline). Keys appear in this order:

| Field | Type | Meaning |
|---|---|---|
| `operation` | string | `text.find-replace` |
| `mode`, `query`, `replacement`, `caseSensitive`, `wholeWord` | | normalized options |
| `matchCount` | integer | exact number of occurrences in the source |
| `replacementCount` | integer | exact number of replacements made |
| `matchLimit` | integer | `10000`, the listing bound |
| `matchesTruncated` | boolean | `matchCount > matches.length` |
| `matches[]` | `{start, end, startByte, endByte}` | first `matchLimit` occurrences; `start`/`end` are UTF-16 code units, `startByte`/`endByte` UTF-8 bytes, both half-open |
| `inputBytes`, `inputLength` | integer | source size in bytes and UTF-16 code units |
| `outputBytes`, `outputLength` | integer | result size in bytes and UTF-16 code units |
| `text` | string | the result document |
| `diagnostics[]` | `{code, severity, message, data?}` | non-fatal notes (see below) |
| `complete` | `true` | the report is never partial |

Identical requests produce identical bytes. The processor uses no clock,
randomness or secrets.

## Limits

| Limit | Value | Source | On violation |
|---|---|---|---|
| Input bytes | 1,048,576 in the manifest; whatever the host injects | `context.limits.maxInputBytes` | SDK `readChunks` error, or `find.input-limit` |
| Source text | 1,048,576 UTF-16 code units | package constant | `find.input-limit` |
| Query, replacement | 1,048,576 UTF-16 code units each | package constant, manifest `maxLength` | `find.invalid-option` |
| Result text | 1,048,576 UTF-16 code units | package constant | `find.output-limit`, checked while splicing |
| Listed matches | 10,000 (`matchLimit`, manifest `maxRows`) | package constant | offsets truncated, counts exact, `find.match-limit` warning |
| Report bytes | smaller of `maxOutputBytes` and `maxChunkBytes` (4 MiB in the manifest, 1 MiB with SDK defaults) | injected limits | `find.output-limit` before anything is written |
| Cancellation | polled between input chunks, at least every 4,096 folded code points, scan candidates and offset steps | `context.cancellation` | `ProcessorCancelled`, nothing written |

The report is written as a single chunk because the SDK sink publishes one
write per port. A large document therefore needs an output limit above its own
size plus roughly 70 bytes per listed match; with SDK default limits a report
over 1 MiB is refused rather than truncated. Deadline enforcement belongs to
the host scheduler.

## Diagnostics

| Code | Severity | Where | When |
|---|---|---|---|
| `find.invalid-option` | error | thrown | unknown key, wrong type, bad enum value, over-long or ill-formed string, conflicting aliases |
| `find.unsupported-operation` | error | thrown | `operationId` supplied and not `text.find-replace` |
| `find.invalid-utf8` | error | thrown | input bytes are not valid UTF-8 |
| `find.input-limit` | error | thrown | input above the injected byte limit or the code-unit limit |
| `find.output-limit` | error | thrown | result text or serialized report above its limit |
| `find.empty-query` | info | `diagnostics` | query is empty |
| `find.match-limit` | warning | `diagnostics` | more than 10,000 matches; `data` carries `matchCount` and `limit` |

Thrown errors are `FindReplaceError` instances with `code` and a
contract-shaped `diagnostic` (`code`, `severity`, `message`, optional `data`).
The SDK has no processor diagnostic emitter, so fatal diagnostics travel as the
execution error and source spans are not attached.

## Running

```text
node --experimental-strip-types --test plugins/find-replace/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin text.find-replace --operation text.find-replace --input "input=Café café CAFÉ" --options '{"query":"café","replacement":"tea","mode":"replaceAll","case-sensitive":false,"whole-word":true}'
```

Fixtures live in `fixtures/cases.json` (valid behaviour with hand-derived
offsets) and `fixtures/invalid.json` (rejected options and bytes). The test
file adds limit, cancellation, determinism and case-folding oracle checks and
verifies for every case that source bytes are untouched, byte offsets agree
with an independent UTF-8 encoding, and the reported offsets reproduce the
result text.

## Known gaps

- Native execution of `javascriptWorker` processors is not yet available; the
  package is proven through the SDK harness and headless runner.
- The desktop shell still uses its own editor helper
  (`apps/desktop/src/workbench/findReplace.ts`). It agrees with this package
  except that its regex-driven whole-word scan resumes at a rejected
  candidate's end, so a non-word query such as `--` can miss a bounded
  occurrence this package reports.
