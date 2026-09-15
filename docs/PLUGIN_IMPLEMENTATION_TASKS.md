# Plugin migration and worker packets

Status: implementation queue, 2026-09-16. P00 (rendered interaction baseline), P01 (canonical plugin contract), P02 (SDK and bundled discovery), and the first P03 host-dispatch slice are implemented and validated on the current base. P03 still needs full v2 port/event execution and P04/P05 state/view integration; runtime installation remains later.

Read [PLUGIN_SYSTEM_DESIGN.md](PLUGIN_SYSTEM_DESIGN.md) for ownership and [DEVUTILS_REQUIREMENTS.md](DEVUTILS_REQUIREMENTS.md) for the 27 reference requirement cards. This queue supersedes historical Tasks 24–31 in [WORKER_TASKS.md](../WORKER_TASKS.md). Completed historical work must be reused where it passes the acceptance cases.

## Sequence and dispatch rules

1. Start **P00** to establish a rendered interaction baseline and fix any blocking regressions it reproduces. **P01** can proceed independently on contracts and fixture envelopes.
2. After P01, **P02**, **P03** and **P04** have separate ownership boundaries. Integrate them through reviewed contract changes, never private copies of types.
3. Build **P05** on those foundations and migrate existing tools in **P06**. Keep the current app usable behind compatibility adapters until replacements pass.
4. Run the representative **P07** tool packets against a candidate SDK. Amend contracts centrally when a real tool exposes a gap. These are architecture proofs, not all immediately independent feature assignments.
5. Publish the tested SDK/worker harness and a pinned base commit through **P08**. Then assign remaining tool packets independently, one package/worktree per worker.
6. **P09** is the separate runtime-installation phase. It is needed for adding downloaded packages to an already built app. Build-time discovery alone must not be called runtime installation.

Use Sol at high effort for the host, contract/state changes, hard engine compatibility and isolation work. Terra at medium effort is suitable for bounded package adapters after the SDK gate. These are suggested assignments; no Astra or ultra-effort workers are required. Keep this architect task responsible for contract changes and integration review.

Each handoff must name the actual base commit, one packet, allowed files, dependency completion and required checks. Proposed directories below become real during the owning foundation task; a feature worker must not invent the missing SDK. A separate worktree prevents simultaneous edits to the same checkout. Workers commit their work and report evidence; the integrator reviews and merges.

## P00 — Interaction baseline and migration guard

**Current state:** browser-rendered baseline implemented in [UI_REGRESSION_BASELINE.md](UI_REGRESSION_BASELINE.md); native Windows checklist remains open.

**Owner:** Sol/high. **Dependencies:** none. **Scope:** existing shell tests, `scripts/`, `apps/desktop` interaction harness; production changes only for a reproduced baseline failure.

Build a repeatable rendered test path using the current app DOM and a deterministic mock of the native boundary, plus a documented native Windows smoke path for real bridge/clipboard/drop behavior. Reuse existing reducer/controller tests; a selector or source-code string check is not an interaction test. Record build identity and actual evidence separately for browser and native runs.

**Acceptance:** create a blank tab and type; format/minify/validate JSON; keep three tabs with different tools and drafts; import image and show image at the top; encode/copy complete/decode beyond 64 KiB; drop a file; text-editor-only layout; image/text/error/empty surfaces are exclusive; `[hidden]` works; duplicate operation controls absent. Sample pane bounds across fast and slow jobs: no progress-induced layout shift, caret/focus/scroll preserved, delayed progress appears for a slow job and Cancel works. Neutral surfaces and keyboard access pass at ordinary, scaled and ultrawide sizes. Native-only checks are explicitly pending if they were not performed.

**Non-goals:** plugin protocol implementation or wholesale restyling. Failures become focused fixes, not a reason to replace the shell at once.

## P01 — Canonical versioned contract

**Current state:** implemented in [packages/plugin-contract](../packages/plugin-contract/README.md). The schema generator check, five TypeScript contract tests, four Rust integration tests and workspace tests pass. The package is contract-only; it is not yet imported by the desktop bridge or runtime.

**Owner:** Sol/high. **Dependencies:** none. **Owns:** new `packages/plugin-contract/`, generated Rust/TypeScript types, compatibility fixtures, protocol documentation. Changes to bridge imports only after coordination with P03.

