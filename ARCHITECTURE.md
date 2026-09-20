# DevTools Pro architecture

Implementation audit and design direction, 2026-09-15. The application is a Rust/Tauri desktop workbench with a TypeScript UI. It is **not yet a fully dynamic plugin system**: packages are discovered at build time, and there is no runtime installation.

Since 2026-09-20 the two trusted engines of the plugin design are both live. The native host runs Rust executors for the tool ids it serves; the webview runs every other v2 package tool in a dedicated Worker (`apps/desktop/src/plugins/`, see [Plugin host implementation](docs/PLUGIN_HOST_IMPLEMENTATION.md#the-webview-worker-engine)). A package directory under `plugins/` appears in the sidebar without any hand-maintained list.

The current design documents are:

- [Plugin system design](docs/PLUGIN_SYSTEM_DESIGN.md): ownership, contracts, state, workspaces, host services, Windows/macOS portability and migration.
- [DevUtils requirements](docs/DEVUTILS_REQUIREMENTS.md): the minimum 27 supplied guides, including options and interaction requirements from 51 screenshots.
- [Plugin implementation tasks](docs/PLUGIN_IMPLEMENTATION_TASKS.md): dependency gates, foundation tasks and isolated tool-worker packets.

Those documents describe the intended architecture. They do not claim the runtime, SDK or remaining tools have been implemented. The older [Tool Contract and Document Model.md](Tool%20Contract%20and%20Document%20Model.md) remains useful background pseudocode; the plugin design refines it.

## Technology decisions

**Rust** owns current processing libraries in `crates/devtools-core`. Typed errors, streaming readers and explicit allocation/cancellation policies suit large inputs. Rust does not itself guarantee bounded memory or cancellation; algorithms and hosts must enforce those policies. The CLI can test and benchmark the core without the UI; [benchmarks/](benchmarks/README.md) measures it on generated 50/250 MB fixtures and records the baseline in [benchmarks/baseline.md](benchmarks/baseline.md).

**Tauri 2** is the native host in `apps/desktop/src-tauri`. It owns dialogs, document handles, filesystem validation, snapshots, jobs and temporary results. The webview requests work through a typed bridge. The host supplies the platform-specific operations that later need macOS adapters.

**TypeScript, HTML/CSS and Vite** implement the current UI in `apps/desktop/src`. The architecture retains this stack during migration. Shared components and pure state transitions must replace tool-specific shell wiring. No additional frontend framework or external plugin runtime has been selected by this design.

Bundled processors use Rust or a dedicated JavaScript worker; a tool id the native host serves stays Rust, every other package tool runs on the worker engine. They must use the same versioned request/result and lifecycle contract. A trusted worker is an execution boundary, not an untrusted-code security sandbox.

## Current boundaries and gaps

```text
main.ts: DOM rendering and tool-specific UI decisions
  -> workbench/state.ts: pure reducer and per-tab revisions
  -> workbench/controller.ts: document/job effects
  -> bridge.ts: native commands/events
  -> Tauri main.rs: document, job, file and output ownership
  -> devtools-core: parsing and transformations
```

`workbench/tools.ts` still contains the static v1 catalog for the Rust tools; package tools are appended from `plugins/catalog.ts`. The controller and host still branch for particular tools, including compare. The experimental Rust `GenericTool`/`ToolRegistry` does not replace the production host's dispatch logic. The earlier `toolViews/registry.ts` exists but the current `main.ts` does not consume it. These are real integration gaps; external manifest loading alone will not solve them.

Reusable foundations include immutable source snapshots, temporary result handles, safe explicit exports, bounded previews and per-tab generation checks. These need regression coverage while migration moves tool-specific behavior into packages. Build success alone does not demonstrate correct native interaction or visual layout.

## How adding a tool will work

After the SDK readiness gate, a worker supplies `plugins/<id>/` with one canonical manifest, processor, optional scoped workspace view, samples, fixtures and tests. Tooling generates frontend catalog entries and backend executor registration. Shell services provide editors, tabs, commands, job status, files, clipboard and common result surfaces.

A worker implementing an image converter handles image/byte semantics and returns a typed artifact. The shell chooses the image or text view; the host handles complete copy/save and permissions. A JWT tool binds several fields through the same revisioned input ports. A generator uses zero input ports. These shapes must be proved before declaring the SDK complete.

Until that gate, existing tools can be maintained in their current modules, but feature workers cannot assume drop-in integration. Do not follow the old recipe of adding a new host command and global UI branch for every tool. Foundational contract changes belong to the integrator.

Bundled discovery requires a release rebuild. Installing new packages into an already built app is a separate phase with package validation, version compatibility, isolation, enable/disable and rollback. Neither delivery stage is implemented by these documents.

## UI and state decisions

The visual target is the supplied DevUtils reference, adapted to Windows: compact searchable tool rail, neutral dark surfaces, direct input/output actions and space devoted to content. Layout follows the tool: single text editor, source/result transform, two-source comparison, linked fields, generator or image/preview. An image replaces the text surface and starts at the top; a report need not create an empty output file.

Workspace state, document/undo models, plugin instance state, result handles and ephemeral view state have separate owners. Pure reducers produce state and effect intents. The controller performs effects; responses must match the instance and current revisions. Theme changes and progress events must not recreate editors, move panes or change tool input. Secrets are excluded from normal persistence and diagnostics.

The proposed status design delays progress for short jobs and uses a stable status-bar slot. The current fixed-height progress area is a transitional implementation, not the desired final use of space. P00 records actual layout evidence before further changes.

## Extension invariants

- Source revisions are immutable; edits create revisions, and saving is explicit. Processors never select arbitrary source/destination paths.
- Large data remains behind handles and bounded reads. Complete copy/save never silently uses a preview prefix.
- Jobs have limits, cancellation policies, structured errors and provenance. Cooperative native cancellation is distinct from enforced runner termination.
- Plugins use scoped SDK services and shared theme/components, not shell DOM, bridge internals or peer-plugin state.
- Capabilities and preview policies are validated and granted by the host. User HTML cannot access the application bridge.
- Tool completion requires semantic fixtures and rendered interaction evidence, including tab isolation, invalid input and relevant native workflows.
