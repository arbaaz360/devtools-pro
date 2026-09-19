# AG-106 — UUID package follow-ups

## Branch

`antigravity/AG-106-uuid-followups` from the latest `origin/main`. Record the
base SHA.

## Allowed files

```text
plugins/uuid/**
```

## Required reading

`plugins/uuid/README.md`, `plugins/uuid/processor.mjs`, `plugins/uuid/test.mjs`,
the DU-10 card in `docs/DEVUTILS_REQUIREMENTS.md`, and the review on
https://github.com/arbaaz360/devtools-pro/pull/6.

## Goal

Close the three non-blocking items from the CL-008 review without changing any
existing output.

## Requirements

1. Decode reports `special`: `"nil"` for `00000000-0000-0000-0000-000000000000`,
   `"max"` for `ffffffff-ffff-ffff-ffff-ffffffffffff`, otherwise `null`. Existing
   `version` and `variant` values for those inputs stay as they are.
2. `namespace: "random"` is accepted for v3 and v5: a v4 UUID is generated from
   `context.randomness` and used as the namespace, and the value echoes it in
   `namespace`. The DU-10 preset list in the README gains this entry. With
   `SeededRandom(1)` the result is deterministic; pin it in
   `fixtures/deterministic.json`.
3. Every existing fixture and headless pin in `fixtures/deterministic.json`
   stays byte-identical. Add fixtures for both items, including `random` with
   a missing name (must still be rejected).

## Checks

```text
node --experimental-strip-types --test plugins/uuid/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin identity.uuid --options '{"mode":"decode","uuid":"ffffffff-ffff-ffff-ffff-ffffffffffff"}'
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin identity.uuid --options '{"version":"v5","namespace":"random","name":"www.example.com"}'
git diff --check
```

## Evidence

Test counts and the two headless outputs.

## Out of scope

Manifest `version` bump, catalog changes, any other option.
