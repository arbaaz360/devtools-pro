# Tool Contract and Document Model (initial scaffold)

This document defines the UI-independent boundary between the workbench shell,
built-in tools, and future extensions. It is intentionally serializable so the
same contract can be used by an in-process Rust implementation and an
out-of-process/WASM adapter.

## Design rules

- A tool is a versioned, deterministic function over immutable input ports.
- Tools communicate through documents and typed values; they never import or
  mutate another tool's state.
- Execution is streaming and cancellable. A consumer may apply backpressure by
  limiting the number of in-flight chunks.
- Byte offsets are authoritative for diagnostics and provenance. Line/column
  locations are derived display hints.
- Raw input bytes are retained where possible. Parsed ASTs, indexes, and tables
  are lazy/materialized views over those bytes.

## Core types (Rust-shaped pseudocode)

```rust
pub type ToolId = String;             // reverse-DNS, e.g. "devtools.json.format"
pub type DocumentId = uuid::Uuid;
pub type JobId = uuid::Uuid;
pub type Hash = String;               // lowercase hex, algorithm-prefixed

pub struct SemVer { pub major: u64, pub minor: u64, pub patch: u64 }

pub enum DataType {
    Bytes,
    Text,
    Json,       // parsed value; preserves source spans when available
    Table,
    NdJson,
    Xml,
    Scalar,
    Patch,
    Any,
}

pub struct PortSpec {
    pub name: String,
    pub data_type: DataType,
    pub required: bool,
    pub accepts_stream: bool,
    pub description: Option<String>,
}

pub struct ToolManifest {
    pub id: ToolId,
    pub contract_version: SemVer,
    pub implementation_version: SemVer,
    pub title: String,
    pub category: String,
    pub keywords: Vec<String>,
    pub inputs: Vec<PortSpec>,
    pub outputs: Vec<PortSpec>,
    pub options_schema: JsonSchema,
    pub default_options: JsonValue,
    pub capabilities: Capabilities,
    pub detection: Option<DetectionSpec>,
    pub renderer_hints: RendererHints,
    pub fixtures: Vec<FixtureRef>,
}

pub struct Capabilities {
    pub deterministic: bool,
    pub supports_preview: bool,
    pub supports_streaming: bool,
    pub needs_network: bool,       // always requires explicit user grant
    pub needs_filesystem: bool,    // scoped paths only
    pub needs_secrets: bool,
    pub max_input_bytes: Option<u64>,
}

pub struct DetectionSpec {
    pub mime_types: Vec<String>,
    pub extensions: Vec<String>,
    pub magic_bytes: Vec<Vec<u8>>,
    pub max_probe_bytes: u32,
}

pub struct RendererHints {
    pub preferred_view: ViewKind,
    pub supports_views: Vec<ViewKind>,
    pub sensitive: bool,
}
pub enum ViewKind { Text, Tree, Table, Diff, Binary, Json }

pub struct Document {
    pub id: DocumentId,
    pub source: SourceInfo,
    pub encoding: Encoding,
    pub newline: NewlineStyle,
    pub mime_type: Option<String>,
    pub byte_len: u64,
    pub content_hash: Option<Hash>,
    pub chunks: ChunkSequence,
    pub provenance: Provenance,
}

pub enum ChunkSequence {
    Inline(Vec<u8>),
    Stream(StreamRef),              // pull/async stream of immutable chunks
    File(FileRef),                  // mmap or ranged reads; no implicit writes
}
pub struct StreamRef { pub chunk_size: u32, pub total_len: Option<u64> }
pub struct FileRef { pub path_token: String } // capability-scoped token, not raw path

pub struct SourceInfo {
    pub display_name: Option<String>,
    pub source_path: Option<String>,
    pub origin: Origin,
}
pub enum Origin { File, Clipboard, DragDrop, Generated, Tool { tool_id: ToolId, job_id: JobId } }
pub enum Encoding { Utf8, Utf16Le, Utf16Be, Latin1, Binary, Other(String) }
pub enum NewlineStyle { Lf, CrLf, Cr, Mixed, None, Unknown }
pub struct Provenance {
    pub parents: Vec<DocumentId>,
    pub operation: Option<OperationRef>,
}
pub struct OperationRef { pub tool_id: ToolId, pub implementation_version: SemVer, pub options_hash: Hash }

pub struct ExecuteRequest {
    pub protocol_version: SemVer,
    pub job_id: JobId,
    pub tool: ToolRef,
    pub inputs: Map<String, InputPort>,
    pub options: JsonValue,
    pub mode: RunMode,
    pub grants: CapabilityGrants,
}
pub struct ToolRef { pub id: ToolId, pub required_version: VersionRange }
pub enum InputPort { Document(Document), Value(JsonValue), Stream(StreamRef) }
pub enum RunMode { Full, Preview { max_bytes: u64, max_rows: u64 } }
pub struct CapabilityGrants {
    pub network: bool,
    pub filesystem_roots: Vec<String>,
    pub secret_handles: Vec<String>,
}

pub enum ExecuteEvent {
    Output { port: String, chunk: OutputChunk },
    Diagnostic(Diagnostic),
    Progress(Progress),
    Stats(Stats),
    Completed { outputs: Vec<OutputSummary> },
    Failed { error: ToolError },
}
pub enum OutputChunk { DocumentBytes(Vec<u8>), Value(JsonValue), TableRows(Vec<Row>) }
pub struct Progress { pub completed: u64, pub total: Option<u64>, pub unit: String, pub message: Option<String> }
pub struct Stats { pub bytes_read: u64, pub bytes_written: u64, pub rows: Option<u64>, pub elapsed_ms: u64, pub peak_rss_bytes: Option<u64> }

pub struct Diagnostic {
    pub severity: Severity,
    pub code: String,
    pub message: String,
    pub span: Option<Span>,
    pub related: Vec<RelatedSpan>,
    pub fix: Option<FixIt>,
}
pub enum Severity { Hint, Info, Warning, Error }
pub struct Span { pub document_id: DocumentId, pub start_byte: u64, pub end_byte: u64, pub line: Option<u64>, pub column: Option<u64> }
pub struct RelatedSpan { pub message: String, pub span: Span }
pub struct FixIt { pub label: String, pub replacement: Vec<u8>, pub span: Span }

pub struct Cancellation { pub job_id: JobId, pub reason: CancelReason }
pub enum CancelReason { User, Superseded, ResourceLimit, Shutdown }
```

