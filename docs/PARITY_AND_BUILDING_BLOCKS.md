# DevTools Pro capability roadmap and building blocks

The long-term product target is a local toolbox with the capabilities shown in the [DevUtils demo](https://devutils.com/demo/), plus a larger catalogue. The earlier demo inventory below is retained as expansion scope, not a current live-site count or a claim of implemented parity.

**15 September 2026 update:** the user supplied 27 local guides. Their text and 51 tool screenshots are now mapped in [DEVUTILS_REQUIREMENTS.md](DEVUTILS_REQUIREMENTS.md). Use [PLUGIN_SYSTEM_DESIGN.md](PLUGIN_SYSTEM_DESIGN.md) as the current architecture design and [PLUGIN_IMPLEMENTATION_TASKS.md](PLUGIN_IMPLEMENTATION_TASKS.md) as the implementation queue. These refine the earlier ideas below; the SDK and discovery layer remain to be built.

## Capability parity checklist

The target catalogue is:

- **Time and identity:** Unix time, UUID/ULID, Cron parser.
- **Structured data:** JSON format/validate, YAML to JSON, JSON to YAML, JSON to CSV, CSV to JSON, PHP to JSON, JSON to PHP, JSON to Code, XML formatting, certificate decoding.
- **Text and encoding:** Base64 string, URL encoding, URL parsing, HTML entities, backslash escaping, string inspection, case conversion, hex ↔ ASCII, line sort/dedupe, random strings, number bases.
- **Code and markup:** HTML/CSS/JavaScript/ERB/LESS/SCSS beautify and minify, HTML to JSX, Markdown preview, SQL formatting, SVG to CSS, cURL to code.
- **Security and matching:** JWT debugging, regular-expression testing, hashing.
- **Media and previews:** Base64 images, HTML preview, QR reader/generator, color conversion.
- **Comparison and generation:** text diff and Lorem Ipsum generation.

Each future tool must declare its inputs, outputs, options, limits, capabilities, and workspace. The shell provides a consistent interaction vocabulary with layouts appropriate to the tool: a single editor, transform, comparison, linked fields, generator or media/preview surface. A right-hand text result is not appropriate for every tool.

## Where we are now

The current implementation has a solid safety foundation and working vertical slices for JSON/CSV/text inspection, JSON formatting and minifying, text utilities, hashing, image/Base64 conversion, cURL conversion, and text comparison. Rust owns file bytes and transformations; Tauri owns dialogs, paths, jobs, temporary results, and permissions; TypeScript owns the rail, forms, keyboard flow, and result renderers.

The current v1 manifest is intentionally small: one required document, one operation, one result document, opaque JSON options, and one renderer kind. The earlier `toolViews` registry is not consumed by the current `main.ts`; the controller catalog and host dispatch still have tool-specific branches. A simple tool can be added with manual integration, but this is not yet the isolation boundary required for independent plugin workers.

The existing [Tool Contract and Document Model](../Tool%20Contract%20and%20Document%20Model.md) already sketches the right v2 concepts: named input and output ports, typed values, optional streams, structured results, diagnostics with byte spans, provenance, capability grants, preview mode, and ordered execution events. The next architectural work is to implement that scaffold behind compatibility adapters rather than invent a second contract.

## Existing behavior to preserve and verify during migration

The following describes implemented workflows, not a fresh native UI validation of this documentation change. P00 in the new queue must reproduce the rendered and native scenarios before further shell migration; user-reported regressions cannot be ruled out by a build or static source check.

The desktop shell now treats each open tab as a small workspace record. It owns the selected tool, operation, editable draft, right-hand comparison text, revision, job state, result handle, and dirty state. A pure reducer in `apps/desktop/src/workbench/state.ts` applies transitions; `controller.ts` is the only place that performs Tauri effects. This split keeps DOM code from deciding when a file is opened or a result is retired, and lets a worker test state transitions without launching the app.

`Ctrl+N` and **New document** create an empty UTF-8 tab. Small UTF-8 files can be edited in place; imported source files remain immutable on disk, and saves are exported through the native host. Tabs can run independently, with a bounded global queue and revision tokens preventing late jobs from repainting a newer tab state. Selecting Image to Base64 shows a real bounded image preview and starts encoding automatically. Binary files no longer pass through a lossy text decoder, and incompatible tools explain the accepted input instead of producing junk output.

Clipboard round-trips have an explicit large-payload path. The visible result is a 64 KiB preview, but **Copy complete result** and Select All + Copy page the result through the host up to 36 MiB. Pasting more than the 1 MiB editor limit creates an app-owned temporary text document, keeps only its bounded preview in the webview, and lets the selected tool process the complete handle. This keeps Base64 image encode/decode useful without putting multi-megabyte strings in editor history. The native regression fixture is generated by `scripts/generate-clipboard-fixture.mjs` and is a 1,399,106-byte PNG data URI.

The visual shell follows the reference interaction: a dense searchable rail, one selected tool row, compact operation controls above the input/output surfaces, and large dark editor panes separated by a narrow divider. The shell keeps native file dialogs and the Windows title bar instead of simulating platform chrome. Renderer-specific controls remain declarative so a future JSON tree, table, image, or HTML preview can occupy the output surface without changing the job lifecycle.

This is still a bundled tool catalogue with partial manifest-driven execution, not an external plugin runtime. Adding a simple worker tool currently requires a core function, manifest entry, host adapter and UI integration. The new P00–P09 queue replaces historical Tasks 24–31 for plugin migration and establishes explicit readiness gates before independent feature workers begin.

## Contract needed for the full catalogue

The v2 contract should add these concepts while continuing to accept v1 requests:

1. **Named ports and cardinality.** A tool may have zero inputs (UUID or Lorem Ipsum), one input (formatter), or two or more named inputs (diff, certificate chains). Inputs can be a document, scalar value, table, or stream.
2. **Typed outputs.** A result may expose text, bytes, a table, a JSON tree, diff hunks, diagnostics, or multiple named outputs. The host stores each output by handle instead of forcing every result into a text area.
3. **Declarative options.** Operations describe string, number, boolean, enum, code-editor, and advanced options with defaults, validation, visibility, and sensitivity. The shell can render most forms generically while allowing a specialized view when interaction needs it.
4. **Execution modes.** A tool declares `instant` for debounced editor transforms or live regex matching, and `job` for large files. Both modes carry a revision so an old response cannot overwrite a newer edit.
5. **Determinism and replay.** A tool declares deterministic, seeded, random, or clock-dependent behavior. Seed, clock policy, normalized options, implementation version, and input hashes become part of provenance and cache keys.
6. **Renderer descriptors.** Results identify a text, tree, table, diff, image, QR, or sandboxed HTML/Markdown preview. A renderer receives a bounded page or range, not an unbounded string.
7. **Diagnostics and annotations.** Errors and matches carry byte spans, line/column hints, captures, fixes, and related locations. The UI can highlight a regex match or jump to a malformed JSON byte without parsing error text.
8. **Streaming events.** Outputs can arrive in chunks with backpressure. Completion happens only after chunks flush; progress, statistics, cancellation reason, and truncation are explicit.

This contract supports the exact tool shapes in the target catalogue: a no-input generator, a live editor, a two-file comparison, a paged JSON tree, an image preview, a sandboxed document preview, or a language-selecting code generator.

## Building blocks, explained without assuming Rust or frontend knowledge

Think of the app as a small factory:

1. **The left rail is the catalogue.** A manifest is the label on a machine: “JSON formatter,” its accepted materials, buttons, limits, and output type. The command palette is another index over the same manifests.
2. **The work area is the loading dock.** A `Document` is an immutable package of bytes plus format, encoding, MIME type, size, and provenance. “Immutable” means opening a file never gives a tool permission to change the original.
3. **The bridge is the guarded service window.** TypeScript asks Tauri to open a path or start a job. Tauri validates the request, keeps raw paths out of the web page where possible, and gives Rust a document handle.
4. **Rust is the processing engine.** It reads bounded ranges or streams, validates input, transforms it, checks cancellation and limits, and writes generated output to an app-owned temporary file.
5. **A job is a numbered work order.** Progress events update the status card. A revision and job id act like a receipt: if the user changes tools while work is running, late events no longer belong to the visible result.
6. **The result handle is a warehouse location.** The right pane asks for a text window, tree page, table page, image preview, or diff hunk range. It does not receive a 250 MB document just to show the first screen.
7. **A renderer is a display adapter.** Text uses a read-only editor, a table uses rows and columns, a diff uses structured hunks, and HTML/Markdown will use a restricted sandbox. Tools produce data; renderers decide how that data is shown.
8. **Save is an explicit export.** The user chooses a destination only after seeing the result. Tauri writes through a sibling temporary file and atomic rename, so a failed save does not damage the source or leave a partial destination.

In TypeScript, `main.ts` currently contains rendering and tool-specific decisions, while `workbench/state.ts` and `controller.ts` separate state transitions from native effects. Vite bundles frontend assets. The earlier `toolViews/` modules are not the active integration path and must be consolidated during migration. In Rust, modules under `crates/devtools-core` are testable libraries; the Tauri `main.rs` adapts them to host services. Input enters through a typed request, a core function returns output or a structured error, and the host controls files and lifecycle.

## Build order for parity

The detailed, current sequence is in [PLUGIN_IMPLEMENTATION_TASKS.md](PLUGIN_IMPLEMENTATION_TASKS.md). Its dependency gates replace this earlier conceptual outline:

1. Implement the v2 request/result types and a v1-to-v2 normalizer.
2. Add named multi-input requests and compatibility adapters for the current JSON and compare commands.
3. Add revisioned text snapshots and debounced instant execution.
4. Add typed result descriptors plus paged tree/table/annotation reads.
5. Add schema-driven option controls and migrate compare as the proving example.
6. Add renderer boundaries for tree, table, diff, image/QR, and sandboxed HTML/Markdown.
7. Build vertical slices: regex, JWT, YAML/JSON, formatter family, generators, then code generators and remaining converters.
8. Add a compatibility test for every catalogue entry: manifest, valid/invalid fixtures, limits, cancellation, renderer, copy/save behavior, and keyboard path.

An external plugin loader can follow the bundled architecture. Independent feature workers need a tested SDK, generated integration and representative workspace proofs first. A manifest and an isolated-looking folder alone do not establish that the current shell is ready.
