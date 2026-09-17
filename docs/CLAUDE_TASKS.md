# Claude worker task pack

These packets are for Claude workers that push a branch for review. Each task is
independent unless its dependency is stated. Start from the latest `origin/main`,
record the exact base SHA, and never merge your own branch.

Every handoff must report the branch, commit SHA, files changed, commands and
results, native or rendered evidence, limitations, and follow-up work.

## CL-001 — Base64 text package quality

**Branch:** `claude/CL-001-base64-text`

**Start:** `origin/main` (`f04c04f` currently). Safe to start immediately.

**Allowed files:** `plugins/base64-text/**` and package-local fixtures/tests only.

**Goal:** Make the isolated Base64 text package a complete reference package.

**Requirements:**

- Cover UTF-8 ASCII, Unicode, empty, multiline, NUL, padded and unpadded input.
- Define standard versus URL-safe alphabet and padding behavior in the README.
- Reject malformed input with actionable diagnostics.
- Add bounded large-input and output-limit tests.
- Keep source bytes immutable and label decoded binary output correctly.
- Use only the public plugin SDK; do not edit the shell, contract, generated
  catalog, Rust host, or root dependencies.

**Checks:** package tests, the SDK headless runner against this manifest, and
`pnpm --dir apps/desktop build` only if generated metadata is changed.

## CL-002 — Streaming benchmark baseline

**Branch:** `claude/CL-002-benchmark-baseline`

**Start:** `origin/main` (`f04c04f` currently). Safe to start immediately.

**Allowed files:** `benchmarks/**`, `README.md`, `ARCHITECTURE.md`, and
`docs/QUALITY_CHECKS.md`.

**Goal:** Produce a reproducible large-file performance report without changing
production behavior.

**Requirements:**

- Reconcile the benchmark command with the current CLI/core output contract.
- Record warmups, median runtime, fixture hashes, measurement method, memory
  caveats, cancellation notes, and machine-readable output.
- Keep generated fixtures/results ignored and do not claim unsupported limits.
- Ensure a clean checkout can run the documented command without network access.

**Checks:** the documented benchmark command, `git diff --check`, and any
existing quality checks touched by the documentation.

## CL-003 — Native bundle and launch regression guard

**Branch:** `claude/CL-003-bundle-guard`

**Start:** `origin/main` (`f04c04f` currently). Safe to start immediately.

**Allowed files:** `scripts/check-desktop-bundle.mjs`,
`apps/desktop/vite.config.ts`, `apps/desktop/src-tauri/tauri.conf.json`,
`docs/UI_REGRESSION_BASELINE.md`, and focused tests for the script.

**Goal:** Prevent a native build from silently loading an unstyled fallback page.

**Requirements:**

- Verify generated `index.html` uses relative CSS/JS asset URLs.
- Verify referenced assets exist and contain the expected shell selectors.
- Add a deterministic failure case for a missing asset or absolute asset path.
- Document the exact Windows build and launch commands.
- Do not redesign the UI or change tool behavior.

**Checks:** `pnpm --dir apps/desktop build`, the script tests, and
`pnpm --dir apps/desktop tauri build --debug --no-bundle` if available.

## CL-004 — Keyboard and accessibility completion

**Branch:** `claude/CL-004-accessibility`

**Start:** latest accepted shared-UI base after AG-003 and AG-004 are merged.
Do not start from an old `main` if those branches have already changed it.

**Allowed files:** `apps/desktop/index.html`, `apps/desktop/src/main.ts`,
`apps/desktop/src/styles.css`, and focused frontend tests.

**Goal:** Make the workbench usable by keyboard and screen readers.

**Requirements:**

- Define predictable Tab/Shift-Tab order for rail, palette, editor, result
  actions, progress, and dialogs.
- Return focus to the palette opener after Escape.
- Add visible focus styles and labels for dynamic controls.
- Announce job status once through an `aria-live` region.
- Ensure hidden controls cannot receive focus.
- Cover keyboard-only open, tool selection, run, copy/save, cancel, and tab close.

**Checks:** shell tests, UI tests, build, and a documented keyboard-only smoke
path. Do not add a UI framework.

## CL-005 — Save document and result UX

**Branch:** `claude/CL-005-save-ux`

**Start:** latest accepted shared-UI base after AG-003 is merged.

**Allowed files:** `apps/desktop/src/main.ts`, `apps/desktop/src/bridge.ts`,
and focused frontend tests. Touch Rust only for a reproducible host contract
bug and report the exact case.

**Goal:** Make saving source documents and derived results predictable.

**Requirements:**

- `Ctrl+S` on a new document opens a save dialog; subsequent saves reuse the
  chosen path.
- Distinguish Save document from Save result in labels and status messages.
- Preserve MIME/extension for text and binary/image results.
- Save complete results even when the UI shows only a bounded preview.
- Cancel leaves state unchanged; collisions and failures show structured errors.
- Never overwrite the source implicitly.

**Checks:** shell tests, build, host tests, and native Windows save/cancel/
collision evidence. Preserve the atomic host save behavior.

## CL-006 — Stable progress and no layout shift

**Branch:** `claude/CL-006-stable-progress`

**Start:** latest accepted shared-UI base after AG-003 is merged.

**Allowed files:** `apps/desktop/src/main.ts`,
`apps/desktop/src/ui/delayedIndicator.ts`, `apps/desktop/src/styles.css`, and
focused tests.

**Goal:** Remove the visible progress-bar flicker reported in the native app.

**Requirements:**

- Reserve a fixed status slot so fast jobs do not change pane geometry.
- Delay progress visibility for short jobs.
- Update status in place and preserve caret, focus, scroll, active tab, and
  result dimensions.
- Show Cancel for slow jobs and replace progress with completion/error in the
  same slot.
- Prevent duplicate indicators on repeated clicks.

**Checks:** shell tests, UI tests, build, and a short native recording at normal,
scaled, and ultrawide sizes.

## Dispatch rules

Start CL-001, CL-002, and CL-003 now; they have disjoint ownership. Hold
CL-004–CL-006 until the shared compare/progress work is accepted, then give each
worker the exact accepted commit as its base. If a worker discovers that an
allowed file has changed since the base, it must stop and report the conflict
instead of force-merging another worker's work.

Common prompt suffix:

```text
Work only within the allowed files and task scope. Read ARCHITECTURE.md,
Tool Contract and Document Model.md, and the referenced task packet first.
Keep source documents immutable, outputs complete by handle, and limits,
cancellation, structured errors, and provenance intact. Add meaningful tests.
Commit and push only your branch; do not merge. Report SHA, checks, evidence,
limitations, and any requested follow-up.
```
