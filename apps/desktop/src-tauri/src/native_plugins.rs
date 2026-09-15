//! Native plugin implementations kept outside the Tauri command module.
//!
//! A plugin owns its operation semantics here; the host still owns document
//! access, limits, cancellation, job lifecycle, and result publication.

use super::plugin_host::{NativeExecutionContext, PluginHost};
use devtools_core::{transform_json_bytes, Document, DocumentKind, JsonLayout, TextUtilityKind, TextUtilityOptions, ToolError};

/// Register native implementations after the compatibility registry has been
/// populated. The manifest comes from the same built-in contract used by the
/// host, so this function only binds implementation to capability.
pub fn register(host: &mut PluginHost) -> Result<(), ToolError> {
    host.replace_native("structured.json", execute_json)?;
    host.replace_native("text.url", execute_url)
}

pub(crate) fn execute_json(context: &mut NativeExecutionContext<'_>) -> Result<(), ToolError> {
    let layout = match context.operation_id() {
        "format" => JsonLayout::Pretty,
        "minify" => JsonLayout::Minify,
        operation_id => return Err(ToolError::UnsupportedOperation { tool_id: "structured.json".into(), operation_id: operation_id.into() }),
    };
    let input = context.read_input("source").map_err(|error| ToolError::Execution { message: error.to_string() })?;
    let (output, _) = transform_json_bytes(&input, layout, context.cancellation(), |progress| context.progress(progress))?;
    context.write_output("result", &output, Some("application/json")).map_err(|error| ToolError::Execution { message: error.to_string() })?;
    Ok(())
}

fn execute_url(context: &mut NativeExecutionContext<'_>) -> Result<(), ToolError> {
    let operation_id = context.operation_id();
    let input = context.read_input("source").map_err(|error| ToolError::Execution { message: error.to_string() })?;
    let document = Document::from_bytes(input).with_kind(DocumentKind::Text);
    let options: TextUtilityOptions = serde_json::from_value(context.options().clone()).map_err(|error| ToolError::InvalidOptions { message: error.to_string() })?;
    context.progress(devtools_core::Progress { bytes_processed: 0, total_bytes: document.len() as u64, phase: "transforming".into() });
    let result = devtools_core::transform_text(&document, TextUtilityKind::Url, operation_id, &options)?;
    context.write_output("result", result.output.bytes(), result.output.mime.as_deref()).map_err(|error| ToolError::Execution { message: error.to_string() })?;
    context.progress(devtools_core::Progress { bytes_processed: document.len() as u64, total_bytes: document.len() as u64, phase: "complete".into() });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use devtools_core::CancellationToken;
    use serde_json::Value;

    #[test]
    fn preserves_json_order_and_number_lexemes() {
        let options = Value::Object(Default::default());
        let token = CancellationToken::default();
        let progress = |_: devtools_core::Progress| {};
        let mut context = NativeExecutionContext::new("format", &options, &token, &progress, 1024, None);
        context.add_input("source", br#"{ "b": 1.2300, "a": 2 }"#.to_vec());
        execute_json(&mut context).unwrap();
        let output = context.take_outputs().pop().unwrap();
        assert_eq!(String::from_utf8(output.bytes).unwrap(), "{\n  \"b\": 1.2300,\n  \"a\": 2\n}");
    }

    #[test]
    fn rejects_unknown_operation() {
        let options = Value::Object(Default::default());
        let token = CancellationToken::default();
        let progress = |_: devtools_core::Progress| {};
        let mut context = NativeExecutionContext::new("inspect", &options, &token, &progress, 1024, None);
        context.add_input("source", b"{}".to_vec());
        let error = execute_json(&mut context).unwrap_err();
        assert!(matches!(error, ToolError::UnsupportedOperation { .. }));
    }

    #[test]
    fn rejects_invalid_json_before_producing_output() {
        let options = Value::Object(Default::default());
        let token = CancellationToken::default();
        let progress = |_: devtools_core::Progress| {};
        let mut context = NativeExecutionContext::new("format", &options, &token, &progress, 1024, None);
        context.add_input("source", b"{broken".to_vec());
        let error = execute_json(&mut context).unwrap_err();
        assert!(matches!(error, ToolError::InvalidJson { .. }));
    }

    #[test]
    fn url_transform_uses_named_source_and_result_ports() {
        let options = Value::Object(Default::default());
        let token = CancellationToken::default();
        let progress = |_: devtools_core::Progress| {};
        let mut context = NativeExecutionContext::new("encode", &options, &token, &progress, 1024, None);
        context.add_input("source", b"a b".to_vec());
        execute_url(&mut context).unwrap();
        let output = context.take_outputs().pop().unwrap();
        assert_eq!(String::from_utf8(output.bytes).unwrap(), "a%20b");
    }
}
