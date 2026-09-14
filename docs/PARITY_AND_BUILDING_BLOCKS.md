# DevTools Pro capability roadmap and building blocks

The long-term product target is a local toolbox with the capabilities shown in the [DevUtils demo](https://devutils.com/demo/), plus a larger catalogue. The demo currently lists 47 tools, including converters, formatters, generators, inspectors, previews, comparisons, and code generators. We will use that catalogue as a compatibility checklist, while keeping our own implementation offline-first and extensible.

## Capability parity checklist

The target catalogue is:

- **Time and identity:** Unix time, UUID/ULID, Cron parser.
- **Structured data:** JSON format/validate, YAML to JSON, JSON to YAML, JSON to CSV, CSV to JSON, PHP to JSON, JSON to PHP, JSON to Code, XML formatting, certificate decoding.
- **Text and encoding:** Base64 string, URL encoding, URL parsing, HTML entities, backslash escaping, string inspection, case conversion, hex ↔ ASCII, line sort/dedupe, random strings, number bases.
- **Code and markup:** HTML/CSS/JavaScript/ERB/LESS/SCSS beautify and minify, HTML to JSX, Markdown preview, SQL formatting, SVG to CSS, cURL to code.
- **Security and matching:** JWT debugging, regular-expression testing, hashing.
- **Media and previews:** Base64 images, HTML preview, QR reader/generator, color conversion.
- **Comparison and generation:** text diff and Lorem Ipsum generation.

Each future tool must declare its inputs, outputs, options, limits, capabilities, and preferred renderer. That lets the shell offer the same predictable flow—choose a tool on the left, provide its inputs in the work area, see a bounded result on the right, then copy or save—without making every tool a special case.

## Where we are now

The current implementation has a solid safety foundation and working vertical slices for JSON/CSV/text inspection, JSON formatting and minifying, text utilities, hashing, image/Base64 conversion, cURL conversion, and text comparison. Rust owns file bytes and transformations; Tauri owns dialogs, paths, jobs, temporary results, and permissions; TypeScript owns the rail, forms, keyboard flow, and result renderers.

The current v1 manifest is intentionally small: one required document, one operation, one result document, opaque JSON options, and one renderer kind. The UI view registry is isolated by tool id, but bundled views still require registration. This is enough to add another simple tool safely; it is not yet enough for the complete catalogue.

The existing [Tool Contract and Document Model](../Tool%20Contract%20and%20Document%20Model.md) already sketches the right v2 concepts: named input and output ports, typed values, optional streams, structured results, diagnostics with byte spans, provenance, capability grants, preview mode, and ordered execution events. The next architectural work is to implement that scaffold behind compatibility adapters rather than invent a second contract.

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

In TypeScript, `main.ts` coordinates the page and the `toolViews/` modules define tool-specific controls. Vite bundles those files into browser assets. In Rust, modules under `crates/devtools-core` are ordinary testable libraries; the Tauri `main.rs` is an adapter around them. You do not need to know Rust syntax to reason about the boundary: input enters through a typed request, a core function returns typed output or a structured error, and the host controls files and lifecycle.

## Build order for parity

Do not add 40 isolated special cases. Build the reusable layers in this order:

1. Implement the v2 request/result types and a v1-to-v2 normalizer.
2. Add named multi-input requests and compatibility adapters for the current JSON and compare commands.
3. Add revisioned text snapshots and debounced instant execution.
4. Add typed result descriptors plus paged tree/table/annotation reads.
5. Add schema-driven option controls and migrate compare as the proving example.
6. Add renderer boundaries for tree, table, diff, image/QR, and sandboxed HTML/Markdown.
7. Build vertical slices: regex, JWT, YAML/JSON, formatter family, generators, then code generators and remaining converters.
8. Add a compatibility test for every catalogue entry: manifest, valid/invalid fixtures, limits, cancellation, renderer, copy/save behavior, and keyboard path.

An external plugin loader can come later. A bundled manifest and isolated view are already enough for workers to build tools independently; the v2 contract is the important prerequisite for scale.

