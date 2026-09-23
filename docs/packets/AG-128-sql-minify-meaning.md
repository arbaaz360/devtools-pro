# AG-128 — SQL minify must not join tokens into comments or broken numbers (DU-26)

## Branch

`antigravity/AG-128-sql-minify-meaning` from the latest `origin/main`. Record the base SHA.

## Allowed files

```text
plugins/sql/**
```

## Required reading

"Owner decisions → Transforms preserve meaning" in `docs/DEVUTILS_REQUIREMENTS.md`;
the DU-26 card there; `docs/parity/DU-26.md`; `plugins/sql/README.md`; and
`docs/WORKER_PROTOCOL.md`, including "Where an expected value comes from".

## Goal

An independent review (finding AST-002, reproduced by the integrator with
`node:sqlite`) found that **Minify SQL** changes what a query computes and reports
success:

```text
input                          minified                     SQLite result
SELECT 1 - -2 AS answer;       SELECT 1--2 AS answer;       3  ->  1   (--2 AS answer; is now a comment)
SELECT 1E+3 AS n;              SELECT 1 E+3 AS n;           1000 -> error (the exponent was split off)
```

The review traced these to `plugins/sql/processor.mjs` near lines 186 (the numeric
lexer recognises only a lowercase `e`) and 250 (tokens are joined without asking
whether the join lexes differently), at `5866a49`.

## Requirements

- **Never emit two adjacent tokens whose concatenation lexes differently from the
  pair.** At least: `-` followed by `-` (a comment), `/` followed by `*` and `*`
  followed by `/` (comment delimiters), a number followed by an identifier or a
  number, an identifier or keyword followed by an identifier or keyword, and any
  pair that forms a longer operator (`<` `>` into `<>`, `|` `|` into `||`). Where a
  join is unsafe, emit one space.
- **Numbers lex as SQL numbers:** `e` and `E` exponents with an optional sign,
  `.5`, `5.`, `1.5e-3`, and hexadecimal `0x1F`.
- Strings and quoted identifiers are opaque: `'--not a comment'`, `"--x"`,
  `[x]`, and backtick identifiers pass through byte for byte.
- A `--` comment that the options keep ends with a newline in minified output.
- **Beautify meets the same bar.**

## Checks

```text
node --experimental-strip-types --test plugins/sql/test.mjs
node scripts/test-plugins.mjs
pnpm --dir apps/desktop build
git diff --check
```

## Evidence

**The oracle is SQLite, through `node:sqlite` (Node 24, which CI uses), not this
package.** For every query in the corpus:

```js
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(":memory:");
// source, minify(source) and beautify(source) all prepare, and return equal rows
```

The corpus holds both reproductions plus at least twenty queries you write to
break a naive minifier: unary-minus chains (`1 - -2`, `1 - - -2`, `-(-1)`),
`4 / -2`, `2 * -3`, exponents in every spelling, `.5` and `5.`, hexadecimal,
strings and quoted identifiers containing `--`, `/*` and `*/`, a `CASE`
expression, a subquery, `||` concatenation, `<>`, `<=`, `>=`, and a kept `--`
comment in the middle of a statement. Every query in the corpus must be valid
SQLite: it is the oracle for syntax the dialects share.

Quote the corpus table (query, minified output, rows for each) in your status. The
fixtures that pin exact output bytes may stay as stability pins; they are not
evidence of correctness.

## Out of scope

PL/SQL block restructuring (a known DU-26 gap), dialect-specific syntax that
SQLite does not accept, keyword case, the shell.
