# DevTools Pro worker task pack

This file is a queue of self-contained tasks for lower-cost worker models. Each task is deliberately bounded so a worker can complete it without understanding the whole engine. Give a worker one task at a time and require it to report changed files, tests run, and any follow-up work.

## Progress ledger (14 September 2026)

- Completed and pushed: Tasks 00A, 00, 01–15, 16, 17, 18, and the quality-gate portion of 21.
- Core compare hardening is also merged in `8a19d05`, with explicit input, line, hunk, output, and cancellation checks.
- In progress: Task 20 (image codec and preview coverage), assigned to a Terra medium worker.
- Still queued: the benchmark report and extension/release documentation. Keep those tasks separate from feature work so their measurements and guidance remain reproducible.

## Shared worker contract

Before changing code, read:

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [Tool Contract and Document Model.md](Tool%20Contract%20and%20Document%20Model.md)
- The task's listed files

Workers must follow these rules:

1. Keep source documents immutable. Generated output is a temporary result until the user explicitly saves it.
2. Do not send an entire large file to the webview. Use bounded previews, handles, ranges, or summaries.
3. Keep processing in `crates/devtools-core`. Keep filesystem permissions, dialogs, jobs, and temporary files in the Tauri host.
4. Do not add network access, telemetry, or new dependencies without stating why and adding a test.
5. Preserve cancellation, progress reporting, resource limits, structured errors, and provenance for long-running work.
6. Do not redesign unrelated tools. A task is complete only when its acceptance criteria and tests pass.

## Task 00A — Host persistence and job safety

**Goal:** Make the native host the only place that can persist files and make saves atomic.

**Files:** `apps/desktop/src-tauri/src/main.rs`, `apps/desktop/src/bridge.ts`.

**Work:** Remove the optional output path from `start_operation`; transformations must always write to an app-owned temporary result. Make `save_result` reject source/open-file collisions and write through a sibling temporary file followed by an atomic rename. Add focused tests or a documented manual check for source immutability, existing-destination behavior, and cleanup after a failed save.

**Acceptance:** A webview caller cannot choose an arbitrary transform destination. A failed or interrupted save leaves no partial destination. The original source remains byte-for-byte unchanged. Existing JSON workflows and `cargo test --workspace` pass.

**Non-goals:** Multi-window routing, sandbox policy redesign, or a new tool protocol.

## Task 00 — Shell regression hardening

**Goal:** Make the existing desktop shell reliable across empty, loading, success, failure, cancel, and repeated-open states.

**Files:** `apps/desktop/index.html`, `apps/desktop/src/main.ts`, `apps/desktop/src/bridge.ts`, `apps/desktop/src/styles.css`.

**Work:** Add or repair state transitions without changing Rust commands. Verify command buttons, command palette, tool selection, tabs, result preview, save action, and error banners never reference missing DOM elements. Wire every advertised interaction: drag/drop, the shown open-file shortcut, sidebar collapse, tool search, palette arrow/Enter navigation, and tab close. Keep the left tool rail and right result workspace responsive.

**Acceptance:**

- Opening a valid JSON file automatically shows a result on the right.
- Format, minify, cancel, failure, and reopening another file leave no stale result or disabled button.
- Command palette actions produce the same result as toolbar actions.
- Drag/drop, open-file shortcut, collapse, search, palette keyboard navigation, and tab close all work or their misleading affordance is removed.
- Tool navigation never throws when selecting an implemented or unavailable tool.
- `pnpm --dir apps/desktop build` passes.

**Non-goals:** No new tool implementation, no backend protocol changes, no visual redesign outside the existing shell.

## Task 01 — Generic tool manifest and runner boundary

**Goal:** Reduce the amount of per-tool wiring needed in the desktop app.

**Files:** `crates/devtools-core/src/`, `apps/desktop/src-tauri/src/main.rs`, `apps/desktop/src/bridge.ts`, `apps/desktop/src/main.ts`, `Tool Contract and Document Model.md`.

**Work:** Define a serializable manifest containing tool id, label, input kinds, limits, capabilities, operations, and renderer hint. Add a generic host entry point that accepts a document handle, operation id, and options payload, while preserving the current JSON commands as compatibility adapters. Add a UI registry keyed by tool id and renderer kind.

**Acceptance:** Existing JSON inspect/format/minify behavior is unchanged. A test-only sample tool can register through the generic path without editing the JSON implementation. Invalid tool ids and unsupported input kinds return structured errors. Core and desktop builds pass.

**Non-goals:** No dynamic third-party plugin loading, no network marketplace, no removal of existing compatibility commands.

## Task 02 — Image to Base64

