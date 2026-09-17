# Antigravity worker packets

These packets are designed for an external coding worker that can create a GitHub branch and push commits for review. They are deliberately small and isolated from the plugin contract and native host registry.

## Common handoff rules

Use this repository and start every packet from base commit `3fa81ac` (or the latest `origin/main` if the integrator explicitly gives a newer commit).

```powershell
git fetch origin
git switch --create antigravity/<packet-id>-<short-name> <base-commit>
```

The worker must:

1. Work only on the packet's allowed files. If another file is required, stop and report why instead of widening scope.
2. Keep the native host local-only and preserve source immutability, cancellation, limits, structured errors, and complete-result copy/save behavior.
3. Add or update focused tests. Do not replace an interaction test with a selector or source-string check.
4. Run the packet checks and `pnpm --dir apps/desktop build`.
5. Commit with the packet ID in the message and push only its branch. Never push `main` and never merge its own branch.
6. Report: branch, commit, files changed, tests and commands with results, manual/native steps, screenshots or recordings, known limitations, and any follow-up needed.

The integrator reviews the branch, runs the native Windows check, and merges only after acceptance. A worker should not change plugin contract schemas, generated catalog rules, Cargo dependencies, or `apps/desktop/src-tauri/src/plugin_host.rs` for these packets.

## AG-001 — Native drag-and-drop import

**Branch:** `antigravity/AG-001-native-drag-drop`

**Goal:** Make dropping a file on the native window reliably open it in a new tab without disturbing another tab.

**Allowed files:** `apps/desktop/src/main.ts`, `apps/desktop/src/workbench/controller.ts`, `apps/desktop/src/styles.css`, and focused tests under `apps/desktop/src/`.

**Work:** Reproduce the current Windows `tauri://drag-drop` path with a text, JSON, and image fixture. Fix duplicate event handling, stale active-tab attachment, missing drag-over feedback, and drops onto a dirty tab. Browser preview behavior must remain deterministic when the native event is unavailable.

**Acceptance:** dropping a supported file creates or activates one new tab, detects the correct tool, preserves the previous tab's text/tool/result/dirty state, and shows a clear error for an unsupported or unreadable path. The drag-over class is removed on every exit, cancel, and error. A single drop produces one import job.

**Checks:** `pnpm --dir apps/desktop test:shell`, `pnpm --dir apps/desktop test:ui`, `pnpm --dir apps/desktop build`, plus a native Windows drop check with the path and resulting tab recorded.

**Non-goals:** changing the Tauri capability policy, adding a file watcher, or redesigning the sidebar.

## AG-002 — Save document and result UX

**Branch:** `antigravity/AG-002-save-ux`

**Goal:** Make `Ctrl+S`, Save document, and Save result predictable for blank, imported, transformed, binary, and large documents.

**Allowed files:** `apps/desktop/src/main.ts`, `apps/desktop/src/bridge.ts`, and focused frontend tests. Edit `apps/desktop/src-tauri/src/main.rs` only if a reproducible host contract bug blocks the UI; include the exact failing case in the handoff.

**Work:** Exercise save dialogs for a new document, an imported file, a formatted JSON result, an image result, and a result larger than the preview limit. Preserve the existing atomic/collision-safe host behavior. Make the UI distinguish saving the source document from saving a derived result, retain the correct extension/MIME, and keep the source tab unchanged after a result save.

**Acceptance:** `Ctrl+S` on an unsaved editable document opens a save dialog; saving again uses the chosen path; Save result never overwrites the source or an existing destination silently; cancel leaves state unchanged; binary results are saved as bytes; complete output is saved even when only a bounded preview is displayed; failed saves show a structured error and no stale success banner.

**Checks:** `pnpm --dir apps/desktop test:shell`, `pnpm --dir apps/desktop build`, `cargo test -p devtools-desktop`, and a native Windows save/cancel/collision check.

**Non-goals:** changing atomic rename policy, adding cloud storage, or changing result formats.

## AG-003 — Complete Diff & Compare workspace

**Branch:** `antigravity/AG-003-diff-workspace`

**Goal:** Finish the two-source comparison interaction so it behaves like a real editor tool instead of a generic source/result view.

**Allowed files:** `apps/desktop/src/toolViews/diffView.ts`, `apps/desktop/src/toolViews.css`, `apps/desktop/src/styles.css`, `apps/desktop/src/main.ts`, and focused tests under `apps/desktop/src/`.

**Work:** Verify that both left/original and right/revised editors accept typing, clipboard input, and independent file selection. Preserve each source label and dirty state. Make Compare require both sources and report a useful empty-source error. Render a readable line/word/character result with change navigation or a clear disabled state; keep raw diagnostic JSON behind an explicit details affordance.

**Acceptance:** two text documents can be compared without replacing the active workbench document; editing either side updates only that side; Compare produces identical, insertion, deletion, and replacement cases; Swap exchanges inputs and labels; switching tabs restores the same pair and result; the editor panes use available height without a useless blank result surface.

**Checks:** `pnpm --dir apps/desktop test:shell`, `pnpm --dir apps/desktop test:ui`, `pnpm --dir apps/desktop build`, and a native compare check with two files.

**Non-goals:** changing the Rust diff algorithm, adding a new diff dependency, or claiming exact DevUtils formatting parity without fixtures.

