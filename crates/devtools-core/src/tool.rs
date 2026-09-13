use crate::{Document, DocumentKind};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity { Info, Warning, Error }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic { pub severity: Severity, pub message: String, pub start: usize, pub end: usize }

#[derive(Debug, Error, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum ToolError {
    #[error("invalid UTF-8 input")] InvalidUtf8,
    #[error("operation cancelled")] Cancelled,
    #[error("I/O error: {message}")] Io { message: String },
    #[error("invalid JSON at line {line}, column {column}: {message}")]
    InvalidJson { message: String, line: usize, column: usize },
    #[error("invalid CSV at record {record}: {message}")] InvalidCsv { message: String, record: u64 },
    #[error("resource limit: {message}")] ResourceLimit { message: String },
    #[error("unsupported encoding: {message}")] UnsupportedEncoding { message: String },
    #[error("unknown tool id: {tool_id}")] UnknownTool { tool_id: String },
    #[error("tool {tool_id} does not support {input_kind} input")]
    UnsupportedInputKind { tool_id: String, input_kind: String },
    #[error("tool {tool_id} does not support operation {operation_id}")]
    UnsupportedOperation { tool_id: String, operation_id: String },
    #[error("invalid options: {message}")] InvalidOptions { message: String },
    #[error("tool execution failed: {message}")] Execution { message: String },
    #[error("invalid image bytes: {message}")] InvalidImage { message: String },
    #[error("unsupported image MIME type: {mime}")] UnsupportedImageMime { mime: String },
    #[error("invalid Base64 input: {message}")] InvalidBase64 { message: String },
    #[error("invalid {operation} input at byte {position}: {message}")]
    InvalidText { operation: String, message: String, position: usize },
}

impl From<std::io::Error> for ToolError {
    fn from(error: std::io::Error) -> Self { Self::Io { message: error.to_string() } }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputKind { Bytes, Text, Json, Csv, NdJson, Xml, Table, Scalar, Patch, Any }

impl InputKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bytes => "bytes", Self::Text => "text", Self::Json => "json", Self::Csv => "csv",
            Self::NdJson => "nd_json", Self::Xml => "xml", Self::Table => "table", Self::Scalar => "scalar",
            Self::Patch => "patch", Self::Any => "any",
        }
    }
}

