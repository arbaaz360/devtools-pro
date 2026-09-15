use crate::generated::*;
use crate::schema::{parse_and_validate, validate_wire, SchemaError};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ContractError {
    #[error(transparent)] Schema(#[from] SchemaError),
    #[error("semantic validation failed at {path}: {message}")] Semantic { path: String, message: String },
}

fn semantic(path: impl Into<String>, message: impl Into<String>) -> ContractError { ContractError::Semantic { path: path.into(), message: message.into() } }
fn object<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>, ContractError> { value.as_object().ok_or_else(|| semantic(path, "expected object")) }
fn array<'a>(value: &'a Value, path: &str) -> Result<&'a Vec<Value>, ContractError> { value.as_array().ok_or_else(|| semantic(path, "expected array")) }
fn text<'a>(value: &'a Value, path: &str) -> Result<&'a str, ContractError> { value.as_str().ok_or_else(|| semantic(path, "expected string")) }
fn ids(values: impl Iterator<Item = String>, path: &str) -> Result<HashSet<String>, ContractError> {
    let mut result = HashSet::new();
    for id in values { if !result.insert(id.clone()) { return Err(semantic(path, format!("duplicate id {id}"))); } }
    Ok(result)
}
fn decimal_integer(value: &str) -> bool {
    let digits = value.strip_prefix('-').unwrap_or(value);
    digits == "0" || (digits.chars().all(|c| c.is_ascii_digit()) && (digits.len() == 1 || digits.as_bytes()[0] != b'0'))
}
fn compare_integer(left: &str, right: &str) -> Option<std::cmp::Ordering> {
    if !decimal_integer(left) || !decimal_integer(right) { return None; }
    let neg_left = left.starts_with('-'); let neg_right = right.starts_with('-');
    if neg_left != neg_right { return Some(if neg_left { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater }); }
    let a = left.trim_start_matches('-').trim_start_matches('0'); let b = right.trim_start_matches('-').trim_start_matches('0');
    let ord = a.len().cmp(&b.len()).then_with(|| a.cmp(b)); Some(if neg_left { ord.reverse() } else { ord })
}

pub fn parse_manifest(value: &Value) -> Result<PluginManifest, ContractError> {
    validate_wire(value)?;
    validate_manifest_semantics(value)?;
    Ok(parse_and_validate(value)?)
}

pub fn validate_manifest_semantics(value: &Value) -> Result<(), ContractError> {
    let root = object(value, "$")?;
    let tools = array(root.get("tools").ok_or_else(|| semantic("$.tools", "missing tools"))?, "$.tools")?;
    let operations = array(root.get("operations").ok_or_else(|| semantic("$.operations", "missing operations"))?, "$.operations")?;
    let workspaces = array(root.get("workspaces").ok_or_else(|| semantic("$.workspaces", "missing workspaces"))?, "$.workspaces")?;
    let tool_ids = ids(tools.iter().map(|item| item["id"].as_str().unwrap().to_owned()), "$.tools")?;
    let operation_ids = ids(operations.iter().map(|item| item["id"].as_str().unwrap().to_owned()), "$.operations")?;
    let workspace_ids = ids(workspaces.iter().map(|item| item["id"].as_str().unwrap().to_owned()), "$.workspaces")?;
    let aliases = root.get("aliases").and_then(Value::as_array).cloned().unwrap_or_default();
    ids(aliases.iter().map(|item| item["id"].as_str().unwrap().to_owned()), "$.aliases")?;
    for (index, alias) in aliases.iter().enumerate() { let target = text(&alias["toolId"], &format!("$.aliases[{index}].toolId"))?; if !tool_ids.contains(target) { return Err(semantic(format!("$.aliases[{index}].toolId"), "dangling tool reference")); } }

    for (index, tool) in tools.iter().enumerate() {
        let path = format!("$.tools[{index}]");
        if !workspace_ids.contains(text(&tool["workspaceId"], &format!("{path}.workspaceId"))?) { return Err(semantic(format!("{path}.workspaceId"), "dangling workspace reference")); }
        for operation in array(&tool["operationIds"], &format!("{path}.operationIds"))? { if !operation_ids.contains(text(operation, &format!("{path}.operationIds"))?) { return Err(semantic(path, "dangling operation reference")); } }
    }
    let mut known_capabilities = HashSet::new();
    for (index, capability) in array(&root["capabilities"], "$.capabilities")?.iter().enumerate() { let id = text(&capability["id"], &format!("$.capabilities[{index}].id"))?; if !known_capabilities.insert(id) { return Err(semantic(format!("$.capabilities[{index}].id"), "duplicate capability request")); } }
    for (index, operation) in operations.iter().enumerate() { validate_operation(operation, index, &operation_ids)?; }
    for (index, workspace) in workspaces.iter().enumerate() { validate_workspace(workspace, index, operations, &operation_ids)?; }
    if let Some(detection) = root.get("detection") { if let Some(executor) = detection.get("probeExecutor").and_then(Value::as_str) { if !operation_ids.contains(executor) { return Err(semantic("$.detection.probeExecutor", "dangling executor reference")); } } }
    validate_option_list(array(&root["settings"], "$.settings")?, "$.settings", &HashSet::new())?;
    Ok(())
}

