
# Developer Workbench Product Plan

## Product thesis

Build an offline-first, keyboard-first desktop workbench that turns recurring developer data tasks into fast, reversible operations. The product should win through latency, trustworthy results, and composition across a small number of excellent tools, rather than by becoming a directory of tiny converters.

Every catalogue item passes five gates: repeated user pain, audience breadth, measurable workflow or speed advantage, reuse of platform capabilities, and a maintenance or safety burden justified by value. Use three roadmap labels: Now (launch or early foundation), Later (after usage evidence), and Integrate (support through a mature adapter or external tool instead of owning a large subsystem).

## Long-term feature catalogue

### Structured data and configuration

- JSON/JSON5/JSONC: detect, parse, format, minify, sort keys, tree/text editing, JSON Pointer and JSONPath, flatten/unflatten, repair diagnostics, schema validation, NDJSON streaming, query, profile, and structural diff. Now. This is a flagship workflow and exercises every core capability.
- YAML: format, lint, anchors and aliases view, JSON conversion, multi-document handling, merge/patch and schema validation. Now/Later. High-frequency configuration work; preserve comments and ordering where possible.
- XML: pretty print/minify, XPath, namespaces, XSD validation, XML/JSON conversion and streaming view. Later. Valuable in enterprise environments but round-trip fidelity is a hard quality bar.
- CSV/TSV: delimiter and encoding detection, virtualized preview/editing, type inference, filtering, sorting, pivot/profile, malformed-row diagnostics, JSON/SQL conversion. Now. A strong 50 MB performance demonstration.
- TOML, INI, properties and plist: format, validate, key-path navigation, interpolation preview and conversion to structured data. Now/Later. Bundle as configuration rather than separate screens.
- HCL, Jsonnet, Dhall, Nginx and systemd: parse, format, validate and explain. Later/Integrate. Ship only when parser quality and demand justify ongoing support.
- Schemas and contracts: JSON Schema editor/validator/generator, schema inference, compatibility checks, OpenAPI/AsyncAPI, Protobuf, Avro and GraphQL SDL viewers. Now/Later. A shared contract layer enables many later tools.
- Binary serialization: MessagePack, CBOR, Avro and Parquet inspection, with schema-aware encode/decode. Later. Target inspection first, not a general data platform.

### Encoding, text and identifiers

- Base64 standard/URL-safe/file mode, hex, binary/octal/decimal, percent URL encoding, HTML/XML/JSON/JavaScript/CSS escaping, quoted-printable, gzip/zlib preview and data-URI conversion. Now.
- Unicode inspector: code points, grapheme clusters, normalization, invisible characters, bidi warnings, confusables, newline/BOM and encoding conversion. Now/Later. Prevents bugs that ordinary text boxes hide.
- Text transforms: trim/normalize whitespace, sort/unique, join/split, case and camel/snake/kebab conversion, prefix/suffix, wrap, dedent/indent, extract/replace, columns, line endings and batch operations. Now.
- Regex tester: highlighted matches/groups, replacement preview, named-group table, flavor and flag selection, explanation of common constructs and execution timeout. Now.
- UUID/GUID v1/v4/v7 and namespace generation/parsing; ULID, KSUID and Snowflake inspection. Now/Later.
- Random strings/bytes, passwords, API keys and regex-constrained fixtures with a secure RNG and seed control. Now.
- Number/base conversion, bitwise view, endian and IEEE-754 float inspection, byte units, color/angle/temperature and locale formatting. Now/Later.
- URL/URI parser and builder: query editor, path segments, canonicalization, encode/decode and shell-safe output. Now.
- Semantic version parsing, range explanation and comparison. Later.

### Time, hashes, cryptography and certificates

- Unix epoch, ISO/RFC formats, duration arithmetic, timezone/DST conversion, interval overlap and cron parse/explain/next runs. Now.
- MD5, SHA-1, SHA-2, SHA-3, BLAKE2/BLAKE3, CRC, file checksums, HMAC and side-by-side integrity comparison. Now. Label algorithms and security status clearly.
- JWT/JWS/JWE inspection, claims/time checks, supplied-key signature verification, JWK/JWKS conversion and OAuth/OIDC helpers. Now/Later. Keep keys local and network access explicit.
- PEM parser, X.509 certificate and CSR details, SANs, chain/fingerprint/expiry inspection, SSH key fingerprints and TLS diagnostics. Later. Security-sensitive, but valuable to professional users.
- AES-GCM, Argon2/bcrypt/PBKDF2, age/PGP and TOTP helpers. Integrate/Later. Use audited libraries only, never invent cryptography, never persist secrets by default, and make guardrails prominent.
- Secret/PII detection, redaction, entropy analysis, security-header/CORS/CSP checks and clipboard expiry. Now/Later. These are trust features when they avoid false assurance.

