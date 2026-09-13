//! Repeatable, offline acceptance checks for the core shell guarantees.
//!
//! The large fixtures are deliberately read from `benchmarks/fixtures` so the
//! same tests exercise the files used by the benchmark harness.

use devtools_core::{
    inspect_file, preview_file, transform_json_file, CancellationToken, FileFormat, JsonLayout,
    ToolError,
};
use std::{fs, path::{Path, PathBuf}, sync::{Arc, Mutex}};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../benchmarks/fixtures").join(name)
}

fn scratch(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("devtools-acceptance-{name}-{}", std::process::id()))
}

#[test]
fn valid_and_invalid_json_fixtures_have_expected_results() {
    for name in ["bom.json", "lexemes.json", "fixture-50mb.json", "fixture-250mb.json"] {
        let path = fixture(name);
        assert!(path.is_file(), "missing acceptance fixture: {}", path.display());
        let result = inspect_file(&path, FileFormat::Json, &CancellationToken::default(), |_| {});
        assert!(result.is_ok(), "{name} should be valid JSON: {result:?}");
    }
    for name in ["malformed.json", "trailing-content.json", "invalid-utf8.json"] {
        let path = fixture(name);
        assert!(path.is_file(), "missing acceptance fixture: {}", path.display());
        assert!(inspect_file(&path, FileFormat::Json, &CancellationToken::default(), |_| {}).is_err(), "{name} should fail");
    }
}

#[test]
fn large_files_are_streamed_and_previews_are_bounded() {
    for name in ["fixture-50mb.json", "fixture-250mb.json"] {
        let path = fixture(name);
        let size = fs::metadata(&path).expect("large fixture metadata").len();
        // Fixtures are generated with decimal MB targets (the 250 MB corpus is
        // approximately 265 MiB once JSON records are filled out).
        assert!(size >= 50_000_000 && size <= 270_000_000);
        let preview = preview_file(&path, 0, usize::MAX).expect("bounded preview");
        assert!(preview.bytes_read <= 64 * 1024);
        assert!(preview.truncated);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let progress_seen = Arc::clone(&seen);
        let report = inspect_file(&path, FileFormat::Json, &CancellationToken::default(), move |p| progress_seen.lock().unwrap().push(p.bytes_processed));
        assert!(report.is_ok(), "{name} should inspect successfully: {report:?}");
        assert!(!seen.lock().unwrap().is_empty(), "streaming inspection must report progress");
    }
}

#[test]
fn cancellation_and_invalid_encoding_leave_no_temporary_result() {
    let source = fixture("fixture-50mb.json");
    let output = scratch("cancel.json");
    let _ = fs::remove_file(&output);
    let token = CancellationToken::default();
    token.cancel();
    let error = transform_json_file(&source, &output, JsonLayout::Minify, &token, |_| {}).unwrap_err();
    assert!(matches!(error, ToolError::Cancelled));
    assert!(!output.exists());
    let partials: Vec<_> = fs::read_dir(output.parent().unwrap()).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().contains(".cancel.json.partial-")).collect();
    assert!(partials.is_empty(), "cancelled transform leaked temporary outputs");
    assert!(matches!(inspect_file(&fixture("invalid-utf8.json"), FileFormat::Json, &CancellationToken::default(), |_| {}), Err(ToolError::InvalidUtf8)));
}

#[test]
fn transform_preserves_source_and_publishes_reopenable_copy() {
    let source = fixture("lexemes.json");
    let before = fs::read(&source).expect("source bytes");
    let output = scratch("saved.json");
    let _ = fs::remove_file(&output);
    transform_json_file(&source, &output, JsonLayout::Minify, &CancellationToken::default(), |_| {}).expect("minify");
    assert_eq!(fs::read(&source).unwrap(), before, "source must remain immutable");
    assert!(inspect_file(&output, FileFormat::Json, &CancellationToken::default(), |_| {}).is_ok(), "saved copy must reopen as JSON");
    fs::remove_file(output).unwrap();
}
