# AG-116 — Regular expression tester package (DU-03)

## Branch

`claude/AG-116-regex-tester` from the latest `origin/main`. Record the base SHA.

## Allowed files

```text
plugins/regex/**
```

## Required reading

`ARCHITECTURE.md`, `Tool Contract and Document Model.md`,
`packages/plugin-sdk/README.md`, the DU-03 card in
`docs/DEVUTILS_REQUIREMENTS.md`, the "working" rules in
`docs/WORKER_PROTOCOL.md` (a processor uses web platform APIs only),
`docs/PLUGIN_HOST_IMPLEMENTATION.md` ("The webview worker engine", including
the annotations paragraph), and two reference packages: `plugins/find-replace/`
for match reporting over Unicode text and `plugins/string-case/` for option
validation with kebab-case ids.

## Goal

A new package `plugins/regex/` with plugin id `text.regex` that runs a
JavaScript (ECMAScript) regular expression over the document, reports every
match with its groups, and in replace mode produces the replaced text. The
flavour is ECMAScript and the README says so; it is not ICU and must not
claim to be.

## Requirements

- Package files as in the reference packages; `tests.requirementIds: ["DU-03"]`.
- One tool `text.regex`, category `text`, one operation `text.regex`. Input
  port `input` (document, text). Output port `output`, kind `value`,
  representations `["annotations", "table", "properties", "text"]`.
- Options (kebab-case ids, camelCase aliases, structured errors for unknown
  keys and wrong types): `pattern` string, default `""`; `mode` enum `match`,
  `replace` (default `match`); `replacement` string, default `""`;
  `global` boolean (default `true`); `ignore-case`, `multiline`, `dot-all`,
  `unicode`, `sticky` booleans (default `false`). `unicode` adds the `u`
  flag; `v` is out of scope.
- Compilation: `new RegExp(pattern, flags)`. A `SyntaxError` becomes a
  structured error `regex.invalid-pattern` carrying the engine's message;
  nothing is written. An empty pattern is not an error: it reports zero
  matches and, in replace mode, the input unchanged.
- Match mode: iterate with `matchAll` when `global`, else a single `exec`.
  For each match: `index` and `end` as UTF-16 code-unit offsets into the
  decoded input, `text`, and `groups`: an array in group order of
  `{ number, name (or null), index, end, text }` with `null` index/end/text
  for a group that did not participate; named groups also appear in a
  `named` object. A zero-length match advances by one code unit (or one code
  point with `u`) so the loop always terminates.
- Value: `flavor: "ecmascript"`, `flags` (the string used), `count`,
  `truncated`, `matches` (at most 10,000; `truncated: true` beyond that),
  and `annotations`: one `{ start, end, kind: "match", label: "#n" }` per
  match followed by one `{ start, end, kind: "group", label: "<name or
  number>" }` per participating group, offsets as above, at most 20,000
  entries. The shell highlights annotations in the editor; `start`/`end` are
  UTF-16 offsets into the input text, not bytes.
- Text representation (match mode): one line per match,
  `#n [index-end] text` then one indented line per group `  name: text`,
  so the list is copyable. In replace mode the text representation is the
  replaced document and the value carries `replacements` (count).
- Replace mode: `String.prototype.replace` (or `replaceAll` semantics when
  `global`) with the replacement string's dollar patterns as ECMAScript
  defines them: `$1`, `$<name>`, `$&`, the two context patterns (dollar
  followed by a backtick, and dollar followed by an apostrophe), and `$$`.
  The README lists them.
- Limits: `maxInputBytes` 4 MiB, `maxOutputBytes` 16 MiB, `deadlineMs`
  2000. The pattern may be at most 4 KiB. Cancellation is polled every 256
  matches. The processor cannot interrupt a catastrophic regex mid-evaluation;
  the README states that the host enforces the deadline by terminating the
  worker. Source bytes immutable, asserted per test.
- Fixtures under `fixtures/`: at least 40 `match` cases (the DU-03 screenshot
  examples, every flag alone and combined, named and numbered groups,
  non-participating groups, zero-length matches at start, middle and end,
  Unicode astral characters with and without `u`, sticky from index 0,
  multiline anchors, dot-all, a pattern that matches 10,001 times to prove
  truncation, an empty pattern), 15 `replace` cases (every dollar form, a
  replacement that inserts `$$`, global vs first-only), and invalid cases
  (unbalanced parenthesis, invalid flag combination, oversize pattern).
  Annotation offsets are asserted for every match fixture.

## Checks

```text
node --experimental-strip-types --test plugins/regex/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin text.regex --input "input=2024-02-29 and 1999-12-31" --options '{"pattern":"(?<y>\\d{4})-(?<m>\\d{2})-(?<d>\\d{2})"}'
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin text.regex --input "input=hello world" --options '{"pattern":"o","mode":"replace","replacement":"0"}'
pnpm --dir apps/desktop build
git diff --check
```

## Evidence

Test counts, fixture counts, both headless outputs, the
`pnpm --dir apps/desktop build` summary line.

## Out of scope

ICU or PCRE syntax, the `v` flag, explaining the pattern, the capture tree
and highlight rendering (shell work, reads `annotations`).
