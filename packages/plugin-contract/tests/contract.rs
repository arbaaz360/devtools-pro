use devtools_plugin_contract::{normalize_v1, parse_manifest, parse_request, validate_wire, ContractError};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn fixture(path: &str) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&fs::read_to_string(root.join("fixtures").join(path)).unwrap()).unwrap()
}

#[test]
fn representative_manifest_and_requests_round_trip() {
    let manifest_value = fixture("valid/manifest-comprehensive.json");
    let manifest = parse_manifest(&manifest_value).expect("manifest must validate");
    assert_eq!(manifest.id, "examples.contract");
    assert_eq!(manifest.tools.len(), 6);
    let encoded = serde_json::to_value(&manifest).expect("manifest serializes");
    assert_eq!(parse_manifest(&encoded).expect("serialized manifest validates").id, manifest.id);
    let request = parse_request(&fixture("valid/request-selection.json"), &manifest).expect("selection request must validate");
    assert_eq!(request.generation, "7");
    let linked = parse_request(&fixture("valid/representative.json"), &manifest).expect("linked request must validate");
    assert_eq!(linked.generation, "9007199254740993");
    validate_wire(&fixture("valid/event-preview.json")).expect("completed event must validate");
}

#[test]
fn invalid_fixtures_fail_in_schema_or_semantic_validation() {
    for name in ["unknown-version.json", "duplicate-id.json", "dangling-reference.json", "invalid-default.json", "unknown-capability.json"] {
        let value = fixture(&format!("invalid/{name}"));
        assert!(parse_manifest(&value).is_err(), "{name} unexpectedly accepted");
    }
}

#[test]
fn v1_normalization_preserves_stable_tool_and_operation_ids() {
    let normalized = normalize_v1(&fixture("valid/v1-legacy.json")).expect("legacy manifest normalizes");
    assert_eq!(normalized.id, "structured.json");
    assert_eq!(normalized.tools[0].id, "structured.json");
    assert_eq!(normalized.operations[0].id, "format");
    assert_eq!(normalized.operations[0].inputs[0].id, "input");
}

#[test]
fn schema_rejects_unknown_properties_and_unsafe_json_numbers() {
    let mut value = fixture("valid/manifest-comprehensive.json");
    value.as_object_mut().unwrap().insert("unknownField".into(), Value::Bool(true));
    assert!(matches!(parse_manifest(&value), Err(ContractError::Schema(_))));
    let mut request = fixture("valid/representative.json");
    request["generation"] = Value::Number(serde_json::Number::from(3));
    assert!(parse_manifest(&fixture("valid/manifest-comprehensive.json")).is_ok());
    assert!(validate_wire(&request).is_err(), "generation must be a decimal string on the wire");
}
