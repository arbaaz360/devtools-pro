# AG-130 — YAML to JSON must emit JSON numbers (DU-17)

## Branch

`claude/AG-130-yaml-json-numbers` from the latest `origin/main`. Record the base SHA.

## Allowed files

```text
plugins/yaml/**
```

## Required reading

"Owner decisions → Transforms preserve meaning" in `docs/DEVUTILS_REQUIREMENTS.md`;
the DU-17 and DU-18 cards there; `docs/parity/DU-17.md`; `plugins/yaml/README.md`;
and `docs/WORKER_PROTOCOL.md`, including "Where an expected value comes from".

## Goal

An independent review (finding AST-004, reproduced by the integrator) found that
**YAML to JSON** reports success while emitting text that is not JSON:

```text
input        output              JSON.parse
a: 01.2      { "a": 01.2 }       SyntaxError: Unexpected number
a: 00e2      { "a": 00e2 }       SyntaxError
a: -00.3     { "a": -00.3 }      SyntaxError
```

YAML 1.2's core schema resolves all three as numbers (`01.2` matches its float
pattern), so they are numbers, and JSON has one spelling for a number's integer
part: no leading zeros. The review traced this to `plugins/yaml/processor.mjs` near
lines 172, 186 and 209 (at `5866a49`): the scalar is classified as a number, but
`normalizeFloat` copies the lexeme's mantissa through unchanged.

## Requirements

- **Every successful YAML to JSON output parses with `JSON.parse`.**
- A plain scalar that the core schema resolves as a number becomes a JSON number
  whose value is the same, **written from the lexeme's digits** so precision
  survives: strip leading zeros from the integer part (`01.2` → `1.2`, `-00.3` →
  `-0.3`, `00e2` → `0e2`, `007` → `7`), and keep every significant digit.
- A lexeme that cannot become a JSON number without changing its value (`.inf`,
  `.nan`) keeps whatever the package does today — the card's policy — and is
  reported, not emitted as invalid JSON.
- JSON to YAML is unaffected, but its tests gain the same `JSON.parse` round trip.

## Checks

```text
node --experimental-strip-types --test plugins/yaml/test.mjs
node scripts/test-plugins.mjs
pnpm --dir apps/desktop build
git diff --check
```

## Evidence

**Two oracles, neither of them this package.** `JSON.parse` decides validity: every
successful output of every fixture parses. The YAML 1.2 core schema's float and int
patterns (quote them from the specification in the test) decide which scalars are
numbers. The expected JSON for each numeric case is **written by hand** from the
lexeme: `01.2` → `1.2`.

Add a test that runs `JSON.parse` over the output of every existing successful
fixture, so this class cannot return. Cover `0`, `-0`, `00`, `+1`, `0.0`,
`1_000` (not a YAML 1.2 number: a string), `0x1F`, `0o17`, and a 30-digit integer
(its digits must survive exactly). Quote the table in your status.

## Out of scope

Aliases, tags and multi-document streams (deliberately rejected per the card);
the shell.
