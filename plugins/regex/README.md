# Regular Expression Tester

`text.regex` runs a **JavaScript (ECMAScript) regular expression** over one
UTF-8 text input, using the host engine's own `RegExp` implementation. This is
the ECMAScript regex flavour: syntax, flag semantics, Unicode property
escapes and case folding all follow the ECMAScript specification. **It is not
ICU** and does not claim ICU conformance, whitespace/comment mode (`x`), or
possessive/atomic quantifiers.

Two operations share one tool and one option set: `match` reports every
occurrence and its capture groups; `replace` produces the replaced document.
The source document is never modified.

## Options

| Id | Alias | Type | Default | Meaning |
|---|---|---|---|---|
| `pattern` | | string | `""` | The regular expression source, passed to `new RegExp(pattern, flags)`. At most 4,096 UTF-8 bytes. |
| `mode` | | `match` \| `replace` | `match` | `match` reports matches and groups; `replace` produces replaced text. |
| `replacement` | | string | `""` | Replacement pattern used in `replace` mode. |
| `global` | | boolean | `true` | `true` finds/replaces every occurrence (`matchAll`/`replace` with the `g` flag); `false` finds/replaces only the first. |
| `ignore-case` | `ignoreCase` | boolean | `false` | Adds the `i` flag. |
| `multiline` | | boolean | `false` | Adds the `m` flag: `^`/`$` match at line boundaries. |
| `dot-all` | `dotAll` | boolean | `false` | Adds the `s` flag: `.` matches line terminators. |
| `unicode` | | boolean | `false` | Adds the `u` flag: code-point-aware matching, `\p{...}` property escapes, strict escape syntax. The `v` flag (set notation) is out of scope. |
| `sticky` | | boolean | `false` | Adds the `y` flag: each match (in `global` mode, each next match) must start exactly at the previous match's end. |

Options are validated before the input is read. An absent option takes its
default; `null`, a wrong type, an unknown key, a value outside the enum, a
pattern over 4,096 UTF-8 bytes, or a string with a lone surrogate is rejected
with `regex.invalid-option`. The kebab-case ids are the manifest identifiers;
the camelCase aliases are what the desktop shell uses. Supplying both
spellings of one option with different values is rejected.

## Compilation

The processor compiles `new RegExp(pattern, flags)`, where `flags` is built
from the boolean options above (plus an internal `d` flag always added so
group spans are available; `d` never appears in the reported `flags` value,
since it is not a user option). A `SyntaxError` from the engine becomes a
structured error `regex.invalid-pattern` carrying the engine's own message;
nothing is written. Some patterns are syntactically valid only with a
particular flag combination — for example `\p{Valid}` is a Unicode property
escape only with `unicode: true`, and is invalid Unicode-property syntax when
compiled with that flag but ordinary text otherwise; `regex.invalid-pattern`
reports whichever the chosen flags produce.

An **empty pattern is not an error**: it reports zero matches in `match` mode,
and in `replace` mode leaves the input unchanged with `replacements: 0`.

## Match mode

Matches are found with `String.prototype.matchAll` when `global` is `true`
(so a zero-length match always advances — by one code unit, or one code
point when `unicode` is set — and the loop terminates), or a single
`RegExp.prototype.exec` otherwise.

For each match, the value carries:

- `index`, `end` — UTF-16 code-unit offsets into the input, matching
  `String#length`/`String#slice` (not bytes).
- `text` — the matched substring.
- `groups` — an array in group order (the same order as `$1`, `$2`, ...) of
  `{ number, name, index, end, text }`. `name` is the group's `(?<name>...)`
  name or `null` for a numbered-only group. A group that did not participate
  in the match has `index`, `end` and `text` all `null`.
- `named` — the same group entries, additionally keyed by name, for every
  named group in the pattern (participating or not).

