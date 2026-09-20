# AG-106 — UUID package follow-ups

## Branch

`antigravity/AG-106-uuid-followups` from the latest `origin/main`. Record the
base SHA.

## Allowed files

```text
plugins/uuid/**
apps/desktop/src/plugins/catalog.ts
apps/desktop/src/plugins/engine.worker.ts
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
4. The processor must run in the desktop webview, which has no Node built-ins:
   remove `import { createHash } from "node:crypto"` from `processor.mjs`.
   v5 hashes with `crypto.subtle.digest("SHA-1", ...)` (async, available in
   Node and browsers); v3 needs MD5, which WebCrypto does not provide, so add
   a small MD5 implementation in `plugins/uuid/md5.mjs` (RFC 1321, no
   dependency) with its own test against the RFC test vectors. Then remove
   `"uuid"` from `NODE_ONLY_PACKAGES` in `apps/desktop/src/plugins/catalog.ts`
   and the matching `!.../plugins/uuid/processor.mjs` line in
   `apps/desktop/src/plugins/engine.worker.ts`; both are listed under Allowed
   files for this packet only. `pnpm --dir apps/desktop build` must pass.

## Checks

```text
node --experimental-strip-types --test plugins/uuid/test.mjs
pnpm --dir apps/desktop build
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin identity.uuid --options '{"mode":"decode","uuid":"ffffffff-ffff-ffff-ffff-ffffffffffff"}'
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin identity.uuid --options '{"version":"v5","namespace":"random","name":"www.example.com"}'
git diff --check
```

## Evidence

Test counts and the two headless outputs.

## Out of scope

Manifest `version` bump, catalog changes, any other option.