impl From<DocumentKind> for InputKind {
    fn from(kind: DocumentKind) -> Self {
        match kind {
            DocumentKind::Json => Self::Json,
            DocumentKind::Table => Self::Csv,
            DocumentKind::Binary => Self::Bytes,
            DocumentKind::Text => Self::Text,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RendererKind { Text, Tree, Table, Diff, Binary, Json }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolLimits { pub max_input_bytes: Option<u64>, pub max_output_bytes: Option<u64> }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCapabilities {
    pub deterministic: bool,
    #[serde(alias = "preview")]
    pub supports_preview: bool,
    #[serde(alias = "streaming")]
    pub supports_streaming: bool,
    pub cancellation: bool,
    pub progress: bool,
    #[serde(alias = "filesystem")]
    pub needs_filesystem: bool,
    #[serde(alias = "network")]
    pub needs_network: bool,
    #[serde(alias = "secrets")]
    pub needs_secrets: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOperation {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub default_options: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolManifest {
    pub id: String,
    #[serde(alias = "title")]
    pub label: String,
    pub contract_version: u32,
    pub input_kinds: Vec<InputKind>,
    pub limits: ToolLimits,
    pub capabilities: ToolCapabilities,
    pub operations: Vec<ToolOperation>,
    pub renderer: RendererKind,
}

impl ToolManifest {
    pub fn supports(&self, input_kind: InputKind, operation_id: &str) -> Result<(), ToolError> {
        if !self.input_kinds.contains(&input_kind) && !self.input_kinds.contains(&InputKind::Any) {
            return Err(ToolError::UnsupportedInputKind { tool_id: self.id.clone(), input_kind: input_kind.as_str().into() });
        }
        if !self.operations.iter().any(|operation| operation.id == operation_id) {
            return Err(ToolError::UnsupportedOperation { tool_id: self.id.clone(), operation_id: operation_id.into() });
        }
        Ok(())
    }
}

fn operation(id: &str, label: &str) -> ToolOperation {
    ToolOperation { id: id.into(), label: label.into(), default_options: Value::Object(Default::default()) }
}

fn local_streaming_capabilities() -> ToolCapabilities {
    ToolCapabilities {
        deterministic: true, supports_preview: true, supports_streaming: true, cancellation: true, progress: true,
        needs_filesystem: true, needs_network: false, needs_secrets: false,
    }
}

pub fn builtin_manifests() -> Vec<ToolManifest> {
    vec![
        ToolManifest {
            id: "structured.json".into(), label: "JSON".into(), contract_version: 1,
            input_kinds: vec![InputKind::Json],
            limits: ToolLimits { max_input_bytes: None, max_output_bytes: None },
            capabilities: local_streaming_capabilities(),
            operations: vec![operation("inspect", "Inspect"), operation("format", "Format"), operation("minify", "Minify")],
            renderer: RendererKind::Json,
        },
        ToolManifest {
            id: "encoding.image-base64".into(), label: "Image to Base64".into(), contract_version: 1,
            input_kinds: vec![InputKind::Bytes],
            limits: ToolLimits { max_input_bytes: Some(25 * 1024 * 1024), max_output_bytes: None },
            capabilities: ToolCapabilities {
                deterministic: true, supports_preview: true, supports_streaming: true, cancellation: true,
                progress: true, needs_filesystem: false, needs_network: false, needs_secrets: false,
            },
            operations: vec![operation("encode", "Encode")], renderer: RendererKind::Text,
        },
        ToolManifest {
            id: "encoding.base64-image".into(), label: "Base64 to Image".into(), contract_version: 1,
            input_kinds: vec![InputKind::Text],
            limits: ToolLimits { max_input_bytes: Some(32 * 1024 * 1024), max_output_bytes: Some(24 * 1024 * 1024) },
            capabilities: ToolCapabilities { deterministic:true, supports_preview:true, supports_streaming:true, cancellation:true, progress:true, needs_filesystem:false, needs_network:false, needs_secrets:false },
            operations: vec![operation("decode", "Decode")], renderer: RendererKind::Binary,
        },
        ToolManifest {
            id: "encoding.hash".into(), label: "Hash Generator".into(), contract_version: 1,
            input_kinds: vec![InputKind::Bytes],
            limits: ToolLimits { max_input_bytes: None, max_output_bytes: Some(4096) },
            capabilities: ToolCapabilities { deterministic: true, supports_preview: true, supports_streaming: true, cancellation: true, progress: true, needs_filesystem: true, needs_network: false, needs_secrets: false },
            operations: vec![operation("sha256", "SHA-256"), operation("sha512", "SHA-512")], renderer: RendererKind::Text,
        },
        ToolManifest {
            id: "structured.csv".into(), label: "CSV".into(), contract_version: 1,
            input_kinds: vec![InputKind::Csv],
            limits: ToolLimits { max_input_bytes: None, max_output_bytes: None },
            capabilities: local_streaming_capabilities(),
            operations: vec![operation("inspect", "Inspect")], renderer: RendererKind::Table,
        },
        ToolManifest {
            id: "text.inspect".into(), label: "Text".into(), contract_version: 1,
            input_kinds: vec![InputKind::Text],
            limits: ToolLimits { max_input_bytes: None, max_output_bytes: None },
            capabilities: local_streaming_capabilities(),
            operations: vec![operation("inspect", "Inspect")], renderer: RendererKind::Text,
        },
        text_manifest("text.url", "URL Encode / Decode", vec![("encode", "Encode"), ("decode", "Decode")]),
        text_manifest("text.html", "HTML Escape / Unescape", vec![("escape", "Escape"), ("unescape", "Unescape")]),
        text_manifest("text.unicode", "Unicode Escape / Unescape", vec![("encode", "Escape"), ("decode", "Unescape")]),
        crate::compare::compare_manifest(),
        ToolManifest {
            id: "web.curl-code".into(), label: "cURL to Code".into(), contract_version: 1,
            input_kinds: vec![InputKind::Text], limits: ToolLimits { max_input_bytes: Some(1024 * 1024), max_output_bytes: Some(4 * 1024 * 1024) },
            capabilities: ToolCapabilities { deterministic:true, supports_preview:true, supports_streaming:false, cancellation:true, progress:false, needs_filesystem:false, needs_network:false, needs_secrets:false },
            operations: vec![operation("fetch", "Generate fetch"), operation("python", "Generate Python requests")], renderer: RendererKind::Text,
        },
    ]
}

fn text_manifest(id: &str, label: &str, ops: Vec<(&str, &str)>) -> ToolManifest {
    ToolManifest { id: id.into(), label: label.into(), contract_version: 1,
        input_kinds: vec![InputKind::Text], limits: ToolLimits { max_input_bytes: Some(crate::text_utilities::DEFAULT_MAX_INPUT_BYTES as u64), max_output_bytes: Some(crate::text_utilities::DEFAULT_MAX_OUTPUT_BYTES as u64) },
        capabilities: ToolCapabilities { deterministic:true, supports_preview:true, supports_streaming:true, cancellation:true, progress:true, needs_filesystem:false, needs_network:false, needs_secrets:false },
        operations: ops.into_iter().map(|(id,label)| operation(id,label)).collect(), renderer: RendererKind::Text }
}

#[derive(Debug)]
pub struct ToolResult { pub output: Document, pub diagnostics: Vec<Diagnostic> }

/// Compatibility contract for the first in-memory tools.
pub trait Tool: Send + Sync {
    fn id(&self) -> &'static str;
    fn title(&self) -> &'static str;
    fn detect(&self, input: &Document) -> f32;
    fn execute(&self, input: &Document) -> Result<ToolResult, ToolError>;
}

/// A UI-independent execution boundary. The registry owns lookup and common
/// validation, while each tool supplies only its manifest and implementation.
pub trait GenericTool: Send + Sync {
    fn manifest(&self) -> &ToolManifest;
    fn execute(&self, operation_id: &str, input: &Document, options: &Value) -> Result<ToolResult, ToolError>;
}

#[derive(Default)]
pub struct ToolRegistry { tools: HashMap<String, Box<dyn GenericTool>> }

impl ToolRegistry {
    pub fn new() -> Self { Self::default() }

    pub fn register<T: GenericTool + 'static>(&mut self, tool: T) -> Result<(), ToolError> {
        let id = tool.manifest().id.clone();
        if self.tools.contains_key(&id) {
            return Err(ToolError::Execution { message: format!("tool id {id} is already registered") });
        }
        self.tools.insert(id, Box::new(tool));
        Ok(())
    }

    pub fn manifests(&self) -> Vec<ToolManifest> {
        let mut manifests: Vec<_> = self.tools.values().map(|tool| tool.manifest().clone()).collect();
        manifests.sort_by(|a, b| a.id.cmp(&b.id));
        manifests
    }

    pub fn execute(&self, tool_id: &str, operation_id: &str, input: &Document, options: &Value) -> Result<ToolResult, ToolError> {
        let tool = self.tools.get(tool_id).ok_or_else(|| ToolError::UnknownTool { tool_id: tool_id.into() })?;
        tool.manifest().supports(input.kind.into(), operation_id)?;
        if !options.is_object() {
            return Err(ToolError::InvalidOptions { message: "options must be a JSON object".into() });
        }
        if let Some(max) = tool.manifest().limits.max_input_bytes {
            if input.len() as u64 > max {
                return Err(ToolError::ResourceLimit { message: format!("input exceeds the {max}-byte tool limit") });
            }
        }
        tool.execute(operation_id, input, options)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct SampleTool { manifest: ToolManifest }
    impl GenericTool for SampleTool {
        fn manifest(&self) -> &ToolManifest { &self.manifest }
        fn execute(&self, operation_id: &str, input: &Document, _options: &Value) -> Result<ToolResult, ToolError> {
            Ok(ToolResult {
                output: Document::from_text(format!("{operation_id}:{}", input.as_text().map_err(|_| ToolError::InvalidUtf8)?)),
                diagnostics: Vec::new(),
            })
        }
    }

    fn sample_manifest() -> ToolManifest {
        ToolManifest {
            id: "test.sample".into(), label: "Sample".into(), contract_version: 1,
            input_kinds: vec![InputKind::Text],
            limits: ToolLimits { max_input_bytes: Some(32), max_output_bytes: Some(64) },
            capabilities: ToolCapabilities {
                deterministic: true, supports_preview: true, supports_streaming: false, cancellation: false,
                progress: false, needs_filesystem: false, needs_network: false, needs_secrets: false,
            },
            operations: vec![operation("echo", "Echo")], renderer: RendererKind::Text,
        }
    }

    #[test]
    fn manifest_round_trips_as_json() {
        let manifest = sample_manifest();
        let json = serde_json::to_string(&manifest).unwrap();
        assert!(json.contains("\"inputKinds\":[\"text\"]"));
        assert!(json.contains("\"renderer\":\"text\""));
        assert_eq!(serde_json::from_str::<ToolManifest>(&json).unwrap(), manifest);
    }

    #[test]
    fn sample_tool_registers_and_runs_through_generic_boundary() {
        let mut registry = ToolRegistry::new();
        registry.register(SampleTool { manifest: sample_manifest() }).unwrap();
        let result = registry.execute("test.sample", "echo", &Document::from_text("hello"), &serde_json::json!({})).unwrap();
        assert_eq!(result.output.as_text().unwrap(), "echo:hello");
        assert_eq!(registry.manifests()[0].id, "test.sample");
    }

    #[test]
    fn invalid_tool_and_input_kind_are_structured() {
        let mut registry = ToolRegistry::new();
        registry.register(SampleTool { manifest: sample_manifest() }).unwrap();
        let unknown = registry.execute("missing", "echo", &Document::from_text("x"), &serde_json::json!({})).unwrap_err();
        assert!(matches!(unknown, ToolError::UnknownTool { tool_id } if tool_id == "missing"));
        let binary = Document::from_bytes(vec![0xff]).with_kind(DocumentKind::Binary);
        let unsupported = registry.execute("test.sample", "echo", &binary, &serde_json::json!({})).unwrap_err();
        assert!(matches!(&unsupported, ToolError::UnsupportedInputKind { tool_id, input_kind } if tool_id == "test.sample" && input_kind == "bytes"));
        assert_eq!(serde_json::to_value(unsupported).unwrap()["code"], "unsupported_input_kind");
    }

    #[test]
    fn operation_options_and_size_are_validated_before_execution() {
        let mut registry = ToolRegistry::new();
        registry.register(SampleTool { manifest: sample_manifest() }).unwrap();
        let input = Document::from_text("hello");
        assert!(matches!(registry.execute("test.sample", "missing", &input, &serde_json::json!({})), Err(ToolError::UnsupportedOperation { .. })));
        assert!(matches!(registry.execute("test.sample", "echo", &input, &serde_json::json!(true)), Err(ToolError::InvalidOptions { .. })));
        assert!(matches!(registry.execute("test.sample", "echo", &Document::from_text("x".repeat(33)), &serde_json::json!({})), Err(ToolError::ResourceLimit { .. })));
    }

    #[test]
    fn duplicate_registration_is_rejected_without_replacing_tool() {
        let mut registry = ToolRegistry::new();
        registry.register(SampleTool { manifest: sample_manifest() }).unwrap();
        assert!(registry.register(SampleTool { manifest: sample_manifest() }).is_err());
        let result = registry.execute("test.sample", "echo", &Document::from_text("ok"), &serde_json::json!({})).unwrap();
        assert_eq!(result.output.as_text().unwrap(), "echo:ok");
    }
}
