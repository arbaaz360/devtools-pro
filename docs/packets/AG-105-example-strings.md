# AG-105 — Example string generator package (DU-20)

## Branch

`antigravity/AG-105-example-strings` from the latest `origin/main`. Record the
base SHA.

## Allowed files

```text
plugins/example-strings/**
```

## Required reading

`ARCHITECTURE.md`, `Tool Contract and Document Model.md`,
`packages/plugin-sdk/README.md`, the DU-20 card in
`docs/DEVUTILS_REQUIREMENTS.md`, and `plugins/uuid/` as the reference package:
a generator with no required input, randomness only from
`context.randomness`, and headless output pinned in fixtures.

Do not modify `plugins/examples/`; the quality gate runs that package.

## Goal

A new package `plugins/example-strings/` with plugin id `generate.examples`
that produces deterministic sample text of every DU-20 category from the
injected randomness.

## Requirements

- Package files as in the reference package; `tests.requirementIds: ["DU-20"]`;
  a `generator` workspace like `plugins/uuid`.
- One operation `generate.examples`, no required input.
- Options: `category` enum `paragraph`, `sentence`, `word`, `title`,
  `first-name`, `last-name`, `full-name`, `email`, `url`, `short-tweet`,
  `long-tweet` (default `sentence`); `count` integer 1–100 (default `1`).
- Corpora live in the package (`words.mjs` or JSON): a lorem ipsum word list,
  at least 100 first names and 100 last names drawn from several languages,
  a handful of example domains under `example.com`, `example.org`, `example.net`
  only, and title-case rules. Emails and URLs must use those reserved domains
  and never a real one.
- Shape rules, and the README states them: a sentence is 6–14 words,
  capitalised, ending in `.`; a paragraph is 3–6 sentences; a title is 3–7
  title-cased words; a short tweet is at most 140 characters and a long tweet
  at most 280, both complete sentences; an email is
  `first.last@domain`, lowercased ASCII; a URL is `https://domain/path` with a
  1–3 segment slug path.
- Every random choice goes through `context.randomness.fill`; the same seed
  gives the same output, and `fixtures/deterministic.json` pins the first three
  items of every category for `SeededRandom(1)` and the headless runner's
  default seed.
- Output port `output`, kind `value`, representations `["text", "properties"]`:
  the items joined by `\n` as text, plus `{ category, count, items }`.
- Errors: count outside 1–100, unknown category, unknown option key. Output
  limit enforced before writing; cancellation polled between items.

## Checks

```text
node --experimental-strip-types --test plugins/example-strings/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin generate.examples --options '{"category":"paragraph","count":2}'
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin generate.examples --options '{"category":"email","count":5}'
cargo run -p devtools-plugin-discovery -- generate plugins <scratch dir>
git diff --check
```

## Evidence

Test counts; the two headless outputs; the discovery generate result.

## Out of scope

Hold-to-repeat, append and replace modes, undo, and the action strip; those
belong to the shell.
