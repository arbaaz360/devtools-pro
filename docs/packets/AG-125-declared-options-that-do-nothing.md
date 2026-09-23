# AG-125 — Declared options that do nothing (DU-26, DU-06, DU-01)

## Branch

`antigravity/AG-125-declared-options` from the latest `origin/main`. Record the base SHA.

## Allowed files

```text
plugins/sql/**
plugins/base64-text/**
plugins/time/**
```

## Required reading

`docs/parity/DU-26.md`, `docs/parity/DU-06.md` and `docs/parity/DU-01.md`
(the audits that found these), the matching cards in
`docs/DEVUTILS_REQUIREMENTS.md`, `docs/WORKER_PROTOCOL.md`, and the
"options belong to an operation" paragraph in
`docs/PLUGIN_HOST_IMPLEMENTATION.md`.

## Goal

Three findings from the parity audits, each small, each the same shape: the
manifest promises something the run does not deliver. A user who picks an
option the app offered is entitled to see it take effect.

### 1. `format.sql` ignores `space-4` (P1)

Confirmed: `space-2` and `space-4` produce **byte-identical** output on a
three-join query — 152 bytes, content hash `e889b50d` — while `tab` differs.
The choice is offered and does nothing.

- Indentation at `space-4` is four spaces per level, `space-2` is two.
- Add fixtures that would fail if the two collapsed again: the same query at
  both widths, asserted on the **output text**, not on the echoed option.

### 2. `encoding.base64-text` declares no `useAsInput` export (DU-06)

The card's "Use as input" action has nothing to bind to. Add `useAsInput` to
the output port's `exports` alongside `copyText` and `save`. Nothing else
changes; the shell reads the export list.

### 3. `time.unix` has no local-time representation (DU-01)

The card asks for local **and** UTC/ISO; every field today is UTC. Add local
fields beside the UTC ones — at minimum `isoLocal`, `dateLocal`, `timeLocal`
and `utcOffsetMinutes` — derived from the injected clock's zone, never from
`Date.now()` directly, so a processor stays deterministic under a fixed
clock. State in the README that the zone is the machine's.

If the SDK's clock cannot report a zone offset, say so in your status and do
**only** parts 1 and 2; do not invent a zone source. That answer is a result,
not a failure.

## Checks

```text
node --experimental-strip-types --test plugins/sql/test.mjs
node --experimental-strip-types --test plugins/base64-text/test.mjs
node --experimental-strip-types --test plugins/time/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin format.sql --operation beautify --input "input=select a.id, b.name from users a join orders b on b.user_id=a.id" --options '{"indent":"space-4"}'
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin time.unix --input "input=1700000000"
pnpm --dir apps/desktop build
git diff --check
```

## Evidence

For part 1, the same query at `space-2` and `space-4` with both outputs and
their byte counts, showing they now differ. For part 2, the manifest line.
For part 3, the fields added and one output showing them, or your reasoning
for skipping it. Test counts for all three packages.

## Out of scope

PL/SQL block restructuring (DU-26's other gap), the acronym list widget
(DU-27, shell work), JWT signing, and anything outside the three packages
named above.