Define the serializable manifest, named input/output ports, options/conditional rules, workspace bindings, capabilities, trigger origin, request identities, result representations, events, diagnostics and provenance from the design. Choose one schema source and reproducible code generation. Represent exact large integers and lengths safely. Separate semantic options from presentation settings and sensitive fields from persisted state. Define v1 normalization and aliases without changing existing public commands.

**Acceptance:** Rust/TypeScript round trips share golden fixtures; invalid versions, duplicate IDs, dangling references, invalid defaults and unknown requested capabilities fail. Fixtures cover JSON, two-source diff, no-input UUID, linked JWT/number fields, selected-range statistics, QR image+template inputs and preview permissions. All 27 requirement cards map to contract fields; unresolved engine semantics are recorded instead of guessed. Define exactly which fields may be extended and which incompatibilities need an API major version.

**Non-goals:** choosing a regex library, migrating production algorithms, or adding a UI framework.

## P02 — Package discovery, scaffold and processor SDK

**Current state:** implemented in [packages/plugin-sdk](../packages/plugin-sdk/README.md) and [packages/plugin-discovery](../packages/plugin-discovery/README.md), with the trusted example under `plugins/examples/`. SDK/discovery tests, the headless example runner, generated catalog command and workspace tests pass. The SDK now exposes bounded range-based `readChunks` with cancellation checks for large processors. This is build-time bundled discovery; runtime installation remains P09.

**Owner:** Sol/high. **Dependencies:** P01. **Owns:** `packages/plugin-sdk/`, package tooling, generated composition crates/import maps, workspace bootstrap and related CI commands.

Create trusted bundled package discovery under `plugins/`. Generate both frontend registrations and native executor composition from canonical manifests before Cargo/Vite builds. Include Cargo dependency/workspace generation and lockfile policy; `build.rs` cannot add unknown dependencies. Implement processor contexts and test doubles for named readers/output sinks, limits, cancellation, deterministic clock/randomness and secret handles. Supply a scaffold with sample fixtures and a headless runner.

**Acceptance:** a worker adds an example package folder and runs one documented command; clean-checkout builds discover its tool in the catalog and executor registry without manual source registration or hand edits to the root dependency list. An invalid package reports a clear discovery/build diagnostic; valid packages remain loadable in development. Packaged releases cannot silently omit a required invalid first-party package. Deterministic ordering, duplicate IDs, unsupported API, malformed entrypoint, path traversal and missing processor are tested. Tests run without Tauri or global shell objects.

**Non-goals:** downloading/installing third-party code at runtime. Document rebuild requirements explicitly.

## P03 — Universal host execution and services

**Current state:** the native host now owns an injected `PluginHost` registry. Existing v1 tools are registered through a compatibility executor adapter, `run_tool` resolves manifests and executors through that registry, and accepted jobs return a typed execution identity. The registry has duplicate-id, dispatch, deterministic ordering, and terminal-claim tests. This is deliberately an incremental seam: the generic scheduler still uses the legacy in-process executor signature while the v2 named-port service implementation is completed in the remaining P03 work.

**Owner:** Sol/high. **Dependencies:** P01; integrate executor interfaces from P02. **Owns:** `apps/desktop/src-tauri/`, native bridge adapter, host service tests; coordinate generated type imports only.

Route requests through an injected executor registry. Keep old commands as normalization adapters. Implement named document/value/secret ports, multiple artifact sinks, bounded reads/projections, typed clipboard/export and instance/job-scoped grants. Reuse immutable sources and safe save logic. Remove tool-ID branching from the generic scheduler; legacy adapter code may temporarily retain it in an explicitly isolated module.

**Acceptance:** JSON and two-input compare traverse the same job machinery; every event/read has instance/generation identity; exactly one terminal event; global/per-instance queues bounded; cancel/error/timeout clean up unpublished artifacts; copy/save readers retain leases during tab closure. Supplied destination paths and capability grants cannot bypass host policy. Full results above preview limits copy/export intact or return an explicit limit. Test native cooperative limits separately from runner-enforced termination; do not claim native panic handling is process isolation.

**Non-goals:** implementing QR/JWT/regex algorithms, theme changes or external runtime installation.

## P04 — Plugin instance state and effect boundary