fn validate_operation(value: &Value, index: usize, _all: &HashSet<String>) -> Result<(), ContractError> {
    let path = format!("$.operations[{index}]"); let operation = object(value, &path)?;
    let inputs = array(&operation["inputs"], &format!("{path}.inputs"))?; let outputs = array(&operation["outputs"], &format!("{path}.outputs"))?;
    let input_ids = ids(inputs.iter().map(|item| item["id"].as_str().unwrap().to_owned()), &format!("{path}.inputs"))?;
    let _output_ids = ids(outputs.iter().map(|item| item["id"].as_str().unwrap().to_owned()), &format!("{path}.outputs"))?;
    let option_values = array(&operation["options"], &format!("{path}.options"))?;
    let option_ids = validate_option_list(option_values, &format!("{path}.options"), &HashSet::new())?;
    let trigger = object(&operation["trigger"], &format!("{path}.trigger"))?;
    for port in trigger.get("changedPorts").and_then(Value::as_array).into_iter().flatten() { if !input_ids.contains(text(port, &format!("{path}.trigger.changedPorts"))?) { return Err(semantic(path, "trigger references unknown input port")); } }
    let _option_ids = option_ids;
    for (j, output) in outputs.iter().enumerate() { let reps = array(&output["representations"], &format!("{path}.outputs[{j}].representations"))?; if reps.is_empty() { return Err(semantic(path, "output needs a representation")); } }
    Ok(())
}

fn validate_workspace(value: &Value, index: usize, operations: &[Value], operation_ids: &HashSet<String>) -> Result<(), ContractError> {
    let path = format!("$.workspaces[{index}]"); let workspace = object(value, &path)?;
    let commands = array(&workspace["commands"], &format!("{path}.commands"))?; let command_ids = ids(commands.iter().map(|item| item["id"].as_str().unwrap().to_owned()), &format!("{path}.commands"))?;
    for (j, command) in commands.iter().enumerate() { if let Some(operation) = command.get("operationId").and_then(Value::as_str) { if !operation_ids.contains(operation) { return Err(semantic(format!("{path}.commands[{j}].operationId"), "dangling operation reference")); } } }
    for (j, binding) in array(&workspace["bindings"], &format!("{path}.bindings"))?.iter().enumerate() {
        for field in ["commandIds", "optionIds"] { for item in binding.get(field).and_then(Value::as_array).into_iter().flatten() { let id = text(item, &format!("{path}.bindings[{j}].{field}"))?; if field == "commandIds" && !command_ids.contains(id) { return Err(semantic(format!("{path}.bindings[{j}].{field}"), "dangling command reference")); } if field == "optionIds" && !operations.iter().any(|operation| operation["options"].as_array().is_some_and(|options| options.iter().any(|option| option["id"].as_str() == Some(id)))) { return Err(semantic(format!("{path}.bindings[{j}].{field}"), "dangling option reference")); } } }
        for field in ["inputPort", "selectionSource"] { if let Some(id) = binding.get(field).and_then(Value::as_str) { if !operations.iter().any(|operation| operation["inputs"].as_array().is_some_and(|ports| ports.iter().any(|port| port["id"].as_str() == Some(id)))) { return Err(semantic(format!("{path}.bindings[{j}].{field}"), "dangling input port reference")); } } }
        if let Some(id) = binding.get("outputPort").and_then(Value::as_str) { if !operations.iter().any(|operation| operation["outputs"].as_array().is_some_and(|ports| ports.iter().any(|port| port["id"].as_str() == Some(id)))) { return Err(semantic(format!("{path}.bindings[{j}].outputPort"), "dangling output port reference")); } }
    }
    Ok(())
}

