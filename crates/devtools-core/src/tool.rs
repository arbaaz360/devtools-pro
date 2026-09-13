use crate::Document;
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity { Info, Warning, Error }
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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
    #[error("tool execution failed: {message}")] Execution { message: String },
}
impl From<std::io::Error> for ToolError {
    fn from(error: std::io::Error) -> Self { Self::Io { message: error.to_string() } }
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolManifest {
    pub id: &'static str,
    pub title: &'static str,
    pub contract_version: u32,
    pub input_formats: Vec<&'static str>,
    pub capabilities: Vec<&'static str>,
}
pub fn builtin_manifests() -> Vec<ToolManifest> {
    vec![
        ToolManifest { id: "structured.json", title: "JSON", contract_version: 1,
            input_formats: vec!["json"], capabilities: vec!["inspect", "validate", "pretty", "minify", "cancel", "progress", "streaming"] },
        ToolManifest { id: "structured.csv", title: "CSV", contract_version: 1,
            input_formats: vec!["csv"], capabilities: vec!["inspect", "validate", "cancel", "progress", "streaming"] },
        ToolManifest { id: "text.inspect", title: "Text", contract_version: 1,
            input_formats: vec!["text"], capabilities: vec!["inspect", "cancel", "progress", "streaming"] },
    ]
}
#[derive(Debug)]
pub struct ToolResult { pub output: Document, pub diagnostics: Vec<Diagnostic> }
pub trait Tool: Send + Sync {
    fn id(&self) -> &'static str;
    fn title(&self) -> &'static str;
    fn detect(&self, input: &Document) -> f32;
    fn execute(&self, input: &Document) -> Result<ToolResult, ToolError>;
}
