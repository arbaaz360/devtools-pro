//! Native plugin implementations kept outside the Tauri command module.
//!
//! A plugin owns its operation semantics here; the host still owns document
//! access, limits, cancellation, job lifecycle, and result publication.

use super::plugin_host::PluginHost;
use devtools_core::{transform_json_bytes, CancellationToken, Document, DocumentKind, JsonLayout, Progress, ToolError, ToolResult};
use serde_json::Value;

/// Register native implementations after the compatibility registry has been
/// populated. The manifest comes from the same built-in contract used by the
/// host, so this function only binds implementation to capability.
pub fn register(host: &mut PluginHost) -> Result<(), ToolError> {
    host.replace_native("structured.json", execute_json)
}

pub(crate) fn execute_json(
    operation_id: &str,
    input: &Document,
    _options: &Value,
    cancellation: &CancellationToken,
    progress: &dyn Fn(Progress),
) -> Result<ToolResult, ToolError> {
    let layout = match operation_id {
        "format" => JsonLayout::Pretty,
        "minify" => JsonLayout::Minify,
        _ => return Err(ToolError::UnsupportedOperation { tool_id: "structured.json".into(), operation_id: operation_id.into() }),
    };
    let (output, _) = transform_json_bytes(input.bytes(), layout, cancellation, progress)?;
    Ok(ToolResult {
        output: Document::from_bytes(output).with_kind(DocumentKind::Json).with_mime("application/json"),
        diagnostics: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_json_order_and_number_lexemes() {
        let input = Document::from_text(r#"{ "b": 1.2300, "a": 2 }"#).with_kind(DocumentKind::Text);
        let result = execute_json("format", &input, &Value::Object(Default::default()), &CancellationToken::default(), &|_| {}).unwrap();
        assert_eq!(result.output.as_text().unwrap(), "{\n  \"b\": 1.2300,\n  \"a\": 2\n}");
    }

    #[test]
    fn rejects_unknown_operation() {
        let input = Document::from_text("{}");
        let error = execute_json("inspect", &input, &Value::Object(Default::default()), &CancellationToken::default(), &|_| {}).unwrap_err();
        assert!(matches!(error, ToolError::UnsupportedOperation { .. }));
    }

    #[test]
    fn rejects_invalid_json_before_producing_output() {
        let input = Document::from_text("{broken");
        let error = execute_json("format", &input, &Value::Object(Default::default()), &CancellationToken::default(), &|_| {}).unwrap_err();
        assert!(matches!(error, ToolError::InvalidJson { .. }));
    }
}
