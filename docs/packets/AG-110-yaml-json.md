# AG-110 — YAML ↔ JSON package (DU-17, DU-18)

## Branch

`claude/AG-110-yaml-json` from the latest `origin/main`. Record the base SHA.

## Allowed files

```text
plugins/yaml/**
```

## Required reading

`ARCHITECTURE.md`, `Tool Contract and Document Model.md`,
`packages/plugin-sdk/README.md`, the DU-17 and DU-18 cards in
`docs/DEVUTILS_REQUIREMENTS.md`, the "working" rules in
`docs/WORKER_PROTOCOL.md` (a processor uses web platform APIs only), and two
reference packages: `plugins/json/` for a streaming, diagnostics-bearing
parser and `plugins/string-case/` for option validation.

## Goal

A new package `plugins/yaml/` with plugin id `convert.yaml` and two tools:
`convert.yaml-json` (YAML document → JSON) and `convert.json-yaml` (JSON →
YAML). No dependency: a hand-written parser for the YAML subset below, with
every rejected construct named in a structured error carrying line and column.

## Requirements

- Package files as in the reference packages;
  `tests.requirementIds: ["DU-17", "DU-18"]`. Two operations,
  `convert.yaml-json` and `convert.json-yaml`, each with input port `input`
  (document, text) and output port `output`, kind `artifact`, representations
  `["code", "properties"]`, mime `application/json` and `application/yaml`
  respectively.
- **YAML subset**, stated in the README as the complete list of what parses:
  block mappings and block sequences with consistent indentation; flow
  mappings `{}` and flow sequences `[]` including nesting and trailing commas
  rejected; plain, single-quoted and double-quoted scalars (double-quoted with
  the JSON escapes plus `\x`, `\u`, `\U`, `\t`, `\n`, `\r`, `\0`, `\\`, `\"`,
  `\/`); block scalars `|` and `>` with `-`/`+` chomping and explicit
  indentation indicators; comments; a single document, with an optional
  leading `---` and trailing `...`. Multi-line plain scalars fold per YAML 1.2.
- **Not supported, each rejected with its own error code and the construct
  named**: anchors and aliases (`&`, `*`), tags (`!`), directives (`%`),
  complex keys (`?`), multiple documents, tabs used for indentation, duplicate
  keys in a mapping (named, with both positions).
- **Scalar typing** per the YAML 1.2 core schema: `null`/`~`/empty → `null`;
  `true`/`false` (case-insensitive) → boolean; decimal, `0x`, `0o` integers;
  floats including `.inf`, `-.inf`, `.nan` (mapped to `null` in JSON with a
  diagnostic); everything else a string. Quoted scalars are always strings.
  Integers beyond `Number.MAX_SAFE_INTEGER` become strings with a diagnostic.
- `convert.yaml-json` options: `indent` enum `2`, `4`, `0` (minified),
  default `2`; `sort-keys` boolean, default `false`.
- `convert.json-yaml`: input must be valid JSON (reuse the acceptance rules
  of `plugins/json`: exact numbers, no comments). Output is block style:
  mappings one key per line, sequences with `- `, nested collections
  indented by `indent` (enum `2`, `4`, default `2`); empty collections as
  `{}` and `[]`; strings quoted with double quotes whenever they would parse
  as something else (numbers, booleans, null, leading/trailing space, `:`,
  `#`, `-` at start, multi-line); multi-line strings use `|-` block scalars.
  Round-trip: `json-yaml` then `yaml-json` of every JSON fixture is
  byte-identical to the minified source; test it for every fixture.
- Properties on both outputs: `documents` (always 1), `keys`, `items`,
  `maxDepth`, `diagnostics` (count), `bytes`.
- Diagnostics use the SDK diagnostic shape from `plugins/json` with byte
  offsets, line and column.
- Limits: `maxInputBytes` 16 MiB, `maxOutputBytes` 32 MiB. Read with
  `readChunks`, parse incrementally by line, poll cancellation every 1024
  lines, never hold more than the input and output in memory. Source bytes
  immutable, asserted per test.
- Fixtures under `fixtures/`: `valid/*.yaml` with expected `*.json`
  (nested mappings and sequences, flow collections, every scalar type, all
  three quoting styles, both block scalar styles with each chomping mode,
  comments everywhere they are legal, an empty document, keys with spaces,
  Unicode values); `invalid/*.yaml` with the expected error code (each
  unsupported construct, bad indentation, unterminated quote, duplicate key,
  tab indentation); `json/*.json` for the reverse direction including
  strings that must be quoted. At least 40 valid, 15 invalid, 15 JSON.

## Checks

```text
node --experimental-strip-types --test plugins/yaml/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin convert.yaml --operation convert.yaml-json --input "input=name: DevTools
tags: [a, b]
nested:
  ok: true
  count: 0x1f"
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin convert.yaml --operation convert.json-yaml --input 'input={"name":"DevTools","tags":["a","b"],"note":"yes: really","n":null}'
pnpm --dir apps/desktop build
git diff --check
```

## Evidence

Test counts, fixture counts per group, both headless outputs, and the
`pnpm --dir apps/desktop build` summary line.

## Out of scope

Anchors, tags, multi-document streams (rejected, not silently dropped).
Syntax highlighting and the source/result language identities (shell work).