**Current state:** the reducer now stores the native acceptance identity with each tab's active job and clears it on every generation-changing transition. The controller passes the identity returned by the bridge into the reducer, with a focused stale-generation test. Full canonical revision vectors, named bindings, persistence migrations and scoped service disposal remain to be completed.

**Owner:** Sol/high. **Dependencies:** P01; use P02 test doubles and P03 bridge interface. **Owns:** `apps/desktop/src/workbench/`, state SDK adapters, relevant controller tests.

Separate workspace/document/instance/result/view state. Replace tool-specific fields and compare branches with named bindings and scoped plugin reducers. Reducers return effect intents; one controller executes them. Preserve editor models and undo across rendering. Implement origin/revision-vector guarded derived updates, per-tool state within tabs, state migration/version policy and instance disposal.

**Acceptance:** delayed responses cannot repaint a newer edit, tab, tool, option, selection or plugin version. JWT token edits never trigger signing; a late sign cannot replace a newly pasted token. Base converters update siblings once without feedback loops or caret loss. Generators do not run on render/tab activation. Selection changes do not dirty a document. Timer/listener/worker/result ownership cleans up on close. Secrets are excluded from persistence, ordinary history, logging and errors. Unknown/corrupt persisted state recovers without destroying document drafts.

**Non-goals:** redesigning all current controls or selecting an editor library merely to migrate state.

## P05 — Shared workspaces and typed result surfaces

**Current state:** the shell now derives additional catalog entries and generic text/binary/diff result behavior from host manifests, and per-tab definitions resolve through the controller. Static tool branches still exist for specialized controls and legacy result affordances; the full manifest-bound workspace composition described below remains open.

**Owner:** Sol/high. **Dependencies:** P00–P04 interfaces. **Owns:** new `packages/workbench-ui/`, generic shell composition and central theme tokens. Tool algorithms belong to their packages.

Implement the design's single-editor, transform, annotated, linked-field, compare, generator and media/preview compositions. Shared components provide editor models, typed input actions, forms, conditional options, diagnostics, tree/table/property/diff views and image surfaces. Specialized trusted plugin views get scoped components and SDK services, never global shell selectors. Add a placeholder contract for isolated preview documents; executable preview policy is proven by T08.

**Acceptance:** no shell `if toolId` needed to place these components; a manifest/view binds commands once. Shared layouts keep editor dimensions stable during jobs/errors and preserve focus/undo/scroll. Top-aligned image replaces text, inspector can render a report without an output file, text editor uses full width, two diff inputs have independent actions. Fixed status slot with delayed progress/Cancel causes no layout shift or permanent blank progress panel. Test keyboard resizing, narrow/scaled/ultrawide layouts, IME debounce, labels and hidden states. Windows command labels come from semantic bindings; plugin styles use neutral theme tokens.

**Non-goals:** copying macOS window buttons, an arbitrary HTML-based plugin UI escape hatch, or marking stub renderers ready.

## P06 — Migrate existing packages without losing behavior

**Owner:** separate Terra/medium workers per package after P02–P05; Sol/high integration review. **Scope:** one `plugins/<id>/` at a time, legacy source adapter removals owned by integrator.

Migrate JSON, image/Base64, diff and hash first. Then migrate current CSV/text inspection, URL/HTML/Unicode/JSON escaping, find/replace and cURL tools. Text editor remains a shell workspace service. Preserve stable IDs or tested aliases, defaults, saved tabs, result handles and diagnostics. Improve reference parity only where explicitly included in that tool's packet; migration alone is not parity completion.

**Acceptance:** each package runs in the headless SDK harness and shared UI harness; production shell consumes the generated catalog/executor. Existing tests and P00 scenarios pass through the new path. Remove duplicate manifests and unused `toolViews`/legacy registrations after their replacements are proven. Adding a final small example package needs only its folder and mechanical generated/lock artifacts. No feature disappears behind an unavailable placeholder.

**Non-goals:** parallel edits to shared shell or host files by tool workers.

## P07 — Representative tool proofs and remaining catalogue

