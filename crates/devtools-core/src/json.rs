use crate::{Diagnostic, Document, DocumentKind, Severity, Tool, ToolError, ToolResult};

#[derive(Debug, Clone, Copy)]
pub struct JsonOptions { pub indent: usize, pub minify: bool }
impl Default for JsonOptions { fn default() -> Self { Self { indent: 2, minify: false } } }
pub struct JsonTool { pub options: JsonOptions }
impl JsonTool { pub fn new(options: JsonOptions) -> Self { Self { options } } }

impl Tool for JsonTool {
    fn id(&self) -> &'static str { "structured.json.format" }
    fn title(&self) -> &'static str { "Format JSON" }
    fn detect(&self, input: &Document) -> f32 { let Ok(text) = input.as_text() else { return 0.0 }; let t = text.trim_start(); if t.starts_with('{') || t.starts_with('[') { 0.85 } else { 0.0 } }
    fn execute(&self, input: &Document) -> Result<ToolResult, ToolError> {
        let text = input.as_text().map_err(|_| ToolError::InvalidUtf8)?;
        let value: serde_json::Value = serde_json::from_str(text).map_err(|e| ToolError::Execution { message: e.to_string() })?;
        let rendered = if self.options.minify { serde_json::to_string(&value) } else { serde_json::to_string_pretty(&value) }.map_err(|e| ToolError::Execution { message: e.to_string() })?;
        Ok(ToolResult { output: Document::from_text(rendered).with_kind(DocumentKind::Json).with_mime("application/json"), diagnostics: vec![Diagnostic { severity: Severity::Info, message: "JSON parsed successfully".into(), start: 0, end: input.len() }] })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn formats_json() { let r = JsonTool::new(JsonOptions::default()).execute(&Document::from_text("{\"a\":1}")).unwrap(); assert!(r.output.as_text().unwrap().contains('\n')); }
    #[test] fn detects_json() { let t = JsonTool::new(JsonOptions::default()); assert!(t.detect(&Document::from_text(" [1,2]")) > 0.8); }
}