**Goal:** Add a local image-to-Base64 transformer using the existing document/job/result model.

**Files:** New core module under `crates/devtools-core/src/`, core tests, CLI adapter if useful, manifest, and the smallest required desktop bridge/view files.

**Work:** Accept an image `Bytes` document, detect MIME type from trusted file signatures or an explicit user-selected type, and emit a text result containing Base64 plus a data-URI option. Enforce a configurable input-size limit, cancellation checks, progress, and provenance.

**Acceptance:** PNG and JPEG fixtures round-trip through decoding; invalid bytes produce a structured error; output never includes unrelated source bytes; large input is bounded by the declared limit; result is previewed on the right and can be saved explicitly.

**Non-goals:** Image editing, remote uploads, broad MIME sniffing, or browser-side full-file loading.

## Task 03 — Base64 to Image

**Goal:** Decode Base64 text into a temporary binary image result.

**Files:** New core module and tests; manifest; renderer/bridge files only where required.

**Work:** Accept plain Base64 and `data:image/...;base64,` input, validate padding and decoded size before allocation, verify the declared or detected image type, and produce a temporary result document with preview metadata. Reuse the existing save-result flow.

**Acceptance:** Valid PNG/JPEG inputs decode and save correctly; malformed Base64, mismatched MIME, oversized input, and decompression bombs fail safely; source text remains unchanged; cancellation and progress work for large input.

**Non-goals:** Arbitrary binary preview, image transcoding, or network retrieval.

## Task 04 — Text utilities

**Goal:** Add isolated encode/decode operations for URL, HTML, and Unicode escape text.

**Files:** New core module and tests; manifest; small UI view and bridge additions.

**Work:** Implement explicit operation ids with UTF-8 handling and clear invalid-input diagnostics. Keep transformations deterministic and stream-friendly where practical.

**Acceptance:** Each operation has round-trip tests, malformed input tests, bounded output limits, and a right-pane result with copy/save controls. Existing JSON behavior is unchanged.

**Non-goals:** Regex replacement, rich text editing, or implicit encoding guesses.

## Task 05 — Hash generator

**Goal:** Compute SHA-256 and SHA-512 checksums for local files.

**Files:** New core module and tests; manifest; bridge/view additions.

**Work:** Stream bytes from the document source, report progress, support cancellation, and return a small text result containing algorithm, digest, byte count, and source provenance.

**Acceptance:** Digests match known vectors and an external reference for a large fixture. Memory remains bounded, cancellation is observable, and the result can be copied or saved.

**Non-goals:** Password cracking, HMAC key storage, or remote checksum services.

## Task 06 — Text diff and compare

**Goal:** Compare two bounded text documents and show useful differences.

**Files:** New core compare module and tests; two-document host wiring; diff view.

**Work:** Define an input pair with encoding/newline normalization options. Return a structured diff summary and renderer-friendly hunks. Preserve original files and keep large-file limits explicit.

**Acceptance:** Identical, insertion, deletion, replacement, and newline-only fixtures are covered. The UI identifies both sources, displays hunks without loading unbounded content, and reports limit/cancellation errors.

**Non-goals:** Three-way merge, binary diff, or editing either source.

## Task 07 — cURL to code

**Goal:** Parse common cURL commands and generate code snippets locally.

**Files:** New parser/generator module and tests; manifest; focused UI view.

**Work:** Support URL, method, headers, query parameters, JSON body, and common quoting forms. Generate at least fetch and Python requests output. Reject ambiguous or unsafe shell constructs with actionable diagnostics.

**Acceptance:** Fixtures cover GET, POST JSON, headers, query strings, escaped quotes, and malformed commands. Generated code is deterministic and visibly labeled with its source fields.

**Non-goals:** Executing requests, resolving variables, or contacting the network.

## Task 08 — Command palette and tool registry UX

**Goal:** Make every registered tool discoverable from the left rail and command palette without duplicated hard-coded lists.

**Files:** `apps/desktop/src/main.ts`, `apps/desktop/src/bridge.ts`, `apps/desktop/index.html`, `apps/desktop/src/styles.css`.

**Work:** Consume the manifest/registry from Task 01, render tool groups and commands from one source, add keyboard navigation and empty-search states, and preserve the current JSON shortcuts.

**Acceptance:** Adding a test manifest entry creates one rail item and one palette command. Search, Enter, Escape, arrow navigation, unavailable-tool messaging, and responsive collapse work without console errors.

**Non-goals:** New processing logic, server-side search, or third-party extensions.

## Task 09 — Large-file and shell acceptance suite