fn validate_option_list(options: &[Value], path: &str, inherited: &HashSet<String>) -> Result<HashSet<String>, ContractError> {
    let mut ids_set = inherited.clone();
    for (index, option) in options.iter().enumerate() {
        let option_path = format!("{path}[{index}]"); let item = object(option, &option_path)?; let id = text(&item["id"], &format!("{option_path}.id"))?.to_owned();
        if !ids_set.insert(id.clone()) { return Err(semantic(format!("{option_path}.id"), "duplicate option id")); }
        let ty = text(&item["type"], &format!("{option_path}.type"))?; let sensitive = item.get("sensitive").and_then(Value::as_bool).unwrap_or(false); let persistence = item.get("persistence").and_then(Value::as_str).unwrap_or("");
        if (ty == "secret" && !sensitive) || (sensitive && persistence == "workspace" || sensitive && persistence == "instance") { return Err(semantic(option_path, "sensitive options must be session-only or non-persistent")); }
        if let Some(default) = item.get("default") { validate_option_value(item, default, &format!("{path}[{index}].default"))?; }
        if let Some(rules) = item.get("rules").and_then(Value::as_array) { for rule in rules { validate_condition(rule.get("when").unwrap_or(&Value::Null), &ids_set, path)?; } }
        if ty == "record" { let nested = array(&item["fields"], &format!("{option_path}.fields"))?; validate_option_list(nested, &format!("{option_path}.fields"), &ids_set)?; }
        if ty == "taggedUnion" { for variant in array(&item["variants"], &format!("{option_path}.variants"))? { validate_option_list(array(&variant["fields"], &format!("{option_path}.variants.fields"))?, &format!("{option_path}.variants.fields"), &ids_set)?; } }
    }
    Ok(ids_set)
}

fn validate_condition(value: &Value, option_ids: &HashSet<String>, path: &str) -> Result<(), ContractError> {
    let obj = object(value, path)?; match obj.get("kind").and_then(Value::as_str) {
        Some("predicate") => { let id = text(&obj["optionId"], path)?; if !option_ids.contains(id) { return Err(semantic(path, "condition references unknown option")); } }
        Some("all") | Some("any") => for condition in array(&obj["conditions"], path)? { validate_condition(condition, option_ids, path)?; },
        Some("not") => validate_condition(&obj["condition"], option_ids, path)?,
        _ => return Err(semantic(path, "unknown condition kind")),
    } Ok(())
}