## AG-004 — No-layout-shift progress feedback

**Branch:** `antigravity/AG-004-stable-progress-ui`

**Goal:** Remove the progress-bar flicker and prevent job status from changing neighboring dimensions.

**Allowed files:** `apps/desktop/src/main.ts`, `apps/desktop/src/ui/delayedIndicator.ts`, `apps/desktop/src/styles.css`, and focused tests under `apps/desktop/src/`.

**Work:** Trace fast and slow job transitions. Keep a reserved status slot with stable height, delay progress visibility for short jobs, and update text/progress in place instead of inserting/removing layout rows. Preserve focus, caret, scroll position, active tab, and result pane size across start/progress/completion/error/cancel.

**Acceptance:** a fast JSON/hash operation produces no visible layout jump; a slow operation shows delayed progress and Cancel in the reserved slot; completion replaces progress in the same slot; errors do not flash a previous success; repeated clicks do not create duplicate indicators; screenshots at ordinary, scaled, and ultrawide sizes show stable pane geometry.

**Checks:** `pnpm --dir apps/desktop test:shell`, `pnpm --dir apps/desktop test:ui`, `pnpm --dir apps/desktop build`, and a short native screen recording proving fast and slow transitions.

**Non-goals:** changing host progress event semantics or hiding legitimate cancellation feedback.

## AG-005 — Dark native-density visual pass

**Branch:** `antigravity/AG-005-dark-density`

**Goal:** Restore the charcoal DevUtils-inspired visual language and remove accidental blue-heavy or web-page-like surfaces without changing behavior.

**Allowed files:** `apps/desktop/src/styles.css`, `apps/desktop/src/toolViews.css`, and visual test fixtures/documentation. Do not edit TypeScript or Rust unless a markup defect is proven and reported.

**Work:** Use the existing semantic tokens and component structure. Tune surface/background/border/text colors, typography, spacing, focus rings, sidebar density, tab strip, editor/result split, buttons, dialogs, and empty/error/success states. Keep Windows keyboard labels and native dialogs. Check that image results align at the top and text-editor mode can use the full work area.

**Acceptance:** no bright blue page background, no unstyled fallback controls, readable contrast for normal and disabled states, visible keyboard focus, stable editor/result dimensions, top-aligned media, and responsive behavior at ordinary, scaled, and ultrawide sizes. Existing interaction tests remain green.

**Checks:** `pnpm --dir apps/desktop test:ui`, `pnpm --dir apps/desktop build`, plus before/after screenshots at the three target sizes.

**Non-goals:** copying macOS window chrome, introducing a CSS framework, or changing tool placement/behavior.

## AG-006 — Base64 text plugin package quality

**Branch:** `antigravity/AG-006-base64-text-package`

**Goal:** Make the isolated `plugins/base64-text` package complete and reviewable as the reference string codec package.

**Allowed files:** `plugins/base64-text/**` and package-local fixtures/tests only. Do not edit the shell, generated catalog, plugin contract, Rust host, or root dependencies.

**Work:** Review the manifest, processor, and SDK usage for UTF-8 text encode/decode, standard and URL-safe/padding policy, whitespace handling, malformed input diagnostics, and binary-output labeling. Add deterministic vectors and bounded large-input tests. Document the exact policy and limits in the package README.

**Acceptance:** ASCII, Unicode, empty, multiline, padded, unpadded, URL-safe, whitespace, malformed, and non-UTF-8 cases have explicit expected results. The package passes the headless runner and remains independently testable without Tauri. No source evaluation, silent lossy conversion, or unbounded allocation is introduced.

**Checks:** the package's documented test command, the SDK headless runner against its manifest, and `pnpm --dir apps/desktop build` only if the worker changes generated package metadata (otherwise state that the shell was intentionally not rebuilt).

**Non-goals:** wiring the package into the native executor or redesigning the shared Base64 image codec.

## AG-007 — Native acceptance evidence packet

**Branch:** `antigravity/AG-007-native-evidence`

**Goal:** Produce a repeatable native smoke checklist and evidence bundle for the remaining MVP gates.

**Allowed files:** `docs/**`, `apps/desktop/tests/**` if a small harness helper is needed, and no production source unless a test exposes a focused bug (report that bug instead).

**Work:** Run the current Windows executable against drag/drop, save/cancel/collision, two-file diff, image/Base64 round-trip, large preview/copy, cancellation, and ordinary/scaled/ultrawide layouts. Record commit, OS/build, fixture hashes, exact steps, pass/fail, and screenshot/recording paths. Convert any deterministic browser-mock gap into a focused reproducible test without faking native evidence.

**Acceptance:** the resulting document clearly separates browser tests from native evidence, names every unresolved failure, and gives a single command or checklist another reviewer can repeat. Do not mark an untested flow as passed.

**Checks:** existing browser test/build commands plus the documented native executable run.

**Non-goals:** changing product behavior or declaring MVP complete by documentation alone.

## Suggested dispatch order

Dispatch AG-001, AG-003, AG-004, AG-005, and AG-006 in parallel; they have disjoint production ownership. Dispatch AG-002 after confirming the host save tests remain green. Dispatch AG-007 after those branches are available so its evidence reflects the candidate merge.