**Goal:** Turn the core shell guarantees into repeatable checks for every future worker contribution.

**Files:** `crates/devtools-core` tests, desktop smoke scripts, `benchmarks/`, and CI documentation.

**Work:** Add fixtures for valid/invalid JSON, 50–250 MB files, cancellation, malformed encodings, and temporary-result cleanup. Add a smoke checklist that exercises open → automatic result → format/minify → save copy → reopen.

**Acceptance:** Tests are deterministic, do not require network access, record limits and timings, and fail when source files are modified or whole-file previews are sent to the UI.

**Non-goals:** Performance claims without measurements, cloud CI credentials, or screenshot-only validation.

## Tomorrow's follow-on tasks

These tasks assume Tasks 00A–09 and the current desktop integrations are complete. They are intentionally bounded so a worker can implement one task without understanding the entire engine. Keep each task on its own branch or worktree and merge only after its acceptance checks pass.

## Task 15 — Native packaging and visual regression guard

**Goal:** Prevent the desktop app from silently falling back to an unstyled HTML page.

**Files:** `apps/desktop/vite.config.ts`, `apps/desktop/src/styles.css`, `apps/desktop/src/main.ts`, `apps/desktop/src-tauri/tauri.conf.json`, a new `benchmarks/` or `scripts/` smoke check.

**Work:** Keep Vite assets relative for the Tauri protocol. Add a repeatable build check that confirms the generated index references existing CSS/JS assets and that the stylesheet contains the shell layout selectors. Document how to rebuild and launch the native preview.

**Acceptance:** `pnpm --dir apps/desktop build` passes; `pnpm --dir apps/desktop tauri build --debug --no-bundle` produces a runnable executable; the generated index uses relative asset URLs; the native window loads `.app-shell`, `.sidebar`, and `.workspace` with flex layout.

**Recommended worker:** Terra, medium effort.

**Non-goals:** Redesigning the visual system or changing tool behavior.

## Task 16 — Manifest-driven view registration

**Goal:** Remove the remaining hard-coded tool availability and view branching from `main.ts`.

**Files:** `apps/desktop/src/main.ts`, `apps/desktop/src/bridge.ts`, a new `apps/desktop/src/toolViews/` directory, and `ARCHITECTURE.md`.

**Work:** Define a small `ToolView` interface keyed by manifest id/renderer. Move JSON, text, hash, image, cURL, and diff control creation into isolated view modules. Keep the existing host commands and result model unchanged. Unknown manifests must render a safe unavailable state.

**Acceptance:** Removing a tool view module makes only that tool unavailable; adding a test manifest plus view creates one rail item, palette commands, controls, and renderer without editing unrelated tool code. `pnpm build` passes and existing workflows behave identically.

**Recommended worker:** Sol, high effort.

**Dependency:** Task 01 and current manifest registry.

**Non-goals:** Third-party plugin loading or runtime code execution.

## Task 17 — Shared result renderer and lifecycle

**Goal:** Make every tool show results through one consistent right-pane lifecycle.

**Files:** `apps/desktop/src/main.ts`, `apps/desktop/src/bridge.ts`, `apps/desktop/index.html`, `apps/desktop/src/styles.css`.

**Work:** Extract status, metrics, bounded preview, diff, binary-image preview, copy, save, cancellation, and stale-result cleanup into a shared result controller. Render by `RendererKind`; never decode binary output as text. Preserve provenance and result MIME metadata.

**Acceptance:** JSON, hash, text, cURL, diff, image-to-Base64, and Base64-to-image all show a successful result in the same right-pane structure. Switching tools or tabs cannot leave stale output visible. Copy is hidden for binary results; image previews are bounded.

**Recommended worker:** Sol, high effort.

**Dependency:** Task 16 is helpful but not required.

**Non-goals:** New transformations or changes to Rust core algorithms.

## Task 18 — Accessibility and keyboard completion

**Goal:** Make the workbench usable without a mouse and robust for screen readers.

**Files:** `apps/desktop/index.html`, `apps/desktop/src/main.ts`, `apps/desktop/src/styles.css`.

**Work:** Add a clear focus model for the rail, palette, source controls, result actions, and progress/cancel states. Implement predictable Tab/Shift-Tab order, focus return after palette close, visible focus styles, labels for dynamic controls, and keyboard activation for tool selection and compare sources.

**Acceptance:** A documented keyboard-only smoke path can open a file, choose a tool, run it, copy/save a result, cancel a job, and close a tab. `aria-live` status updates are announced once and no focus lands on hidden controls.

**Recommended worker:** Terra, medium effort.

**Non-goals:** Changing the shell layout or adding a component framework.

