# AG-101 — Plugin package tests in the quality gate

## Branch

`antigravity/AG-101-plugin-tests-gate` from the latest `origin/main`. Record
the base SHA.

## Allowed files

```text
scripts/test-plugins.mjs
scripts/quality-gate.mjs
docs/QUALITY_CHECKS.md
```

## Required reading

`docs/QUALITY_CHECKS.md`, `scripts/quality-gate.mjs`, and one package test to
see the shape: `plugins/url/test.mjs`.

## Goal

The nine plugin packages under `plugins/` carry roughly 575 `node:test` cases
in `plugins/<name>/test.mjs`. The quality gate runs none of them, so a merged
package can regress without CI noticing. Make them part of the gate.

## Requirements

- Add `scripts/test-plugins.mjs`. It discovers every `plugins/*/test.mjs`
  (sorted by name), runs each with
  `node --experimental-strip-types --test <file>` from the repository root,
  prints one line per package with its pass and fail counts, and exits nonzero
  if any package fails or if no package is found.
- It takes an optional first argument, the plugins root, defaulting to
  `plugins`. That is how you prove the failure path without touching a real
  package: point it at a scratch directory holding one `x/test.mjs` with a
  failing test.
- Packages run sequentially so their output stays readable. Do not add a
  dependency; `node:child_process` and `node:fs` are enough.
- Wire it into `scripts/quality-gate.mjs` directly after the
  `packages/plugin-sdk headless` step, using the existing `run()` helper.
- Add one paragraph to `docs/QUALITY_CHECKS.md` naming the step and the
  standalone command.

## Checks

```text
node scripts/test-plugins.mjs
node scripts/test-plugins.mjs <scratch root with one failing test.mjs>   (must exit 1)
node scripts/quality-gate.mjs   (optional locally; CI runs it on the PR)
git diff --check
```

## Evidence

Paste the runner's per-package lines from the real `plugins/` root and the
exit code from the failing scratch root.

## Out of scope

Changing any package's tests. Parallel execution. Coverage reporting.
