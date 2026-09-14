# DevTools Pro architecture

This document records the decisions behind the current native workbench and the boundary we want future tools to use.

The complete parity target and a plain-language explanation of the building blocks live in [PARITY_AND_BUILDING_BLOCKS.md](docs/PARITY_AND_BUILDING_BLOCKS.md). This architecture document describes implementation boundaries; that roadmap describes how we will grow them to cover the full DevUtils catalogue.

## Why this technology

- **Rust core** (`crates/devtools-core`) owns file inspection and transformations. It gives predictable memory use, cancellation, progress reporting, strong error types, and good performance for 50–250 MB files without pushing whole documents into the browser.
- **Tauri 2** (`apps/desktop/src-tauri`) is the desktop shell. It provides a small native executable, native file dialogs, window lifecycle handling, and a narrow command/event bridge without requiring a local web server.
- **TypeScript and HTML/CSS** (`apps/desktop/src`) own presentation and interaction. The web layer can iterate quickly while the expensive and security-sensitive file work stays in Rust.
- **Cargo workspace** keeps the reusable core and CLI independently testable. The CLI is useful for benchmarks and automation; the desktop shell is an adapter over the same core APIs.

The product is intentionally offline-first. Network access is not needed for the JSON workflow, and the original source is opened read-only. Generated results are written to an application-owned temporary file, previewed in the right pane, and saved only after an explicit user action.

## Workspace layout decision

The desktop workbench keeps tools and commands in a narrow left rail while the active document and result panes share the remaining width. The result pane is a flex column: status, metrics, and save controls stay compact, while the formatted preview owns the remaining height and scrolls internally only when its content exceeds the viewport. This keeps the output visible after an operation and avoids wasting the lower part of the workspace on an empty fixed-height box.

## Current module boundaries

```text
UI (TypeScript)
  └─ bridge.ts: typed invoke/event adapter
      └─ Tauri commands/events (main.rs)
          └─ devtools-core: streaming readers, validators, transforms
              └─ filesystem / OS
```

`main.rs` is the host adapter: it validates paths, tracks open documents and jobs, enforces concurrency limits, translates progress into UI events, and manages temporary result files. The core does not know that Tauri or a browser exists. The CLI also calls the core directly.

The initial tool contract is described in [Tool Contract and Document Model.md](<Tool Contract and Document Model.md>). It defines immutable documents, typed ports, streaming/cancellation capabilities, provenance, and renderer hints. The implementation is intentionally smaller than that long-term contract today: the current desktop bridge still uses a few JSON-specific commands and a bounded text preview.

## Adding a tool in isolation

A new capability should be implemented in a small core module with no UI imports:

1. Define its input/output types and options in the tool contract.
2. Implement a deterministic `run` function in `crates/devtools-core`, using bounded reads, progress callbacks, cancellation, and structured errors where appropriate.
3. Add focused Rust tests and a CLI path when the tool benefits from automation or benchmarks.
4. Add a manifest describing the tool, accepted formats, limits, and renderer (`builtin_manifests()` is the current registry).
5. Add one Tauri command or a generic job adapter only when the operation needs native capabilities. Keep path validation, temporary files, and permissions in the host layer.
6. Add a typed function and view in `bridge.ts` and the UI. The view should consume a document/result handle and request bounded ranges or a table/tree projection instead of receiving an unbounded string.

For **image to Base64 and Base64 to image**, the core would accept a `Bytes` document and emit either a text document or a generated binary document. The UI could render a data-URI preview or offer Save. The same job, cancellation, size limit, and temporary-result path used by JSON would be reusable; only the codec and renderer would be new.

## How decoupled is it today?

The Rust core, CLI, and Tauri host are meaningfully decoupled and can be tested independently. File processing is already isolated from the UI, which is the important foundation for large-file tools.

The desktop UI is **not yet a dynamic plugin system**. Tool navigation, command-palette entries, and views are currently registered in `main.ts`, while the backend registry is only partially surfaced. Adding a tool today therefore requires a small amount of deliberate wiring in both Rust and TypeScript; it is not yet “drop a folder in and it appears.”

The desktop shell keeps this boundary explicit through `apps/desktop/src/toolViews/registry.ts`: each manifest resolves to an isolated `ToolView`, or to a safe unavailable state when no view is bundled. JSON, text, hash, image, cURL, and diff controls live in separate view modules. `resultLifecycle.ts` binds each job to its source document, operation, tool, renderer, and revision. Tool and tab transitions invalidate that revision, so late progress events and bounded preview reads cannot repaint a newer workspace. Result rendering follows `RendererKind` and MIME metadata; binary image output uses the binary preview command and never decodes bytes as text, while copy is hidden for binary results. Save dialogs receive a view-provided suggestion rather than a shell switch on tool ids.

The generic `run_tool` host path now consumes a `ToolManifest` id, typed document handles, and an options payload, while the TypeScript registry resolves isolated views by manifest id. The remaining step toward a fully dynamic plugin system is discovery and loading of external manifests/views; today, bundled tools still need deliberate registration and a host adapter for native capabilities. New tools should follow the boundaries above and avoid importing or mutating another tool's state.

## Non-negotiable extension rules

- Never load an entire large input into the webview merely to render it.
- Keep source documents immutable; publish generated results atomically and only save them explicitly.
- Make cancellation and resource limits part of every long-running tool.
- Declare network, filesystem, and secret requirements in the manifest; network operations require an explicit user action.
- Preserve provenance so a result can identify its source document and operation.
- Prefer mature, audited codecs and parsers for security-sensitive formats.