### Diff, data querying and extraction

- Text, folder and three-way diff/merge with whitespace, case, line-ending, ordering and ignore controls; patch export/apply. Now.
- Structural JSON/YAML/CSV diff, schema compatibility and redaction-aware compare. Now/Later.
- JSONPath/JMESPath/jq-like extraction and transforms; XPath and CSS selectors; regex extraction. Now/Later.
- Local query over CSV/JSON/Parquet/SQLite/DuckDB, with schema browser, filter/sort/group/join, profile/sample and export. Later. Sandbox execution and impose resource limits.
- SQLite schema/data browser, SQL format/minify/lint/parameter extraction and dialect-aware explain. Now/Later.
- Table pivot, aggregate, join and column statistics. Later. Reuse the virtualized grid and typed table model.
- Archive listing and safe extract preview for zip/tar/gz. Later. Enforce path traversal and resource limits.
- File signature/MIME detection, hex viewer/editor, binary diff, offsets and struct decoding. Later.

### HTTP, APIs and protocols

- Raw HTTP request/response parser, headers/status/cookies/body viewer, timing breakdown, redirects and TLS details. Now/Later.
- Request builder with environments, variables, history, replay, import/export and redaction. Later.
- cURL import to request and export from request, with shell quoting and flag explanations. Now.
- HAR inspect/replay/sanitize, REST scratchpad, GraphQL format/validate/variables/introspection and OpenAPI 2/3 lint/explorer/mock/client snippets. Later.
- JSON Schema request/response validation, contract fixtures, gRPC/Protobuf encode/decode, WebSocket frames and SSE event streams. Later.
- OAuth2/OIDC flow debugger and auth helpers. Later. Network operations require explicit consent and clear secret handling.
- DNS/reachability helpers. Optional. Online dependence makes them weaker as a core experience.

### Code, markup and project files

- Markdown format/preview, GFM tables, links/images, front matter, TOC, lint and HTML/PDF export. Now/Later.
- HTML format/minify/DOM inspection; CSS/SCSS format/minify, selector specificity, colors, units and accessibility hints. Later.
- JavaScript/TypeScript format/minify, AST inspection, JSON-to-types, source-map and package metadata tools. Later.
- JSON-to-C#/Java/Python/Go/Rust/Kotlin types, literal/escape conversion and language formatter adapters. Later/Integrate. Do not become an IDE or ship shallow pseudo-formatters.
- Shell/PowerShell quoting and formatting, regex-to-code snippets and SQL fixture generation. Now/Later.
- Package manifests and lockfiles for npm, pnpm, yarn, NuGet, Maven/Gradle, Poetry/pip and Cargo; semver/conflict inspection. Later.
- Git patch/apply, .gitignore/glob tester, object/commit metadata and blame helpers. Later. Keep repository mutation explicit.

### Containers, cloud and automation

- .env parser/generator, interpolation preview and secret redaction; connection-string parser/builders. Now/Later.
- Dockerfile lint/explain, image reference parser, Compose validation/normalization and environment expansion. Later.
- Kubernetes manifest explorer, schema validation, JSONPath, overlays and diff; Helm values/template/render diff. Later.
- Terraform HCL format/validate, plan JSON viewer, variable/reference graph, provider policy helpers. Later/Integrate.
- GitHub/GitLab/Azure CI YAML matrix expansion and secret/reference lint; cloud ARN/IAM policy analysis; Nginx/Apache configuration helpers. Later.

### Logs, traces and diagnostics

- Auto-detect JSON/logfmt/CSV/plain logs, stream filtering/highlighting, field histograms, timestamp extraction, redact and time-window statistics. Now/Later.
- Access-log parsers, ANSI control-code decoding, W3C traceparent and trace/span correlation. Later.
- Stack trace parsing/linking for JavaScript, Python, Java, .NET and Go; exception normalization and cause-chain grouping. Later.
- SQL EXPLAIN and profile formats. Optional until there is a clear target audience.

### Generation and sharing