fn validate_option_value(spec: &Map<String, Value>, value: &Value, path: &str) -> Result<(), ContractError> {
    let ty = spec.get("type").and_then(Value::as_str).unwrap_or(""); match ty {
        "boolean" => if !value.is_boolean() { return Err(semantic(path, "boolean option default must be boolean")); },
        "string" | "document" => if !value.is_string() { return Err(semantic(path, "string option default must be string")); },
        "integer" => { let text = value.as_str().ok_or_else(|| semantic(path, "integer defaults are decimal strings"))?; if !decimal_integer(text) { return Err(semantic(path, "invalid decimal integer")); } if let Some(min) = spec.get("minimum").and_then(Value::as_str) { if compare_integer(text, min) == Some(std::cmp::Ordering::Less) { return Err(semantic(path, "default below minimum")); } } if let Some(max) = spec.get("maximum").and_then(Value::as_str) { if compare_integer(text, max) == Some(std::cmp::Ordering::Greater) { return Err(semantic(path, "default above maximum")); } } },
        "decimal" => if !value.as_str().map(|text| !text.is_empty()).unwrap_or(false) { return Err(semantic(path, "decimal defaults are exact strings")); },
        "enum" => { let selected = text(value, path)?; let choices = array(&spec["choices"], path)?; if !choices.iter().any(|choice| choice.get("id").and_then(Value::as_str) == Some(selected)) { return Err(semantic(path, "enum default is not one of choices")); } },
        "list" => { let values = array(value, path)?; if let Some(min) = spec.get("minItems").and_then(Value::as_str).and_then(|v| v.parse::<usize>().ok()) { if values.len() < min { return Err(semantic(path, "list default below minItems")); } } if let Some(item_type) = spec.get("items").and_then(|items| items.get("type")).and_then(Value::as_str) { for item in values { let valid = match item_type { "boolean" => item.is_boolean(), "string" => item.is_string(), "integer" | "decimal" => item.is_string(), "object" => item.is_object(), _ => true }; if !valid { return Err(semantic(path, "list item does not match declared item type")); } } } },
        "record" => { let defaults = object(value, path)?; let fields = array(&spec["fields"], path)?; for key in defaults.keys() { if !fields.iter().any(|field| field["id"].as_str() == Some(key)) { return Err(semantic(path, "record default references unknown field")); } } for field in fields { if let Some(default) = defaults.get(field["id"].as_str().unwrap()) { validate_option_value(object(field, path)?, default, path)?; } } },
        "taggedUnion" => { let defaults = object(value, path)?; let tag = text(defaults.get("tag").ok_or_else(|| semantic(path, "tagged union default needs tag"))?, path)?; let variants = array(&spec["variants"], path)?; let variant = variants.iter().find(|variant| variant["tag"].as_str() == Some(tag)).ok_or_else(|| semantic(path, "unknown tagged union default tag"))?; for field in array(&variant["fields"], path)? { if let Some(default) = defaults.get(field["id"].as_str().unwrap()) { validate_option_value(object(field, path)?, default, path)?; } } },
        "secret" | "resource" => if !value.is_null() { return Err(semantic(path, "sensitive/resource options do not carry persisted defaults")); },
        _ => return Err(semantic(path, "unknown option type")),
    } Ok(())
}

pub fn parse_request(value: &Value, manifest: &PluginManifest) -> Result<ExecuteRequest, ContractError> {
    validate_wire(value)?; let request: ExecuteRequest = parse_and_validate(value)?;
    if request.plugin_id != manifest.id || request.plugin_version != manifest.version { return Err(semantic("$.pluginId", "request does not target this manifest version")); }
    let operation = manifest.operations.iter().find(|item| item.id == request.operation_id).ok_or_else(|| semantic("$.operationId", "unknown operation"))?;
    let input_defs: HashMap<_, _> = operation.inputs.iter().map(|port| (port.id.as_str(), port)).collect();
    for port in operation.inputs.iter().filter(|port| port.required) { if !request.inputs.contains_key(&port.id) { return Err(semantic("$.inputs", format!("missing required port {}", port.id))); } }
    for key in request.inputs.keys() {
        let port = input_defs.get(key.as_str()).ok_or_else(|| semantic(format!("$.inputs.{key}"), "unknown input port"))?;
        let bindings: Vec<&InputBinding> = match request.inputs.get(key).expect("key came from map") { InputBindingValue::InputBinding(binding) => vec![binding], InputBindingValue::Inline1(bindings) => { if port.multiplicity == PortMultiplicity::One { return Err(semantic(format!("$.inputs.{key}"), "single port received multiple bindings")); } bindings.iter().collect() } };
        for binding in bindings { let matches = match (&port.kind, binding) { (InputPortKind::Document, InputBinding::Document(_)) | (InputPortKind::Value, InputBinding::Value(_)) | (InputPortKind::Selection, InputBinding::Selection(_)) | (InputPortKind::Secret, InputBinding::Secret(_)) | (InputPortKind::File, InputBinding::Resource(_)) | (InputPortKind::Image, InputBinding::Resource(_)) => true, _ => false }; if !matches { return Err(semantic(format!("$.inputs.{key}"), "binding kind does not match declared port")); } }
    }
    let option_specs: HashMap<_, _> = operation.options.iter().map(|item| (option_id(item), item)).collect();
    let options = &request.options;
    for key in options.keys() { let spec = option_specs.get(key.as_str()).ok_or_else(|| semantic(format!("$.options.{key}"), "unknown option"))?; validate_option_value_from_spec(spec, options.get(key).unwrap(), &format!("$.options.{key}"))?; }
    Ok(request)
}

