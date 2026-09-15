# Native plugin host seam

The desktop host now has one registry boundary in `apps/desktop/src-tauri/src/plugin_host.rs`.
The registry owns the relationship between a tool manifest and its executor. The scheduler asks
the registry for a manifest and executor; it does not need a new `match tool_id` branch when a
tool is added.

## What is live today

- Built-in v1 manifests are registered once when `HostState` is created.
- `run_tool` validates the registered manifest and obtains the executor from the registry.
- The legacy executor is an adapter so existing Rust tools keep working during migration.
- New jobs return an `ExecutionIdentity` containing plugin, tool, operation, instance, job and
  generation fields. The frontend can use this identity to reject stale work as P04 moves more
  state into reducers.
- `TerminalEventGuard` is the shared primitive for ensuring one terminal outcome wins a race
  between completion, cancellation, timeout and failure.
- Registry tests cover duplicate IDs, sorted catalog output, dispatch and single terminal claims.

## Why this shape

`main.rs` remains the platform host: it owns files, temporary results, save policy, limits and
Tauri events. `plugin_host.rs` is deliberately free of Tauri and filesystem paths. A plugin gets
document data, options, cancellation and progress; it does not get an arbitrary source or output
path. This keeps the native safety policy in one place and lets a future v2 executor use named
ports, range readers and artifact sinks without changing the UI or save code.

The current adapter is not yet a fully dynamic third-party runtime. Discovery is build-time and
the remaining P03 work must connect v2 `ExecuteRequest` ports, capability grants, complete output
handles and terminal events. Runtime install and process isolation remain P09 work. The important
boundary is in place so those features can be added behind the host rather than spread through
the shell.

## How a future tool is added

1. A package declares its manifest and processor through the plugin SDK.
2. Discovery validates it and generates catalog/executor composition.
3. The host registers the executor under the manifest's stable ID.
4. The shared workbench binds the manifest's workspace and commands to its editor/result surfaces.
5. The package's own fixtures and UI scenarios run in the headless and rendered harnesses.

Until P08 freezes the worker-facing SDK, workers should keep changes inside their package and
report missing host capabilities instead of adding shell conditionals.