## Task 19 — Compare scalability and bounded previews

**Goal:** Keep Text Diff responsive and bounded as inputs approach the declared limit.

**Files:** `crates/devtools-core/src/compare.rs`, `apps/desktop/src-tauri/src/main.rs`, compare UI files, acceptance tests.

**Work:** Enforce limits before allocation, add cancellation checks during expensive diff stages, and make hunk/output limits explicit in diagnostics. Keep the UI on structured hunks and bounded previews.

**Acceptance:** Oversized files fail before full buffering; cancellation completes within a documented bound; identical, large, and high-change inputs produce structured summaries without an unbounded webview payload. Existing compare behavior remains compatible.

**Recommended worker:** Sol, high effort.

**Dependency:** Current Task 06 compare implementation.

**Non-goals:** Three-way merge, binary diff, or editing sources.

## Task 20 — Image codec format and preview coverage

**Goal:** Make image workflows clearer while keeping validation strict.

**Files:** `crates/devtools-core/src/image_base64.rs`, `crates/devtools-core/src/base64_image.rs`, image UI/bridge files, fixtures.

**Work:** Decide and document the supported MIME set. Improve result metadata and save-extension selection for each supported format. Add representative PNG/JPEG fixtures and explicit unsupported-format diagnostics; retain bounded binary preview behavior.

**Acceptance:** Supported formats encode/decode, preview, and save with the correct MIME and extension. Unsupported, mismatched, oversized, and malformed inputs return structured errors. No browser-side full-file read is introduced.

**Recommended worker:** Terra, medium effort.

**Non-goals:** Image editing, transcoding, GIF/WebP support unless explicitly added to the manifest and tests.

## Task 21 — CI quality gate and worker check script

**Goal:** Make every worker contribution verifiable before merge.

**Files:** `.github/workflows/`, `scripts/`, `README.md`, `WORKER_TASKS.md`.

**Work:** Add a GitHub Actions workflow for Rust tests, desktop TypeScript build, smoke-shell, formatting/toolchain checks where available, and `git diff --check`. Provide one local command that runs the same checks and records clear failure output.

**Acceptance:** A clean checkout passes the workflow without secrets or network-dependent product tests. A deliberately failing test blocks the workflow. Worker handoff instructions reference the command.

**Recommended worker:** Terra, medium effort.

**Non-goals:** Publishing installers or adding telemetry.

## Task 22 — Streaming benchmark report

**Goal:** Turn the existing large-file harness into a repeatable engineering baseline.

**Files:** `benchmarks/`, `README.md`, `ARCHITECTURE.md`, fixture manifests.

**Work:** Reconcile the benchmark harness with the current CLI/core output contract. Record median runtime, peak memory method, fixture hashes, warmups, cancellation notes, and known measurement limits. Keep generated fixtures/results ignored.

**Acceptance:** The documented command completes on a clean checkout, emits machine-readable and human-readable summaries, and does not claim unsupported performance guarantees.

**Recommended worker:** Terra, low effort.

**Non-goals:** Optimizing algorithms or changing production limits.

## Task 23 — Extension guide and release checklist

**Goal:** Make the architecture understandable to a worker or future maintainer.

**Files:** `ARCHITECTURE.md`, `WORKER_TASKS.md`, `README.md`, a new `docs/RELEASE_CHECKLIST.md`.

**Work:** Document the current semi-dynamic boundary honestly, the exact steps for adding a core tool, manifest, host adapter, view, renderer, tests, and worker branch. Include native preview rebuild instructions and a checklist for source immutability, bounded payloads, cancellation, errors, and save safety.

**Acceptance:** A new worker can implement a sample tool by following the guide; all commands and paths are valid; limitations are explicit and match the code.

**Recommended worker:** Terra, low effort.

**Non-goals:** Implementing a new tool or claiming a fully dynamic plugin system.

## Tomorrow's recommended order

1. Task 15 (packaging guard) and Task 21 (CI gate) establish a safe baseline.
2. Task 17 (shared result lifecycle) improves the current user-facing shell.
3. Task 16 (view registration) reduces future worker context and merge conflicts.
4. Task 18 (accessibility) and Task 19 (compare scalability) harden daily use.
5. Tasks 20, 22, and 23 complete format coverage, measurement, and maintainer guidance.

Copy one task above to a worker and add:

```text
Repository: C:/Users/ASUS/Projects/Standalones/TheDevToolsPro
Work only within the files and scope named in the task.
Do not wait for more context. Inspect the referenced architecture and contract docs first.
When finished, report: files changed, tests run and results, acceptance criteria checked, and any limitation or follow-up.
```