## Wire and lifecycle contract

Manifest, request, and event structures are encoded as JSON for debugging and
CBOR for compact RPC transport. Every message has `protocol_version`; unknown
fields must be ignored and required-field/type changes require a new major
version. A handshake exchanges protocol versions, tool manifest, and granted
capabilities before input bytes are sent.

Execution order is `Start -> (Output | Diagnostic | Progress | Stats)* ->
Completed|Failed`. Events are ordered per output port. `Completed` is emitted
only after all output chunks are flushed. A tool must acknowledge
`Cancellation` within 100 ms, stop producing output, and release resources;
the host may terminate a non-compliant worker. No event may block the UI thread.

The desktop registry uses a compact serializable manifest for discovery and
command-palette indexing. `inputKinds`, `limits`, `capabilities`, `operations`,
and `renderer` are intentionally stable fields so a host can validate a job
before reading its document. The Rust core also exposes a `ToolRegistry` for
in-process or test-only tools; it performs the same tool-id, input-kind,
operation, options, and input-size checks before dispatching execution.

An abbreviated JSON manifest is suitable for registry discovery:

```json
{
  "id": "encoding.base64",
  "label": "Base64 Encode",
  "contractVersion": 1,
  "inputKinds": ["bytes"],
  "limits": {"maxInputBytes": null, "maxOutputBytes": null},
  "capabilities": {"deterministic":true,"supportsPreview":true,"supportsStreaming":true,"cancellation":true,"progress":true,"needsFilesystem":false,"needsNetwork":false,"needsSecrets":false},
  "operations": [{"id":"encode","label":"Encode","defaultOptions":{}}],
  "renderer": "text"
}
```

For a preview request, a normal event transcript is:

```text
Start(job_id, tool_ref)
Progress(completed=0, total=14820, unit="bytes")
Output(port="output", chunk=...)
Diagnostic(severity=Info, code="preview.truncated", span=null)
Stats(bytes_read=14820, bytes_written=19760, elapsed_ms=3)
Completed(outputs=[{port:"output", truncated:true}])
```

The host owns scheduling, persistence, history, cache, and capability grants.
The tool owns parsing/transformation state for one job only. Cache keys are
`hash(input bytes, normalized options, tool id, implementation version,
contract version)`. Caches and history must omit content marked `sensitive`.

## Document and pipeline invariants

1. Input documents are immutable. A replacement creates a new document with
   parent provenance and an undoable history entry.
2. Chunks preserve order and exact bytes; an implementation may re-chunk but may
   not alter bytes without declaring a transformation output.
3. A stream may be consumed once unless the host materializes it or provides a
   replayable file-backed stream.
4. Byte spans refer to the original document and remain valid for diagnostics;
   transformed outputs carry a new `DocumentId` and provenance.
5. Preview is a bounded execution with the same semantics as full execution;
   tools report truncation in `Stats` or a diagnostic rather than silently
   presenting incomplete output as complete.
6. Resource limits (CPU, memory, output bytes, regex steps, and rows) are host
   enforced and reported as `ResourceLimit` failures.

## Initial built-in adapter guidance

Implement `Document` and the event protocol in the Rust domain crate first.
Keep UI adapters limited to converting editor buffers/files/clipboard into a
`Document`, subscribing to `ExecuteEvent`, and rendering diagnostics by span.
The first vertical slice can register JSON format, CSV preview, Base64 encode,
and text transform tools against this contract without changing shell code.