**Current state:** `plugins/url/`, `plugins/diff/`, `plugins/hash/`, `plugins/escaping/`, and `plugins/find-replace/` are implemented and discovered from the bundled catalog. URL supports RFC 3986/form transforms and query parsing; diff supports bounded UTF-8 line hunks over named left/right inputs; hash supports verified MD5 and SHA-1/224/256/384/512 outputs with streaming reads; escaping and find/replace have bounded processors and diagnostics. MD2/MD4 remain intentionally omitted until a verified implementation is selected. The headless runner supports repeated named `--input` values for multi-port processors. These packages are currently proven through SDK/headless execution; native Tauri execution and shared manifest workspaces remain the next integration gate.

Each row is an independently bounded feature packet once its prerequisites are satisfied. **Required reading:** the named DU cards (including Required, UX and Acceptance), SDK documentation, and shared UX invariants. **Allowed files:** the listed proposed package plus its fixtures/tests/readme. Shared schema/engine dependencies need integrator review; use a proposed change or blocker note instead of editing shell internals. Final package IDs/paths are locked by P02 before dispatch. 

Every packet delivers manifest/options/samples/detection, processor(s), workspace bindings or scoped view, valid/invalid/boundary fixtures, per-tab and keyboard scenarios, complete copy/export where relevant, engine/version/limits notes, and a gap report. A backend-only implementation is not complete. No packet requires access to the user's F: drive; the requirement cards contain the working brief.

| Packet | Package and reference | Additional scope / proof | Worker |
|---|---|---|---|
| T01 | `plugins/time/` — DU-01 | Timestamp units, arithmetic/date input, local/UTC property fields, captured-clock tests; settle date bounds | Terra/medium |
| T02 | `plugins/json/` — DU-02 | Extend migrated formatter: indentation, explicit permissive modes, diagnostics, JSONPath retained as additional user requirement | Sol/high |
| T03 | `plugins/regex/` — DU-03 | ICU compatibility spike first; flags, captures/report replacement/navigation, zero-width Unicode cases, terminable pathological runner | Sol/high |
| T04 | `plugins/jwt/` — DU-04 | Decode/sign/verify, all reference algorithms, secret inputs, linked edit origin, independent signature vs claim status | Sol/high |
| T05 | `plugins/url/` — DU-05, DU-07 | Two visible tools: encoding and parser; repeated/bracket queries, full URL fields, explicit form encoding policies | Terra/medium |
| T06 | `plugins/base64-text/` — DU-06 | UTF-8 encode/decode, complete result round trip, variant/padding/error policy; separate from existing image codec | Terra/medium |
| T07 | `plugins/text-escaping/` — DU-08, DU-09 | Separate HTML entities and backslash tools, named/numeric/strict modes, explicit grammar; retain JSON/Unicode tools | Terra/medium |
| T08 | `plugins/html-preview/` — DU-11 | Host-isolated HTML/CSS preview; independently gated scripts/network/navigation, teardown/revocation/inspection; host security work owned centrally | Sol/high |
| T09 | `plugins/diff/` — DU-12 | Extend migrated diff: character/word/line, navigation, Swap, rich HTML and Minimal format; resolve reference format before claiming parity | Sol/high |
| T10 | `plugins/format-html/` — DU-13 | Embedded CSS/JS and fragments, whitespace-sensitive semantic fixtures | Sol/high |
| T11 | `plugins/format-css/` — DU-14 | Custom properties, expressions, incomplete rules, shared format/minify views | Terra/medium |
| T12 | `plugins/format-js/` — DU-15 | Syntax-version contract, incomplete input and semicolon/template/regex correctness; never execute source | Sol/high |
| T13 | `plugins/format-xml/` — DU-16 | Mixed content/namespaces/CDATA, no external entity resolution, tolerant vs valid status | Sol/high |
| T14 | `plugins/yaml-json/` — DU-17, DU-18 | Two visible conversion directions, numeric/scalar policies, aliases/tags/multi-doc limits and round trips | Sol/high |
| T15 | `plugins/number-base/` — DU-19 | Linked exact-integer fields, custom base, invalid/intermediate edits; no feedback loop or floating-point coercion | Sol/high |
| T16 | `plugins/uuid/` — DU-10 | First no-input generator proof; v1/3/4/5, namespace/name, batch/case and decode properties | Terra/medium |
| T17 | `plugins/examples/` — DU-20 | All string categories, held-button repeat with keyboard equivalent, append/line/replace with undo | Terra/medium |
| T18 | `plugins/qr/` — DU-21 | Generate and read, typed templates/image inputs, logo/watermark/dimensions, independent decode proof and image clipboard | Sol/high |
| T19 | `plugins/string-inspector/` — DU-22 | Selection-dependent counts/code points/word distribution with explicit grapheme semantics and paged large-input statistics | Sol/high |
| T20 | `plugins/hash/` — DU-23 | All eight algorithms simultaneously, reference vectors, copy fields and case-only presentation updates | Terra/medium |
| T21 | `plugins/jsx/` — DU-24 | HTML/SVG attribute/style/escaping conversion, syntax/folding views, malformed-input fixtures | Sol/high |
| T22 | `plugins/markdown/` — DU-25 | Reuse T08 preview isolation; preview/HTML/HTML+CSS/export-browser refresh, declared dialect | Terra/medium |
| T23 | `plugins/sql/` — DU-26 | Five dialects, keyword case/indentation, quoted identifiers/comments/procedural fixtures | Terra/medium |
| T24 | `plugins/string-case/` — DU-27 | Six cases, acronym settings, line-preserving conversion and Unicode boundary fixtures | Terra/medium |