- Schema-constrained JSON/CSV/SQL fixtures, realistic seeded mock data, API examples, deterministic replay and test-case generation. Later.
- JWT/OAuth test tokens, local-development certificates/CSRs, regex sample strings, QR/barcode generation/decoding. Later.
- JSON/YAML/XML/CSV/TOML/INI/SQL/Protobuf and cURL conversion bridges. Now/Later.
- Saved recipes, parameter presets, operation history, exportable pipeline files, redacted share bundles and batch/watch processing. Now foundation/Later.
- Image EXIF/ICC metadata, data-URI tools, audio metadata and archive inspection. Integrate/Later; focus on inspection, not media editing.

### Cross-cutting workflow capabilities

Smart file and clipboard detection, recent/favorites, command palette and universal search, tabs/splits, synchronized views, one-click copy/save, drag/drop, undo/versioned snapshots, autosave/recovery, snippets, themes, high contrast, localization, screen-reader support, optional clipboard history and opt-in telemetry are platform capabilities rather than isolated tools. They should be present from the first usable release.

## Recommended first five

1. **Unified structured-data inspector and formatter** covering JSON, YAML, CSV/TSV, NDJSON, TOML and a useful XML subset. Auto-detection, text/tree/table views, format/minify/validate/query and progressive large-file handling provide the broadest audience and the clearest performance proof. It establishes the document, parser, diagnostics, conversion and virtualized-view foundations.
2. **Diff/compare/merge workbench** for large text plus structural JSON/CSV. Comparison is frequent and painful; it differentiates through incremental rendering and becomes a shared service for configs, APIs, logs and code.
3. **Text, encoding and security utility suite** combining transformations, regex, Base64/URL/hex/Unicode/escaping, hashes/HMAC, JWT inspection, UUIDs and timestamps. These are high-frequency clipboard tasks, private and offline, and mostly pure deterministic operations that make excellent pipeline nodes.
4. **HTTP/API toolkit with cURL import/export.** It bridges terminal snippets to inspectable and replayable requests, with a clear paid-product path. Start with safe parsing, response inspection and explicit network permission; add OpenAPI and GraphQL progressively.
5. **Composable query and transformation pipelines.** JSONPath/JMESPath/jq-like transforms, CSV/TSV SQL, filter/map/sort/group, schema inference, preview, deterministic replay and batch mode are the durable differentiator. Typed composition makes future tools cheaper without coupling them.

These are user-facing wedges; command palette, smart detection, virtualized views, worker execution, cancellation, history and accessibility are MVP acceptance criteria underneath them.

## Architecture

Define a small, versioned Tool contract independent of the UI. A manifest contains id, version, title/category, keywords, input/output types, detection confidence, option schema/defaults, capability declarations, renderer hints and fixtures. Execution accepts a stream of immutable Documents plus options and an abort signal, and returns result chunks, progress, diagnostics with byte/line spans, statistics and provenance.

Represent a Document as bytes or text chunks plus encoding, MIME, newline style, source path, size, hash and provenance. Parsed forms are lazy: small inputs may materialize an AST; large inputs use streaming indexes, token ranges and partial materialization. Pipelines are typed DAGs passing Documents or structured table/value ports, with preview, undo, cache keyed by input/options/tool version and deterministic replay.

Tools depend only on contracts and small versioned capability services. They never import another tool or share mutable state. Services cover detection, parsers, formatters, diffing, redaction, storage, history, clipboard, worker pools and diagnostics. The UI is a thin state/query shell over these services.

Built-ins run in-process only when trusted and cheap. Pure extensions should run in WASM with CPU/memory quotas and no implicit network/filesystem access. Heavy or privileged native helpers run out-of-process through a versioned RPC protocol for crash isolation. Sign manifests, negotiate semantic versions, request capabilities explicitly, support disable/rollback, and delay a public marketplace until compatibility and support processes exist.

## Technology choice and benchmark

Run a short spike with the same 50 MB, 250 MB and malformed-input corpus before committing. Measure cold and warm startup, first visible bytes, keystroke-to-paint p95, tab/tool switch p95, parse/format throughput, peak RSS, cancellation acknowledgement, accessibility, packaging/update and crash recovery.

Qt/C++ offers mature native controls and strong large-file rendering but has higher implementation and plugin-ABI cost. .NET/Avalonia is productive and cross-platform, but startup and low-level ecosystem need proof. Electron has the easiest web ecosystem but its memory/startup baseline conflicts with the product goal. Tauri 2 with a Rust core can provide a small shell and fast native I/O, but webview/editor performance is not automatically native; it must pass the same benchmark.

