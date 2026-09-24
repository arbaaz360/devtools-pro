# YAML ↔ JSON plugin

`convert.yaml` exposes two operations over one required text input port,
`input`: `convert.yaml-json` (YAML document → JSON) and `convert.json-yaml`
(JSON → YAML). Both are hand-written and dependency-free: no `js-yaml` or
similar, no `node:` imports (only web platform APIs, so the processor also
runs in the desktop webview's Worker engine), and no code path reaches
`JSON.parse`/`Number` for anything that must survive with its original
lexeme.

`convert.json-yaml` parses its input with `plugins/json`'s own `scanDocument`
tokenizer, `JsonError` and `resolvePositions`, so both packages agree on
"valid JSON" and "exact number" and on the diagnostic shape.

## YAML subset (`convert.yaml-json`)

**Parses:**

- Block mappings and block sequences with consistent sibling indentation. A
  sequence written immediately under its mapping key may share that key's
  column (the common `key:\n- a\n- b` form) or be indented further.
- Flow mappings `{}` and flow sequences `[]`, arbitrarily nested, spanning
  multiple lines; a bare key in a flow mapping (`{a, b: 1}`) is `null`.
  A trailing comma before the closing bracket is rejected
  (`yaml.trailing-comma`), not silently accepted.
- Plain, single-quoted and double-quoted scalars. Double-quoted scalars
  support the JSON escapes (`\" \\ \/ \b \f \n \r \t \uXXXX`) plus `\x` (2
  hex digits), `\U` (8 hex digits) and `\0`; a backslash immediately before a
  line break escapes the break itself (no folding). Single- and
  double-quoted scalars may span physical lines; interior line breaks fold
  to a single space (two or more folds to `n-1` newlines), per YAML 1.2.
- Block scalars `|` (literal) and `>` (folded), with `-`/`+` chomping
  (default: clip — one trailing newline) and an explicit indentation digit
  in either order relative to the chomping indicator (`|2-` or `|-2`).
  Folding joins two non-blank, non-further-indented lines with a space;
  a blank line or a more-indented line always keeps its own newline.
- Comments (`#` at the start of a line or after whitespace) anywhere they
  are legal, including after a scalar or a flow token.
- A single document, with an optional leading `---` (a scalar may follow it
  on the same line) and a trailing `...`.
- Multi-line plain scalars fold the same way as quoted scalars.

**Rejected, each with its own error code naming the construct and a byte
offset/line/column position** (`yaml.<code>`): `anchor-unsupported` (`&`),
`alias-unsupported` (`*`), `tag-unsupported` (`!`), `directive-unsupported`
(`%`), `complex-key-unsupported` (`?`), `multiple-documents`,
`tab-indentation`, `duplicate-key` (both mapping and flow-mapping context;
the diagnostic's `related[0]` is the first occurrence), `trailing-comma`,
`unterminated-string`, `bad-indentation`, `invalid-escape`, `invalid-utf8`.
A duplicate key is a hard rejection here (unlike `plugins/json`, which keeps
both occurrences and only warns): YAML mappings are sets of keys, so a
YAML-specific tool holds documents to that rule.

**Scalar typing** (YAML 1.2 core schema, plain scalars only — a quoted
scalar is always a string): empty, `~`, `null`/`Null`/`NULL` → JSON `null`;
`true`/`True`/`TRUE`/`false`/`False`/`FALSE` → boolean; decimal, `0x`
(hex) and `0o` (octal) integers → a JSON number, converted to decimal;
`.inf`/`-.inf`/`.nan` (case-sensitive, matching the core schema) → JSON
`null`, plus an `info` diagnostic (`yaml.float-special`) since JSON has no
such value; every other float lexeme is normalized just enough to be valid
JSON (`.5` → `0.5`, `1.` → `1.0`, and a leading zero before another digit in
the integer part is stripped: `01.2` → `1.2`, `00e2` → `0e2`, `-00.3` →
`-0.3`) and otherwise preserved digit-for-digit. An integer
lexeme whose magnitude exceeds `Number.MAX_SAFE_INTEGER` is emitted as a
JSON *string* of its decimal digits, plus an `info` diagnostic
(`yaml.unsafe-integer`), so it survives byte-for-byte instead of silently
rounding. Mapping keys are never type-coerced: a key is always the decoded
scalar text, whether or not it was quoted (so `123:` and `"123":` are the
same string key).

**`convert.yaml-json` options:** `indent` — `space2` (default), `space4`,
`minified` (contract `EnumChoice` ids must start with a letter, so these
stand in for "2 spaces" / "4 spaces" / "0, minified"); `sort-keys` (boolean,
default `false`) sorts every mapping's keys, recursively.

## JSON → YAML (`convert.json-yaml`)

The input must be valid JSON by `plugins/json`'s own rules (exact numbers,
no comments, no trailing commas); an invalid document fails with that
package's own diagnostic code and position.

Output is block style: one mapping key per line, sequences as `- ` items,
nested collections indented by the `indent` option (`space2` default,
`space4`; no `minified` choice — block style has no compact form), empty
collections as `{}`/`[]`. A string (or a mapping key) is double-quoted
whenever a plain scalar reading of it would parse as something else (a
number, a boolean, `null`, YAML's reserved words, leading/trailing
whitespace, or the empty string), starts with a structurally significant
character (`- ? : , [ ] { } # & * ! | > ' " % @` \``), or contains `": "`,
`" #"` or a line break — reusing the exact predicate on keys too means a
key round-trips even when quoting it was not, strictly, required. A string
containing a line break is instead emitted as a literal block scalar
(`|`), with the chomping indicator (`-`, none, or `+`) and, when needed
(the first body line is empty or itself starts with whitespace), an
explicit indentation digit chosen so the string's exact trailing-newline
count reproduces on the way back — never unconditionally `|-`, because that
would lose a trailing newline the original string had.

JSON number lexemes (exact digits, never routed through `Number`) are
copied verbatim into the YAML output, so `1.2300` and
`18446744073709551615` come back unchanged; a lexeme this parser would
itself normalize on the way back (a bare leading `+`, an uppercase `E`, a
bare trailing `.`) is not something `plugins/json` accepts as input in the
first place, so it cannot arise here.

**Round trip.** `convert.json-yaml` then `convert.yaml-json` (minified) of
every fixture under `fixtures/json/` reproduces the minified source
byte-for-byte; `test.mjs` checks this against `plugins/json`'s own `minify`
as the independent oracle for "the minified source".

**`convert.json-yaml` options:** `indent` — `space2` (default), `space4`.

## Properties

Both operations write this value on `output` alongside the artifact:
`documents` (always `1`), `keys` (total mapping keys seen, at every depth),
`items` (total sequence/array elements seen, at every depth), `maxDepth`
(container nesting depth; `0` for a bare top-level scalar), `diagnostics`
(a count — see below), `bytes` (size of the artifact actually written).
`convert.yaml-json` additionally writes `diagnosticsDetail`, the full list
of `info`-severity diagnostics (`yaml.unsafe-integer`, `yaml.float-special`)
with resolved byte/line/column positions.

## Limits and cancellation

Same shape as `plugins/json`: `maxInputBytes` (manifest: 16 MiB) is enforced
by the SDK reader before parsing; the effective output cap is
`min(maxOutputBytes, maxChunkBytes)` (manifest: 1 MiB), checked before the
artifact is written — an over-limit result fails explicitly
(`yaml.output-limit`) rather than truncating. The whole input is read
through `context.readChunks` into one buffer (never mutated) and the parser
polls cancellation every `1024` lines of input, in addition to the SDK's own
checks before the read, between reader chunks and before the write.

## Known limitations

- **Embedded literal `\r`.** A JSON string containing an embedded `\r` not
  immediately followed by `\n` is not distinguished, on the way back, from a
  CRLF line ending inside a literal block scalar's body; the round-trip
  fixtures avoid this case rather than special-case it.
- **No anchors, tags, multi-document streams.** Rejected outright (see
  above), never silently dropped, per the packet's scope.
- **Compact nested sequence, one level only.** `- - a` (a sequence item
  that is itself a sequence, written inline after the first dash) is
  rejected as an unexpected token; write the nested sequence on its own,
  more-indented line instead. A sequence of mappings (`- key: value`) and a
  mapping value that is itself a sequence at the same or a deeper column
  are both supported.

## Running the package checks

From the repository root:

```text
node --experimental-strip-types --test plugins/yaml/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin convert.yaml --operation convert.yaml-json --input 'input=a: 1'
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin convert.yaml --operation convert.json-yaml --input 'input={"a":1}'
```

Fixtures live in `fixtures/`: `valid/*.yaml` paired with the exact expected
`*.json` (54 pairs — nested collections, every scalar type, all three
quoting styles, both block scalar styles with each chomping mode, comments,
an empty document, quoted keys with spaces, Unicode); `invalid/*.yaml` (15
files) with `invalid/manifest.json` naming each one's expected error code;
`json/*.json` (17 files) exercising the reverse direction and the
round-trip property.