Before freezing the SDK, prove T03 (annotated editor and interruption), T04/T15 (linked fields), T16 (generator), T08 (preview isolation), and T18 (typed media/multiple inputs). JSON/image/diff from P06 prove existing workflows. Remaining converters can follow the tested shared components. Dependency/library choices are not selected by these assignments: the worker documents suitability and compatibility evidence before integrating one.

## P08 — Freeze the worker-facing SDK and handoff guide

**Owner:** Sol/high. **Dependencies:** P06 and the representative P07 proofs above. **Scope:** SDK version, public exports, generated docs/scaffold, conformance command, CI and worker handoff guide.

**Acceptance:** create a fresh worktree at a recorded commit, scaffold a small tool, implement/test it using SDK docs only, and integrate via discovery with no hand changes outside its package except generated/lock artifacts. Conformance includes manifests, processor fixtures, lifecycle/cancellation/limits, state migrations, keyboard and rendered scenarios. CI rejects shell/peer-plugin imports and unscoped styles in packages. Document exact commands that exist at that commit; do not publish aspirational commands as executable instructions.

Feature-worker handoff template, filled by the integrator:

```text
Implement packet T__ from docs/PLUGIN_IMPLEMENTATION_TASKS.md.
Base commit: <verified SHA>; SDK version: <tested version>.
Requirement cards: <DU IDs from docs/DEVUTILS_REQUIREMENTS.md>.
Allowed files: plugins/<assigned-id>/ and its tests/fixtures/readme.
The SDK and shared views are ready at this base commit. Read their documented
public API; do not import shell, bridge or peer-plugin internals.
Run <actual scaffold/conformance command> plus the named interaction scenarios.
Keep original documents immutable and outputs complete by handle. Use pure
reducers, scoped services and declared limits/capabilities. Report missing SDK
capabilities to the integrator; do not work around them with a host/tool-ID switch.
Commit without merging. Report SHA, tests and rendered/native evidence,
requirement coverage, deviations and any remaining limitations.
```

## P09 — Installable plugin runtime (later delivery stage)

**Owner:** Sol/high with architect review. **Dependencies:** stable envelope and bundled proof; explicit isolation/runtime design decision before production installation.

Compare contained runtimes using real processor needs: regex/crypto/image libraries, worker termination, Windows support and later macOS portability. Implement local-package install/enable/disable/uninstall, validated integrity/API compatibility, staged atomic updates/rollback, state migrations, permission review and contained UI messages. No marketplace or download service is required for the first local-install proof.

**Acceptance:** an existing release build installs a new test tool without rebuilding; rejects incompatible/corrupt packages; a looping/crashing plugin is terminated without losing other tabs; no unauthorized document/network/native access; update rollback works; disabling an in-use plugin handles running jobs and keeps source drafts recoverable. Removing one package does not break catalog startup. Describe actual process/runtime guarantees and test OS-specific restrictions; do not call a cooperative in-process runner a sandbox.

Until this gate passes, the product has a **bundled plugin architecture with automatic build integration**, not a fully dynamic third-party plugin runtime.