Default direction after the spike: keep a shell-agnostic Rust or C++ domain core and a language-neutral tool protocol, then choose Tauri/Rust when its editor/grid and accessibility meet the budgets, or Qt/C++ when native rendering wins. This preserves a swap path.

## Performance and reliability strategy

Target a first usable window under 1.5 seconds cold and 0.5 seconds warm on the supported baseline, tool switch under 100 ms, keystroke-to-paint p95 under 16 ms for normal editing, cancellation acknowledgement under 100 ms, and first visible bytes from a 50 MB file under 200 ms. Validate 50 MB JSON/CSV parse or format under 2 seconds with memory near 2x input, while a 250 MB inspect view remains responsive.

Use lazy manifest/tool loading, memory-mapped or chunked reads, ropes, incremental parsing, streaming transforms, virtualized editors/trees/grids, async worker pools, backpressure, bounded caches and temp-file spill for very large data. Never block the UI thread. Preserve original bytes and offsets where round-trip fidelity matters. Benchmark deep nesting, long lines, malformed rows and pathological regex, not only happy paths.

Use deterministic golden fixtures, property and fuzz tests for parsers/transforms, cancellation/error contract tests, diagnostic location tests, cross-platform CI, startup/file-size regression tests, leak/crash soak tests and plugin isolation tests. Offline is the default; network actions are opt-in. Never send raw content or secrets in telemetry. Use audited crypto libraries, zeroize sensitive buffers where feasible, signed installers, rollback-capable updates and recovery after crashes.

## UX

Use one primary canvas with tabs, input/output split, optional diff, and text/tree/grid view switching. Ctrl/Cmd-K opens a universal command palette that searches by intent, format, recency and shortcut. Auto-detection displays confidence and allows an override. Drag/drop, open-file and clipboard paths converge on the same Document model.

Options use progressive disclosure with sensible defaults. Expensive jobs show progress, diagnostics and cancel. Destructive replacement is previewed and undoable. Copy and save are one action, preserving encoding and line endings. Empty, malformed and huge inputs explain what happened and what the user can do next. Keep network and secret-bearing operations visibly explicit. Full keyboard traversal, screen readers, high contrast and reduced motion are release requirements.

## Phased delivery

**Phase 0, 2–4 weeks:** interview backend, frontend, data, DevOps and security developers; collect consented representative inputs; define budgets; prototype detection, Document, command palette and 50/250 MB viewing; benchmark two stack candidates; create tool-contract and fixture harness.

**Phase 1, 6–10 weeks:** ship shell, tabs, recovery, file/clipboard services, smart detection, editor/viewer, worker pool, cancellation/progress, history and keyboard navigation. Deliver JSON, CSV, Base64/URL/hex, UUID and timestamp vertical slices, installer/update and opt-in diagnostics.

**Phase 2, 8–12 weeks:** add YAML/TOML/XML, text/regex transforms, structural/text diff, large-file streaming, recipes, import/export and polished onboarding. Publish reproducible performance results and validate workflows with usability tests.

**Phase 3, 8–12 weeks:** add HTTP request/response, cURL, HAR, redaction, auth profiles, OpenAPI read-only explorer, GraphQL basics, JWT/PEM inspection and stronger audit/recovery controls.

**Phase 4, ongoing:** add local SQL/query, logs/traces, Markdown/web, containers/IaC, binary/media, schema/code generation and batch/watch workflows according to telemetry and customer interviews. Introduce sandboxed extensions only after signing, permissions, versioning, quotas and crash isolation are production-ready.

## Assumptions to challenge and measures

A 50 MB requirement does not justify a 50 MB AST: progressive streaming views are the behavior users feel. Hundreds of tools can damage discovery and quality; use intent search, favorites, recipes and quality gates, and retire low-use tools. Arbitrary plugins add security, startup and compatibility costs; prove the internal contract first. Network features can erode trust unless offline behavior, consent, redaction and secret handling are first-class. General chaining should follow deterministic typed operations; arbitrary scripts would create hidden coupling and support burden.

Track activation to a successful transform, p95 interaction latency, cold-start and 50 MB open time, cancellation latency, crash-free sessions, error-recovery success, repeat weekly workflows, recipe reuse, discovery success, memory regressions and the percentage of operations completed offline. Promote Later items when these measures and customer evidence support them.