`count` is the exact number of matches in the source, even beyond the
`matches` listing bound; `truncated` is `count > matches.length`. `matches`
lists at most 10,000 entries. `annotations` is one `{ start, end, kind:
"match", label: "#n" }` per listed match followed by one `{ start, end, kind:
"group", label }` per participating group of that match (label is the
group's name, or its number as a string when unnamed), at most 20,000
entries total; the shell highlights these spans in the editor. Both use
UTF-16 offsets, the same as `index`/`end`.

The `text` representation is one line per match, `#n [index-end] text`, then
one indented line per group, `  name: text` (using the group's number when
it has no name; an empty string for a group that did not participate), so
the whole list is copyable.

## Replace mode

Replacement uses `String.prototype.replace` with the regular expression and
the `replacement` string: when `global` is `true` the compiled pattern
carries the `g` flag, so `replace` substitutes every occurrence; otherwise
only the first. The replacement string's dollar patterns are exactly what
ECMAScript defines for a string replacement: `$$` (literal `$`), `$&` (the
whole match), `` $` `` (the input before the match), `$'` (the input after
the match), `$1`–`$9` (or higher, per the spec's disambiguation rules) for
numbered groups, and `$<name>` for named groups. No other substitution
syntax is recognised. A numbered reference beyond the pattern's group count
is left as literal text. A `$<name>` reference is left as literal text only
when the pattern has no named groups at all; once the pattern has any named
group, a reference to a name it does not declare, or to one that did not
participate in this match, substitutes empty text, the same as a
non-participating numbered group.

The `text` representation is the replaced document. The value carries
`replacements`, the exact count of occurrences replaced (`0` or `1` when
`global` is `false`). `matches` and `annotations` are empty in `replace`
mode; `count` equals `replacements`.

## Value

Every response (both modes) carries:

| Field | Meaning |
|---|---|
| `operation` | `text.regex` |
| `mode`, `pattern`, `replacement`, `global`, `ignoreCase`, `multiline`, `dotAll`, `unicode`, `sticky` | normalized options |
| `flavor` | always `"ecmascript"` |
| `flags` | the flag string actually compiled (without the internal `d` flag) |
| `count` | exact match count (`match` mode) or replacement count (`replace` mode) |
| `truncated` | `count > matches.length`; always `false` in `replace` mode |
| `matches[]` | see Match mode; `[]` in `replace` mode |
| `annotations[]` | see Match mode; `[]` in `replace` mode |
| `replacements` | exact replacement count; `0` in `match` mode |
| `inputBytes`, `inputLength` | source size in bytes and UTF-16 code units |
| `outputBytes`, `outputLength` | size of `text` in bytes and UTF-16 code units |
| `text` | the match listing or the replaced document, see above |
| `complete` | always `true` |

Identical requests produce identical bytes. The processor uses no clock,
randomness or secrets.

## Limits

| Limit | Value | On violation |
|---|---|---|
| Pattern | 4,096 UTF-8 bytes | `regex.invalid-option` |
| Input | 4 MiB (manifest `maxInputBytes`), and 4 MiB UTF-16 code units (package constant) | SDK `readChunks` error, or `regex.input-limit` |
| Output | 16 MiB (manifest `maxOutputBytes`) | `regex.output-limit` before anything is written |
| Listed matches | 10,000 | offsets truncated, `count` stays exact |
| Listed annotations | 20,000 total | annotations truncated once the bound is reached |
| Cancellation | polled between input chunks and at least every 256 matches (or replacements) | `ProcessorCancelled`, nothing written |
| Deadline | 2,000 ms (manifest `deadlineMs`) | enforced by the host, which terminates the worker; the processor cannot interrupt a catastrophic regular expression mid-evaluation |

## Diagnostics

| Code | Where | When |
|---|---|---|
| `regex.invalid-option` | thrown | unknown key, wrong type, bad enum value, over-long or ill-formed string, conflicting aliases, oversize pattern |
| `regex.unsupported-operation` | thrown | `operationId` supplied and not `text.regex` |
| `regex.invalid-pattern` | thrown | `new RegExp(pattern, flags)` throws a `SyntaxError`; the message is the engine's own |
| `regex.invalid-utf8` | thrown | input bytes are not valid UTF-8 |
| `regex.input-limit` | thrown | input above the injected byte limit or the code-unit limit |
| `regex.output-limit` | thrown | serialized report above the output/chunk limit |

Thrown errors are `RegexError` instances with `code` and a contract-shaped
`diagnostic` (`code`, `severity`, `message`, optional `data`).

## Running

```text
node --experimental-strip-types --test plugins/regex/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin text.regex --input "input=2024-02-29 and 1999-12-31" --options '{"pattern":"(?<y>\\d{4})-(?<m>\\d{2})-(?<d>\\d{2})"}'
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin text.regex --input "input=hello world" --options '{"pattern":"o","mode":"replace","replacement":"0"}'
```

Fixtures live in `fixtures/match.json` (match-mode behaviour with
hand-derived offsets), `fixtures/replace.json` (replace-mode behaviour), and
`fixtures/invalid.json` (rejected options, patterns and bytes). The test file
adds limit, cancellation, determinism and immutability checks, and verifies
for every match fixture that the reported offsets and text agree with an
independent slice of the source.

## Known gaps

- Native execution of `javascriptWorker` processors is not yet available;
  the package is proven through the SDK harness and headless runner.
- ICU syntax, the `v` flag, explaining the pattern, the capture tree and
  highlight rendering are out of scope (the shell reads `matches` and
  `annotations` for those).
