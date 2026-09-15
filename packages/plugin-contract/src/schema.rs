use crate::generated::CONTRACT_SCHEMA_JSON;
use regex::Regex;
use serde_json::{Map, Value};
use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("schema validation failed at {path}: {message}")]
pub struct SchemaError { pub path: String, pub message: String }

fn fail(path: &str, message: impl Into<String>) -> SchemaError { SchemaError { path: path.into(), message: message.into() } }

pub fn validate_wire(value: &Value) -> Result<(), SchemaError> {
    let schema: Value = serde_json::from_str(CONTRACT_SCHEMA_JSON).expect("generated schema JSON is valid");
    validate_node(value, &schema, &schema, "$")
}

fn resolve<'a>(root: &'a Value, node: &'a Value) -> &'a Value {
    if let Some(reference) = node.get("$ref").and_then(Value::as_str) {
        let name = reference.strip_prefix("#/$defs/").expect("generator only emits local refs");
        root.get("$defs").and_then(Value::as_object).and_then(|defs| defs.get(name)).expect("generated ref exists")
    } else { node }
}

fn validate_node(value: &Value, original: &Value, root: &Value, path: &str) -> Result<(), SchemaError> {
    let node = resolve(root, original);
    if let Some(options) = node.get("oneOf").and_then(Value::as_array) {
        let mut successes = 0;
        for option in options {
            if validate_node(value, option, root, path).is_ok() { successes += 1; }
        }
        return if successes == 1 { Ok(()) } else { Err(fail(path, format!("expected exactly one schema alternative, matched {successes}"))) };
    }
    if let Some(expected) = node.get("const") {
        if value != expected { return Err(fail(path, format!("expected constant {expected}"))); }
    }
    if let Some(values) = node.get("enum").and_then(Value::as_array) {
        if !values.iter().any(|item| item == value) { return Err(fail(path, "value is not an allowed enum member")); }
    }
    if let Some(kind) = node.get("type").and_then(Value::as_str) {
        let valid = match kind {
            "object" => value.is_object(), "array" => value.is_array(), "string" => value.is_string(),
            "integer" => value.as_i64().is_some() || value.as_u64().is_some(), "number" => value.is_number(),
            "boolean" => value.is_boolean(), "null" => value.is_null(), _ => return Err(fail(path, format!("unsupported type {kind}"))),
        };
        if !valid { return Err(fail(path, format!("expected {kind}"))); }
    }
    if let Some(pattern) = node.get("pattern").and_then(Value::as_str) {
        let text = value.as_str().ok_or_else(|| fail(path, "pattern applies to a string"))?;
        if !Regex::new(pattern).map_err(|error| fail(path, error.to_string()))?.is_match(text) { return Err(fail(path, "string does not match pattern")); }
    }
    if let Some(min) = node.get("minLength").and_then(Value::as_u64) {
        if value.as_str().map(|text| text.chars().count() as u64).unwrap_or(0) < min { return Err(fail(path, "string is shorter than minLength")); }
    }
    if let Some(max) = node.get("maxLength").and_then(Value::as_u64) {
        if value.as_str().map(|text| text.chars().count() as u64).unwrap_or(0) > max { return Err(fail(path, "string is longer than maxLength")); }
    }
    if let Some(min) = node.get("minItems").and_then(Value::as_u64) {
        if value.as_array().map(|items| items.len() as u64).unwrap_or(0) < min { return Err(fail(path, "array is shorter than minItems")); }
    }
    if let Some(obj) = value.as_object() {
        let properties = node.get("properties").and_then(Value::as_object).cloned().unwrap_or_default();
        for required in node.get("required").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            if !obj.contains_key(required) { return Err(fail(path, format!("missing required property {required}"))); }
        }
        for (key, child) in obj {
            if let Some(property) = properties.get(key) { validate_node(child, property, root, &format!("{path}.{key}"))?; }
            else if let Some(extra) = node.get("additionalProperties") {
                if extra == &Value::Bool(false) { return Err(fail(path, format!("unknown property {key}"))); }
                if extra != &Value::Bool(true) { validate_node(child, extra, root, &format!("{path}.{key}"))?; }
            }
        }
    }
    if let Some(items) = node.get("items") {
        if let Some(array) = value.as_array() { for (index, child) in array.iter().enumerate() { validate_node(child, items, root, &format!("{path}[{index}]"))?; } }
    }
    Ok(())
}

pub fn parse_and_validate<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, SchemaError> {
    validate_wire(value)?;
    serde_json::from_value(value.clone()).map_err(|error| fail("$", error.to_string()))
}

#[allow(dead_code)]
fn _map(_value: &Map<String, Value>) {}