fn option_id(option: &OptionSpec) -> &str { match option { OptionSpec::Boolean(v) => &v.id, OptionSpec::String(v) => &v.id, OptionSpec::Integer(v) => &v.id, OptionSpec::Decimal(v) => &v.id, OptionSpec::Enum(v) => &v.id, OptionSpec::List(v) => &v.id, OptionSpec::Record(v) => &v.id, OptionSpec::TaggedUnion(v) => &v.id, OptionSpec::Document(v) => &v.id, OptionSpec::Secret(v) => &v.id, OptionSpec::Resource(v) => &v.id } }
fn validate_option_value_from_spec(spec: &OptionSpec, value: &Value, path: &str) -> Result<(), ContractError> {
    let json = serde_json::to_value(spec).map_err(|error| semantic(path, error.to_string()))?; validate_option_value(json.as_object().unwrap(), value, path)
}

pub fn normalize_v1(value: &Value) -> Result<PluginManifest, ContractError> {
    let legacy = object(value, "$")?; let id = text(&legacy["id"], "$.id")?.to_owned(); let label = legacy.get("label").or_else(|| legacy.get("title")).and_then(Value::as_str).unwrap_or(&id).to_owned();
    let operation_values = array(&legacy["operations"], "$.operations")?;
    let operations = operation_values.iter().map(|operation| {
        let op = object(operation, "$.operations[]")?; let op_id = text(&op["id"], "$.operations[].id")?.to_owned(); let op_label = text(op.get("label").unwrap_or(&Value::String(op_id.clone())), "$.operations[].label")?.to_owned();
        Ok(serde_json::json!({"id":op_id,"title":op_label,"executor":{"kind":"rust","id":id,"version":"v1","cancellation":"cooperative"},"inputs":[{"id":"input","kind":"document","required":true,"multiplicity":"one"}],"outputs":[{"id":"output","kind":"artifact","multiplicity":"one","representations":["text"],"sensitive":false,"exports":["copyText","save"]}],"options":[],"trigger":{"modes":["inputChange"],"debounceMs":"200"},"limits":{"maxInputBytes":"18446744073709551615","maxOutputBytes":"18446744073709551615","maxChunkBytes":"1048576","deadlineMs":"0"}}))
    }).collect::<Result<Vec<_>, ContractError>>()?;
    let manifest = serde_json::json!({"kind":"pluginManifest","apiVersion":"devtools.plugin/v2","id":id,"version":"0.1.0","stateVersion":1,"tools":[{"id":id,"title":label,"category":"legacy","operationIds":operations.iter().map(|item| item["id"].clone()).collect::<Vec<_>>(),"workspaceId":"legacy"}],"operations":operations,"workspaces":[{"id":"legacy","kind":"transform","bindings":[],"commands":[],"presentationSettings":[]}],"capabilities":[],"settings":[],"tests":{"requirementIds":[],"fixtures":[],"uiScenarios":[]}});
    parse_manifest(&manifest)
}
