# AG-136 — Line tools: sort, dedupe, reverse, remove blanks (new package)

## Branch

`antigravity/AG-136-line-tools` from the latest `origin/main`. Record the base SHA.

## Allowed files

```text
plugins/lines/**
```

## Required reading

`ARCHITECTURE.md`; `packages/plugin-sdk/README.md`; `docs/WORKER_PROTOCOL.md`,
including "Where an expected value comes from"; and `plugins/string-case/`, a text
tool of the same shape whose manifest, options and tests are the reference.

## Goal

A new package `plugins/lines/`, plugin id `text.lines`, that sorts, de-duplicates,
reverses and cleans the lines of a document. It is in the target catalogue ("line
sort/dedupe", `docs/PARITY_AND_BUILDING_BLOCKS.md`) and not yet built.

## Requirements

- **Package files as in the reference.** `tests.requirementIds: []`: this is not a
  DevUtils card.
- **The tool:** one tool `text.lines`, title `Line Tools`, category `text`, and one
  operation `text.lines`.
  - Input port `input`, a text document.
  - Output `output`, representations `["text", "properties"]`, mime `["text/plain"]`.
  - Triggers `explicit` + `inputChange`. There is no option-change mode: a tool with
    `inputChange` also re-runs when an option changes (`autoOnOption` in
    `apps/desktop/src/plugins/describe.ts`).
  - Limits: 4 MiB in and out, `deadlineMs` 2000.
- **Options:** kebab-case, camelCase aliases, structured errors.
  - `action`: `sort` | `dedupe` | `reverse` | `remove-blank`, default `sort`.
  - `order`: `ascending` | `descending`. Sort only.
  - `compare`: `natural` | `code-point` | `case-insensitive` | `numeric`, default
    `natural`. Sort only.
  - `ignore-case`: boolean, default false. Dedupe only.
  - `ignore-whitespace`: boolean, default false. Dedupe only; compares lines trimmed
    of surrounding whitespace, and outputs them untrimmed.
- **What a line is.** Lines are separated by CRLF, LF or a lone CR.
  - The output joins lines with the input's most frequent ending (LF on a tie).
  - A final line ending in the input is kept, present or absent.
  - No line is invented or lost, except by `dedupe` and `remove-blank`.
- **Sorting is stable:** lines with equal keys keep their input order. `descending`
  reverses the comparison, not the stable order of ties.
- **The comparisons, exactly:**
  - `code-point`: by Unicode **code point**, not UTF-16 code unit. JavaScript's
    default string comparison is by code unit and puts `😀` (U+1F600) before `｡`
    (U+FF61); code-point order puts it after. This case must be in the fixtures.
  - `case-insensitive`: by `toLowerCase()`, then code point.
  - `natural`: split each line into runs of ASCII digits and runs of other
    characters, and compare run by run:
    - two digit runs compare by numeric value, of any length (no `Number`
      overflow); equal values put the shorter run first, so `a2` < `a02` < `a10`;
    - a digit run sorts before a non-digit run;
    - two non-digit runs compare by code point.
  - `numeric`: the key is a leading number: optional whitespace, optional sign,
    digits, optional fraction, optional exponent. Lines with no leading number sort
    after all numbered lines, by code point among themselves.
- **`dedupe`** keeps the first occurrence. **`remove-blank`** drops lines that are empty
  or whitespace-only.
- **Properties:** `lines` (in), `linesOut`, `removed`, `lineEnding` (`LF`/`CRLF`/`CR`),
  `action`.
- `README.md` documents the actions, the four comparisons with an example each, and
  the line-ending rule.

## Checks

```text
node --experimental-strip-types --test plugins/lines/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin text.lines --input "input=b
a"
node scripts/test-plugins.mjs
pnpm --dir apps/desktop build
git diff --check
```

## Evidence

**The expected orders come from an independent implementation in Python, not from
this package.** Commit `plugins/lines/fixtures/generate.py`, run with `py -3`:

- it implements the four comparison keys above in Python;
- Python's `sorted()` is stable, compares strings by code point, and handles
  arbitrary-precision integers;
- it writes the fixture JSON the tests read.

The test never derives an expectation from the package.

Cover:
- empty input; one line; a final newline present and absent;
- CRLF, lone CR, and mixed endings (check the chosen output ending);
- the U+FF61/U+1F600 pair;
- `a2`/`a02`/`a10`/`a1b`/`10`/`9`, and digit runs longer than 20 digits;
- signed, fractional and exponent numbers, plus lines with none;
- case variants for `dedupe` with and without `ignore-case`, and whitespace variants
  with `ignore-whitespace`;
- blank and whitespace-only lines for `remove-blank`;
- `descending` with ties (stability);
- 100,000 lines sorted inside the deadline.

Quote the fixture counts and the headless output in your status.

## Out of scope

Shuffle, locale-aware collation (`Intl.Collator`), column or field sorting, and the
shell.
