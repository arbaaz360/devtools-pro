use crate::{CancellationToken, Document, InputKind, Progress, RendererKind, ToolCapabilities, ToolError, ToolLimits, ToolManifest, ToolOperation};
use serde::{Deserialize, Serialize};

pub const DEFAULT_MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
pub const DEFAULT_MAX_LINES: usize = 100_000;
pub const DEFAULT_MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
pub const DEFAULT_MAX_HUNKS: usize = 10_000;
const CONTEXT_LINES: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncodingOption { Auto, Utf8, Utf16Le, Utf16Be, Latin1 }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NewlineNormalization { Preserve, Lf, CrLf, Ignore }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CompareOptions {
    pub left_encoding: EncodingOption,
    pub right_encoding: EncodingOption,
    pub newline: NewlineNormalization,
    pub context_lines: usize,
    pub max_input_bytes: Option<usize>,
    pub max_lines: Option<usize>,
    pub max_output_bytes: Option<usize>,
    pub max_hunks: Option<usize>,
}
impl Default for CompareOptions {
    fn default() -> Self { Self { left_encoding: EncodingOption::Auto, right_encoding: EncodingOption::Auto, newline: NewlineNormalization::Preserve, context_lines: CONTEXT_LINES, max_input_bytes: Some(DEFAULT_MAX_INPUT_BYTES), max_lines: Some(DEFAULT_MAX_LINES), max_output_bytes: Some(DEFAULT_MAX_OUTPUT_BYTES), max_hunks: Some(DEFAULT_MAX_HUNKS) } }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffLineKind { Context, Added, Removed }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine { pub kind: DiffLineKind, pub text: String, pub old_line: Option<usize>, pub new_line: Option<usize> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk { pub old_start: usize, pub old_lines: usize, pub new_start: usize, pub new_lines: usize, pub lines: Vec<DiffLine> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareSummary {
    pub identical: bool,
    pub newline_only: bool,
    pub left_bytes: u64,
    pub right_bytes: u64,
    pub left_lines: usize,
    pub right_lines: usize,
    pub added_lines: usize,
    pub removed_lines: usize,
    pub changed_hunks: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareProvenance {
    pub operation: String,
    pub left_encoding: EncodingOption,
    pub right_encoding: EncodingOption,
    pub newline: NewlineNormalization,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareResult {
    pub summary: CompareSummary,
    pub hunks: Vec<DiffHunk>,
    pub provenance: CompareProvenance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareStats { pub input_bytes: u64, pub output_bytes: u64, pub hunks: usize }

/// The immutable pair consumed by the compare operation.
#[derive(Debug, Clone)]
pub struct CompareInput { pub left: Document, pub right: Document }

impl CompareInput {
    pub fn new(left: Document, right: Document) -> Self { Self { left, right } }
}

pub fn compare_pair(input: &CompareInput, options: &CompareOptions, cancel: &CancellationToken, progress: impl Fn(Progress)) -> Result<(CompareResult, CompareStats), ToolError> {
    compare_documents(&input.left, &input.right, options, cancel, progress)
}

fn decode(input: &Document, encoding: EncodingOption, cancel: &CancellationToken) -> Result<String, ToolError> {
    if cancel.is_cancelled() { return Err(ToolError::Cancelled); }
    let bytes = input.bytes();
    let chosen = match encoding {
        EncodingOption::Auto => match input.encoding { crate::Encoding::Utf16Le => EncodingOption::Utf16Le, crate::Encoding::Utf16Be => EncodingOption::Utf16Be, crate::Encoding::Binary => return Err(ToolError::UnsupportedEncoding { message: "binary document cannot be compared as text".into() }), _ => EncodingOption::Utf8 },
        value => value,
    };
    match chosen {
        EncodingOption::Utf8 => {
            let offset = usize::from(bytes.starts_with(&[0xef, 0xbb, 0xbf]));
            std::str::from_utf8(&bytes[offset * 3..]).map(str::to_owned).map_err(|_| ToolError::InvalidUtf8)
        }
        EncodingOption::Latin1 => Ok(bytes.iter().map(|&b| char::from(b)).collect()),
        EncodingOption::Utf16Le | EncodingOption::Utf16Be => {
            let mut raw = bytes;
            if (chosen == EncodingOption::Utf16Le && raw.starts_with(&[0xff, 0xfe])) || (chosen == EncodingOption::Utf16Be && raw.starts_with(&[0xfe, 0xff])) { raw = &raw[2..]; }
            if raw.len() % 2 != 0 { return Err(ToolError::UnsupportedEncoding { message: "UTF-16 input has an odd byte length".into() }); }
            let units: Vec<u16> = raw.chunks_exact(2).map(|p| if chosen == EncodingOption::Utf16Le { u16::from_le_bytes([p[0], p[1]]) } else { u16::from_be_bytes([p[0], p[1]]) }).collect();
            String::from_utf16(&units).map_err(|_| ToolError::UnsupportedEncoding { message: "UTF-16 input contains an invalid surrogate".into() })
        }
        EncodingOption::Auto => unreachable!(),
    }
}

fn normalize_newlines(mut text: String, mode: NewlineNormalization, cancel: &CancellationToken) -> Result<String, ToolError> {
    if cancel.is_cancelled() { return Err(ToolError::Cancelled); }
    if matches!(mode, NewlineNormalization::Preserve) { return Ok(text); }
    text = text.replace("\r\n", "\n").replace('\r', "\n");
    if matches!(mode, NewlineNormalization::CrLf) { text = text.replace('\n', "\r\n"); }
    if cancel.is_cancelled() { return Err(ToolError::Cancelled); }
    Ok(text)
}

fn lines(text: &str) -> Vec<String> {
    if text.is_empty() { return Vec::new(); }
    text.split_inclusive('\n').map(str::to_owned).collect()
}

#[derive(Clone)]
enum Op { Equal(String), Add(String), Remove(String) }

fn diff_lines(left: &[String], right: &[String], cancel: &CancellationToken, progress: &impl Fn(Progress), total: u64) -> Result<Vec<Op>, ToolError> {
    let cells = left.len().checked_mul(right.len()).ok_or_else(|| ToolError::ResourceLimit { message: "line comparison matrix is too large".into() })?;
    if cells > 4_000_000 { return Err(ToolError::ResourceLimit { message: "line comparison matrix exceeds 4,000,000 cells".into() }); }
    let mut dp = vec![0u32; (left.len() + 1) * (right.len() + 1)];
    for i in (0..left.len()).rev() {
        if cancel.is_cancelled() { return Err(ToolError::Cancelled); }
        for j in (0..right.len()).rev() { dp[i * (right.len() + 1) + j] = if left[i] == right[j] { 1 + dp[(i + 1) * (right.len() + 1) + j + 1] } else { dp[(i + 1) * (right.len() + 1) + j].max(dp[i * (right.len() + 1) + j + 1]) }; }
        progress(Progress { bytes_processed: (left.len() - i) as u64, total_bytes: total.max(1), phase: "comparing".into() });
    }
    let mut out = Vec::new(); let (mut i, mut j) = (0, 0);
    while i < left.len() || j < right.len() {
        if cancel.is_cancelled() { return Err(ToolError::Cancelled); }
        if i < left.len() && j < right.len() && left[i] == right[j] { out.push(Op::Equal(left[i].clone())); i += 1; j += 1; }
        else if j < right.len() && (i == left.len() || dp[i * (right.len() + 1) + j + 1] >= dp[(i + 1) * (right.len() + 1) + j]) { out.push(Op::Add(right[j].clone())); j += 1; }
        else { out.push(Op::Remove(left[i].clone())); i += 1; }
    }
    Ok(out)
}

fn make_hunks(ops: &[Op], context: usize, max_hunks: usize, cancel: &CancellationToken) -> Result<(Vec<DiffHunk>, usize, usize), ToolError> {
    let mut changed = Vec::new(); let mut added = 0; let mut removed = 0;
    for (idx, op) in ops.iter().enumerate() { if !matches!(op, Op::Equal(_)) { let start = idx.saturating_sub(context); let end = (idx + context + 1).min(ops.len()); changed.push((start, end)); } }
    let mut merged: Vec<(usize, usize)> = Vec::new(); for (start, end) in changed { if let Some(last) = merged.last_mut() { if start <= last.1 { last.1 = last.1.max(end); continue; } } merged.push((start, end)); }
    let mut hunks = Vec::new();
    for (start, end) in merged {
        if cancel.is_cancelled() { return Err(ToolError::Cancelled); }
        if hunks.len() >= max_hunks { return Err(ToolError::ResourceLimit { message: format!("diff exceeds hunk limit of {max_hunks} (output remains bounded)" ) }); }
        let mut before_old = 0; let mut before_new = 0; for op in &ops[..start] { match op { Op::Equal(_) => { before_old += 1; before_new += 1 }, Op::Add(_) => before_new += 1, Op::Remove(_) => before_old += 1 } }
        let mut hlines = Vec::new(); let (mut ho, mut hn) = (before_old + 1, before_new + 1);
        for op in &ops[start..end] { match op { Op::Equal(text) => { hlines.push(DiffLine { kind: DiffLineKind::Context, text: text.clone(), old_line: Some(ho), new_line: Some(hn) }); ho += 1; hn += 1; }, Op::Add(text) => { added += 1; hlines.push(DiffLine { kind: DiffLineKind::Added, text: text.clone(), old_line: None, new_line: Some(hn) }); hn += 1; }, Op::Remove(text) => { removed += 1; hlines.push(DiffLine { kind: DiffLineKind::Removed, text: text.clone(), old_line: Some(ho), new_line: None }); ho += 1; } } }
        hunks.push(DiffHunk { old_start: before_old + 1, old_lines: ho - before_old - 1, new_start: before_new + 1, new_lines: hn - before_new - 1, lines: hlines });
    }
    Ok((hunks, added, removed))
}

pub fn compare_documents(left: &Document, right: &Document, options: &CompareOptions, cancel: &CancellationToken, progress: impl Fn(Progress)) -> Result<(CompareResult, CompareStats), ToolError> {
    let max_input = options.max_input_bytes.unwrap_or(DEFAULT_MAX_INPUT_BYTES).min(DEFAULT_MAX_INPUT_BYTES);
    if left.len() > max_input || right.len() > max_input { return Err(ToolError::ResourceLimit { message: format!("each input must be at most {max_input} bytes") }); }
    if cancel.is_cancelled() { return Err(ToolError::Cancelled); }
    let raw_left = decode(left, options.left_encoding, cancel)?; let raw_right = decode(right, options.right_encoding, cancel)?;
    let canonical_left = normalize_newlines(raw_left.clone(), NewlineNormalization::Lf, cancel)?; let canonical_right = normalize_newlines(raw_right.clone(), NewlineNormalization::Lf, cancel)?;
    let left_text = normalize_newlines(raw_left, options.newline, cancel)?; let right_text = normalize_newlines(raw_right, options.newline, cancel)?;
    let left_lines = lines(&left_text); let right_lines = lines(&right_text);
    let max_lines = options.max_lines.unwrap_or(DEFAULT_MAX_LINES).min(DEFAULT_MAX_LINES);
    if left_lines.len() > max_lines || right_lines.len() > max_lines { return Err(ToolError::ResourceLimit { message: format!("each input must contain at most {max_lines} lines") }); }
    let ops = diff_lines(&left_lines, &right_lines, cancel, &progress, (left.len() + right.len()) as u64)?;
    let max_hunks = options.max_hunks.unwrap_or(DEFAULT_MAX_HUNKS).min(DEFAULT_MAX_HUNKS);
    let (hunks, added, removed) = make_hunks(&ops, options.context_lines.min(64), max_hunks, cancel)?;
    let summary = CompareSummary { identical: left_text == right_text, newline_only: left_text != right_text && canonical_left == canonical_right, left_bytes: left.len() as u64, right_bytes: right.len() as u64, left_lines: left_lines.len(), right_lines: right_lines.len(), added_lines: added, removed_lines: removed, changed_hunks: hunks.len() };
    let result = CompareResult { summary, hunks, provenance: CompareProvenance { operation: "text.compare".into(), left_encoding: options.left_encoding, right_encoding: options.right_encoding, newline: options.newline } };
    let output_bytes = serde_json::to_vec(&result).map_err(|e| ToolError::Execution { message: e.to_string() })?.len();
    let max_output = options.max_output_bytes.unwrap_or(DEFAULT_MAX_OUTPUT_BYTES).min(DEFAULT_MAX_OUTPUT_BYTES);
    if output_bytes > max_output { return Err(ToolError::ResourceLimit { message: format!("diff output exceeds {max_output} bytes (hunk limit {max_hunks}; preview is bounded)") }); }
    progress(Progress { bytes_processed: (left.len() + right.len()) as u64, total_bytes: (left.len() + right.len()) as u64, phase: "complete".into() });
    let hunk_count = result.summary.changed_hunks;
    Ok((result, CompareStats { input_bytes: (left.len() + right.len()) as u64, output_bytes: output_bytes as u64, hunks: hunk_count }))
}

pub fn compare_manifest() -> ToolManifest {
    ToolManifest { id: "text.compare".into(), label: "Diff & Compare".into(), contract_version: 1, input_kinds: vec![InputKind::Text], limits: ToolLimits { max_input_bytes: Some(DEFAULT_MAX_INPUT_BYTES as u64), max_output_bytes: Some(DEFAULT_MAX_OUTPUT_BYTES as u64) }, capabilities: ToolCapabilities { deterministic: true, supports_preview: true, supports_streaming: true, cancellation: true, progress: true, needs_filesystem: false, needs_network: false, needs_secrets: false }, operations: vec![ToolOperation { id: "compare".into(), label: "Compare".into(), default_options: serde_json::json!({"newline":"preserve"}) }], renderer: RendererKind::Diff }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn run(a: &str, b: &str) -> CompareResult { compare_documents(&Document::from_text(a), &Document::from_text(b), &Default::default(), &CancellationToken::default(), |_| {}).unwrap().0 }
    #[test] fn identical_has_no_hunks() { let r = run("one\ntwo\n", "one\ntwo\n"); assert!(r.summary.identical); assert!(r.hunks.is_empty()); }
    #[test] fn insertion_and_deletion_are_structured() { let i = run("a\n", "a\nb\n"); assert_eq!(i.summary.added_lines, 1); assert!(matches!(i.hunks[0].lines.last().unwrap().kind, DiffLineKind::Added)); let d = run("a\nb\n", "a\n"); assert_eq!(d.summary.removed_lines, 1); }
    #[test] fn replacement_has_both_sides() { let r = run("old\n", "new\n"); assert_eq!(r.summary.added_lines, 1); assert_eq!(r.summary.removed_lines, 1); }
    #[test] fn newline_only_can_be_normalized() { let r = run("a\r\nb\r\n", "a\nb\n"); assert!(r.summary.newline_only); let mut o = CompareOptions::default(); o.newline = NewlineNormalization::Lf; let n = compare_documents(&Document::from_text("a\r\n"), &Document::from_text("a\n"), &o, &CancellationToken::default(), |_| {}).unwrap().0; assert!(n.summary.identical); }
    #[test] fn explicit_utf16_and_latin1_decoding_are_supported() { let utf16 = Document::from_bytes(vec![0xff, 0xfe, b'a', 0, b'\n', 0]); let mut o = CompareOptions::default(); o.left_encoding = EncodingOption::Utf16Le; let n = compare_documents(&utf16, &Document::from_text("a\n"), &o, &CancellationToken::default(), |_| {}).unwrap().0; assert!(n.summary.identical); let latin = Document::from_bytes(vec![0xe9]); let mut o = CompareOptions::default(); o.left_encoding = EncodingOption::Latin1; let n = compare_documents(&latin, &Document::from_text("é"), &o, &CancellationToken::default(), |_| {}).unwrap().0; assert!(n.summary.identical); }
    #[test] fn limits_and_cancellation_are_reported() { let mut o = CompareOptions::default(); o.max_input_bytes = Some(2); assert!(matches!(compare_documents(&Document::from_text("abc"), &Document::from_text("x"), &o, &CancellationToken::default(), |_| {}), Err(ToolError::ResourceLimit { .. }))); let t = CancellationToken::default(); t.cancel(); assert!(matches!(compare_documents(&Document::from_text("a"), &Document::from_text("b"), &Default::default(), &t, |_| {}), Err(ToolError::Cancelled))); }
    #[test] fn hunk_limit_is_enforced_with_structured_diagnostic() { let mut o = CompareOptions::default(); o.max_hunks = Some(0); let error = compare_documents(&Document::from_text("a\nc\ne\n"), &Document::from_text("b\nd\nf\n"), &o, &CancellationToken::default(), |_| {}).unwrap_err(); match error { ToolError::ResourceLimit { message } => assert!(message.contains("hunk limit")), other => panic!("unexpected error: {other:?}"), } }
    #[test] fn cancellation_during_matrix_build_is_observed() { let token = CancellationToken::default(); let callback_token = token.clone(); let result = compare_documents(&Document::from_text("a\nb\nc\n"), &Document::from_text("x\ny\nz\n"), &Default::default(), &token, move |_| callback_token.cancel()); assert!(matches!(result, Err(ToolError::Cancelled))); }
}
