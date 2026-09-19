//! Native plugin implementations kept outside the Tauri command module.
//!
//! A plugin owns its operation semantics here; the host still owns document
//! access, limits, cancellation, job lifecycle, and result publication.

use super::plugin_host::{NativeExecutionContext, PluginHost};
use devtools_core::{compare_documents, transform_json_bytes, CompareOptions, Document, DocumentKind, JsonLayout, TextUtilityKind, TextUtilityOptions, ToolError, ToolLimits};
use serde_json::Value;

/// Register native implementations after the compatibility registry has been
/// populated. The manifest comes from the same built-in contract used by the
/// host, so this function only binds implementation to capability.
pub fn register(host: &mut PluginHost) -> Result<(), ToolError> {
    host.replace_native("structured.json", execute_json)?;
    host.replace_native("text.url", execute_url)?;
    host.replace_native("text.compare", execute_compare)
}

/// Requested limits may tighten the native engine defaults, never raise them.
pub fn compare_limits(options: &Value) -> Result<ToolLimits, ToolError> {
    let options: CompareOptions = serde_json::from_value(options.clone())
        .map_err(|error| ToolError::InvalidOptions { message: error.to_string() })?;
    Ok(ToolLimits {
        max_input_bytes: Some(options.max_input_bytes.unwrap_or(devtools_core::DEFAULT_MAX_INPUT_BYTES).min(devtools_core::DEFAULT_MAX_INPUT_BYTES) as u64),
        max_output_bytes: Some(options.max_output_bytes.unwrap_or(devtools_core::DEFAULT_MAX_OUTPUT_BYTES).min(devtools_core::DEFAULT_MAX_OUTPUT_BYTES) as u64),
    })
}

fn execute_compare(context: &mut NativeExecutionContext<'_>) -> Result<(), ToolError> {
    if context.operation_id() != "compare" {
        return Err(ToolError::UnsupportedOperation { tool_id: "text.compare".into(), operation_id: context.operation_id().into() });
    }
    let options: CompareOptions = serde_json::from_value(context.options().clone())
        .map_err(|error| ToolError::InvalidOptions { message: error.to_string() })?;
    let left = Document::from_bytes(context.read_input("left")?);
    let right = Document::from_bytes(context.read_input("right")?);
    let (comparison, _) = compare_documents(&left, &right, &options, context.cancellation(), |p| context.progress(p))?;
    let bytes = serde_json::to_vec_pretty(&comparison).map_err(|error| ToolError::Execution { message: error.to_string() })?;
    let max_output = options.max_output_bytes.unwrap_or(devtools_core::DEFAULT_MAX_OUTPUT_BYTES).min(devtools_core::DEFAULT_MAX_OUTPUT_BYTES);
    if bytes.len() > max_output { return Err(ToolError::ResourceLimit { message: format!("diff output exceeds {max_output} bytes") }); }
    context.set_summary(serde_json::to_string(&comparison.summary).map_err(|error| ToolError::Execution { message: error.to_string() })?);
    context.write_output("result", &bytes, Some("application/json"))?;
    Ok(())
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
        context.add_input("source", br#"{ "b": 1.2300, "a": 2 }"#.to_vec()).unwrap();
        execute_json(&mut context).unwrap();
        let output = context.take_outputs().pop().unwrap();
        assert_eq!(String::from_utf8(output.bytes).unwrap(), "{\n  \"b\": 1.2300,\n  \"a\": 2\n}");
    }

    #[test]
    fn closes_scalar_only_containers_on_their_own_line() {
        // Numbers and literals must mark a container non-empty just as strings and
        // nested containers do; otherwise `[1, 2]` closed on the last element's
        // line, diverging from JSON.stringify(value, null, 2) and from the
        // reference processor in plugins/json.
        let options = Value::Object(Default::default());
        let token = CancellationToken::default();
        let progress = |_: devtools_core::Progress| {};
        let mut context = NativeExecutionContext::new("format", &options, &token, &progress, 1024, None);
        context.add_input("source", br#"{"a":[1,2],"b":[true,null,-0.5e3],"c":[],"d":{}}"#.to_vec()).unwrap();
        execute_json(&mut context).unwrap();
        let output = context.take_outputs().pop().unwrap();
        assert_eq!(String::from_utf8(output.bytes).unwrap(), "{\n  \"a\": [\n    1,\n    2\n  ],\n  \"b\": [\n    true,\n    null,\n    -0.5e3\n  ],\n  \"c\": [],\n  \"d\": {}\n}");
    }

    #[test]
    fn rejects_unknown_operation() {
        let options = Value::Object(Default::default());
        let token = CancellationToken::default();
        let progress = |_: devtools_core::Progress| {};
        let mut context = NativeExecutionContext::new("inspect", &options, &token, &progress, 1024, None);
        context.add_input("source", b"{}".to_vec()).unwrap();
        let error = execute_json(&mut context).unwrap_err();
        assert!(matches!(error, ToolError::UnsupportedOperation { .. }));
    }

    #[test]
    fn rejects_invalid_json_before_producing_output() {
        let options = Value::Object(Default::default());
        let token = CancellationToken::default();
        let progress = |_: devtools_core::Progress| {};
        let mut context = NativeExecutionContext::new("format", &options, &token, &progress, 1024, None);
        context.add_input("source", b"{broken".to_vec()).unwrap();
        let error = execute_json(&mut context).unwrap_err();
        assert!(matches!(error, ToolError::InvalidJson { .. }));
    }

    #[test]
    fn url_transform_uses_named_source_and_result_ports() {
        let options = Value::Object(Default::default());
        let token = CancellationToken::default();
        let progress = |_: devtools_core::Progress| {};
        let mut context = NativeExecutionContext::new("encode", &options, &token, &progress, 1024, None);
        context.add_input("source", b"a b".to_vec()).unwrap();
        execute_url(&mut context).unwrap();
        let output = context.take_outputs().pop().unwrap();
        assert_eq!(String::from_utf8(output.bytes).unwrap(), "a%20b");
    }

    #[test]
    fn compare_transform_uses_left_and_right_ports() {
        let options = serde_json::json!({});
        let token = CancellationToken::default();
        let progress = |_: devtools_core::Progress| {};
        let mut context = NativeExecutionContext::new("compare", &options, &token, &progress, 1024, Some(1024 * 1024));
        context.add_input("left", b"same\n".to_vec()).unwrap();
        context.add_input("right", b"changed\n".to_vec()).unwrap();
        execute_compare(&mut context).unwrap();
        let output = context.take_outputs().pop().unwrap();
        let json: Value = serde_json::from_slice(&output.bytes).unwrap();
        assert_eq!(json["summary"]["identical"], false);
        assert!(json["hunks"].is_array());
    }
}
