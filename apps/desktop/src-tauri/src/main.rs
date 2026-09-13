#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use devtools_core::{
    encode_image_base64, decode_base64_image, hash_document, transform_text,
    parse_curl, generate_fetch, generate_python,
    CancellationToken, CompareOptions, Document, DocumentKind, FileFormat, HashAlgorithm,
    ImageBase64Options, Base64ImageOptions, TextUtilityKind, TextUtilityOptions,
    Inspection, InputKind, JsonLayout, Progress, RendererKind, ToolError, ToolManifest,
    compare_documents, inspect_file, transform_json_file,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}},
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};

const PREVIEW_BYTES: usize = 64 * 1024;
const MAX_JOBS: usize = 2;
const MAX_DOCUMENTS: usize = 64;

#[derive(Clone)]
struct RegisteredDocument {
    path: PathBuf,
    size: u64,
    modified: Option<SystemTime>,
    temporary: bool,
    display_name: Option<String>,
    origin_path: Option<PathBuf>,
}

#[derive(Default)]
struct HostState {
    sequence: AtomicU64,
    documents: Mutex<HashMap<String, RegisteredDocument>>,
    jobs: Mutex<HashMap<String, CancellationToken>>,
    finished_jobs: Mutex<HashMap<String, JobFinished>>,
}

impl HostState {
    fn next_id(&self, prefix: &str) -> String {
        format!("{prefix}-{}", self.sequence.fetch_add(1, Ordering::Relaxed))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedDocument {
    id: String,
    name: String,
    path: String,
    size: u64,
    preview: String,
    truncated: bool,
    format: String,
    encoding: String,
    offset: u64,
    bytes_read: usize,
}

/// Decode only a bounded file window. Offsets refer to original bytes.
fn preview_document(id: String, doc: &RegisteredDocument, offset: u64) -> Result<OpenedDocument, String> {
    let mut file = File::open(&doc.path).map_err(|e| e.to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if meta.len() != doc.size || meta.modified().ok() != doc.modified {
        return Err("This file changed on disk. Reopen it before continuing.".into());
    }
    if offset > doc.size {
        return Err("Preview offset exceeds the file size.".into());
    }
    let mut signature = [0u8; 3];
    let signature_len = file.read(&mut signature).map_err(|e| e.to_string())?;
    let encoding = if signature[..signature_len].starts_with(&[0xff, 0xfe]) {
        "UTF-16 LE"
    } else if signature[..signature_len].starts_with(&[0xfe, 0xff]) {
        "UTF-16 BE"
    } else if signature == [0xef, 0xbb, 0xbf] {
        "UTF-8 BOM"
    } else { "UTF-8" };
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buffer = Vec::with_capacity(PREVIEW_BYTES + 4);
    file.take((PREVIEW_BYTES + 4) as u64).read_to_end(&mut buffer).map_err(|e| e.to_string())?;
    let mut consumed = buffer.len().min(PREVIEW_BYTES);
    let (preview, encoding) = if encoding.starts_with("UTF-16") {
        consumed -= consumed % 2;
        let start = if offset == 0 { 2.min(consumed) } else { 0 };
        let units: Vec<u16> = buffer[start..consumed].chunks_exact(2).map(|p| {
            if encoding == "UTF-16 LE" { u16::from_le_bytes([p[0], p[1]]) }
            else { u16::from_be_bytes([p[0], p[1]]) }
        }).collect();
        let drop_surrogate = units.last().is_some_and(|u| (0xd800..=0xdbff).contains(u)) && consumed < buffer.len();
        let preview = String::from_utf16_lossy(&units[..units.len() - usize::from(drop_surrogate)]);
        if drop_surrogate { consumed -= 2; }
        (preview, encoding.to_string())
    } else {
        // Extend by at most three bytes to avoid splitting a UTF-8 code point.
        while consumed < buffer.len() && buffer[consumed] & 0xc0 == 0x80 { consumed += 1; }
        let start = if offset == 0 && encoding == "UTF-8 BOM" { 3.min(consumed) } else { 0 };
        let bytes = &buffer[start..consumed];
        match std::str::from_utf8(bytes) {
            Ok(text) => (text.to_owned(), encoding.to_string()),
            Err(_) => (String::from_utf8_lossy(bytes).into_owned(), "Unknown / lossy preview".into()),
        }
    };
    let extension = doc.path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
    let trimmed = preview.trim_start();
    let format = if extension == "json" || (offset == 0 && (trimmed.starts_with('{') || trimmed.starts_with('['))) {
        "json"
    } else if extension == "csv" { "csv" } else { "text" };
    Ok(OpenedDocument {
        id,
        name: doc.display_name.clone().unwrap_or_else(|| doc.path.file_name().unwrap_or_default().to_string_lossy().into()),
        path: doc.path.to_string_lossy().into(),
        size: doc.size,
        preview,
        truncated: offset > 0 || offset + (consumed as u64) < doc.size,
        format: format.into(),
        encoding,
        offset,
        bytes_read: consumed,
    })
}

#[tauri::command]
async fn open_document(path: String, state: tauri::State<'_, Arc<HostState>>) -> Result<OpenedDocument, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
        let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
        if !meta.is_file() { return Err("Choose a regular file.".into()); }
        let document = RegisteredDocument { path, size: meta.len(), modified: meta.modified().ok(), temporary: false, display_name: None, origin_path: None };
        let id = state.next_id("doc");
        let opened = preview_document(id.clone(), &document, 0)?;
        let mut documents = state.documents.lock().map_err(|e| e.to_string())?;
        if documents.len() >= MAX_DOCUMENTS { return Err("Close a document before opening another (64-tab limit).".into()); }
        documents.insert(id, document);
        Ok(opened)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_preview(document_id: String, offset: u64, state: tauri::State<'_, Arc<HostState>>) -> Result<OpenedDocument, String> {
    let document = state.documents.lock().map_err(|e| e.to_string())?.get(&document_id)
        .cloned().ok_or("Document is no longer open.")?;
    tauri::async_runtime::spawn_blocking(move || preview_document(document_id, &document, offset))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn close_document(document_id: String, state: tauri::State<'_, Arc<HostState>>) -> Result<(), String> {
    if let Some(document) = state.documents.lock().map_err(|e| e.to_string())?.remove(&document_id) {
        if document.temporary { let _ = fs::remove_file(document.path); }
    }
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JobProgress {
    job_id: String,
    bytes_processed: u64,
    total_bytes: u64,
    phase: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JobFinished {
    job_id: String,
    ok: bool,
    cancelled: bool,
    summary: String,
    elapsed_ms: u64,
    input_bytes: u64,
    output_bytes: Option<u64>,
    output_path: Option<String>,
    result_document_id: Option<String>,
    result_path: Option<String>,
    error: Option<String>,
    /// Machine-readable error payload retained alongside the display message.
    error_details: Option<Value>,
    /// Renderer and output metadata let the bridge select a view without
    /// reimplementing tool-specific detection in the webview.
    renderer: Option<RendererKind>,
    result_kind: Option<InputKind>,
    result_mime: Option<String>,
    diagnostics: Vec<devtools_core::Diagnostic>,
    source_document_id: Option<String>,
    operation_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartedJob { job_id: String }

fn parse_format(format: &str) -> Result<FileFormat, String> {
    match format {
        "json" => Ok(FileFormat::Json),
        "csv" => Ok(FileFormat::Csv),
        "text" => Ok(FileFormat::Text),
        _ => Err("Unsupported input format.".into()),
    }
}

fn manifest_for_tool(tool_id: &str) -> Result<devtools_core::ToolManifest, devtools_core::ToolError> {
    devtools_core::builtin_manifests().into_iter().find(|manifest| manifest.id == tool_id)
        .ok_or_else(|| devtools_core::ToolError::UnknownTool { tool_id: tool_id.into() })
}

fn detected_document_format(document: &RegisteredDocument) -> Result<FileFormat, String> {
    let opened = preview_document(String::new(), document, 0)?;
    parse_format(&opened.format)
}

/// Generic tool entry point. The host resolves a capability-scoped document
/// handle, validates the manifest's input and operation declarations, then
/// enters the same bounded job scheduler used by the compatibility command.
#[tauri::command]
fn run_tool(
    document_id: String,
    tool_id: String,
    operation_id: String,
    options: Value,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<HostState>>,
) -> Result<StartedJob, devtools_core::ToolError> {
    if !options.is_object() {
        return Err(devtools_core::ToolError::InvalidOptions { message: "options must be a JSON object".into() });
    }
    let manifest = manifest_for_tool(&tool_id)?;
    let document = state.documents.lock().map_err(|error| devtools_core::ToolError::Execution { message: error.to_string() })?
        .get(&document_id).cloned()
        .ok_or_else(|| devtools_core::ToolError::Execution { message: "Document is no longer open.".into() })?;
    let format = detected_document_format(&document)
        .map_err(|message| devtools_core::ToolError::Execution { message })?;
    let (input_kind, format_name) = match format {
        FileFormat::Json => (devtools_core::InputKind::Json, "json"),
        FileFormat::Csv => (devtools_core::InputKind::Csv, "csv"),
        FileFormat::Text => (devtools_core::InputKind::Text, "text"),
    };
    // Hashing and image encoding consume the immutable raw bytes of an open
    // file, so they are valid even when the preview detector labels the file
    // as text. All other tools use the detected document kind for validation.
    let validation_kind = if matches!(tool_id.as_str(), "encoding.hash" | "encoding.image-base64") && manifest.input_kinds.contains(&InputKind::Bytes) {
        InputKind::Bytes
    } else { input_kind };
    manifest.supports(validation_kind, &operation_id)?;
    if matches!(tool_id.as_str(), "structured.json" | "structured.csv" | "text.inspect") {
        return start_operation_impl(document_id, operation_id, Some(format_name.into()), app, state)
            .map_err(|message| devtools_core::ToolError::Execution { message });
    }
    if tool_id == "text.compare" {
        return Err(ToolError::InvalidOptions { message: "text.compare requires two document handles; use run_compare".into() });
    }
    start_generic_operation(document_id, tool_id, operation_id, options, manifest, app, state)
}

/// Execute one of the registered in-process tools while keeping cancellation,
/// progress, limits, temporary result files, and provenance in the host.
fn start_generic_operation(
    document_id: String,
    tool_id: String,
    operation_id: String,
    options: Value,
    manifest: ToolManifest,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<HostState>>,
) -> Result<StartedJob, ToolError> {
    let document = state.documents.lock().map_err(|error| ToolError::Execution { message: error.to_string() })?
        .get(&document_id).cloned()
        .ok_or_else(|| ToolError::Execution { message: "Document is no longer open.".into() })?;
    if let Some(max) = manifest.limits.max_input_bytes {
        if document.size > max { return Err(ToolError::ResourceLimit { message: format!("input exceeds the {max}-byte tool limit") }); }
    }
    let token = CancellationToken::default();
    let job_id = state.next_id("job");
    let result_document_id = state.next_id("result");
    let result_path = std::env::temp_dir().join(format!("devtools-pro-{}-{}.result", std::process::id(), result_document_id));
    {
        let mut jobs = state.jobs.lock().map_err(|error| ToolError::Execution { message: error.to_string() })?;
        if jobs.len() >= MAX_JOBS { return Err(ToolError::ResourceLimit { message: "Two operations are already running. Cancel or wait for one to finish.".into() }); }
        jobs.insert(job_id.clone(), token.clone());
    }
    let state = state.inner().clone();
    let worker_id = job_id.clone();
    let worker_result_id = result_document_id.clone();
    let worker_result_path = result_path.clone();
    let worker_tool_id = tool_id.clone();
    let worker_operation = operation_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let progress = |p: Progress| {
            let _ = app.emit_to("main", "job-progress", JobProgress { job_id: worker_id.clone(), bytes_processed: p.bytes_processed, total_bytes: p.total_bytes, phase: p.phase });
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<devtools_core::ToolResult, ToolError> {
            let meta = fs::metadata(&document.path).map_err(ToolError::from)?;
            if meta.len() != document.size || meta.modified().ok() != document.modified {
                return Err(ToolError::Execution { message: "The input file changed. Reopen it before running another operation.".into() });
            }
            let bytes = fs::read(&document.path).map_err(ToolError::from)?;
            let kind = if manifest.input_kinds.contains(&InputKind::Bytes) { DocumentKind::Binary } else { DocumentKind::Text };
            let input = Document::from_bytes(bytes).with_kind(kind);
            execute_registered_tool(&worker_tool_id, &worker_operation, &input, &options, &token, &progress)
        })).unwrap_or_else(|_| Err(ToolError::Execution { message: "The worker failed unexpectedly; the workbench is still available.".into() }));
        if let Ok(mut jobs) = state.jobs.lock() { jobs.remove(&worker_id); }
        let mut finished = match result {
            Ok(tool_result) => {
                let output = tool_result.output;
                let output_bytes = output.bytes().to_vec();
                let output_len = output_bytes.len() as u64;
                let exceeds = manifest.limits.max_output_bytes.is_some_and(|max| output_len > max);
                if exceeds {
                    JobFinished { job_id: worker_id.clone(), ok: false, cancelled: false, summary: "Operation failed.".into(), elapsed_ms: started.elapsed().as_millis() as u64, input_bytes: document.size, output_bytes: None, output_path: None, result_document_id: None, result_path: None, error: Some("Tool output exceeds its declared limit.".into()), error_details: Some(serde_json::json!({"code":"resource_limit","message":"tool output exceeds its declared limit"})), renderer: Some(manifest.renderer), result_kind: None, result_mime: None, diagnostics: tool_result.diagnostics, source_document_id: Some(document_id.clone()), operation_id: Some(worker_operation.clone()) }
                } else if let Err(error) = fs::write(&worker_result_path, &output_bytes) {
                    JobFinished { job_id: worker_id.clone(), ok: false, cancelled: false, summary: "Operation failed.".into(), elapsed_ms: started.elapsed().as_millis() as u64, input_bytes: document.size, output_bytes: None, output_path: None, result_document_id: None, result_path: None, error: Some(error.to_string()), error_details: Some(serde_json::json!({"code":"io","message":error.to_string()})), renderer: Some(manifest.renderer), result_kind: None, result_mime: None, diagnostics: tool_result.diagnostics, source_document_id: Some(document_id.clone()), operation_id: Some(worker_operation.clone()) }
                } else {
                    JobFinished { job_id: worker_id.clone(), ok: true, cancelled: false, summary: format!("{} completed.", manifest.label), elapsed_ms: started.elapsed().as_millis() as u64, input_bytes: document.size, output_bytes: Some(output_len), output_path: None, result_document_id: Some(worker_result_id.clone()), result_path: Some(worker_result_path.to_string_lossy().into_owned()), error: None, error_details: None, renderer: Some(manifest.renderer), result_kind: Some(InputKind::from(output.kind)), result_mime: output.mime.clone(), diagnostics: tool_result.diagnostics, source_document_id: Some(document_id.clone()), operation_id: Some(worker_operation.clone()) }
                }
            }
            Err(error) => { let message = error.to_string(); let details = serde_json::to_value(&error).ok(); JobFinished { job_id: worker_id.clone(), ok: false, cancelled: token.is_cancelled(), summary: if token.is_cancelled() { "Operation cancelled.".into() } else { "Operation failed.".into() }, elapsed_ms: started.elapsed().as_millis() as u64, input_bytes: document.size, output_bytes: None, output_path: None, result_document_id: None, result_path: None, error: Some(message), error_details: details, renderer: Some(manifest.renderer), result_kind: None, result_mime: None, diagnostics: Vec::new(), source_document_id: Some(document_id.clone()), operation_id: Some(worker_operation.clone()) } },
        };
        if finished.ok {
            if let Ok(meta) = fs::metadata(&worker_result_path) {
                let result_doc = RegisteredDocument { path: worker_result_path.clone(), size: meta.len(), modified: meta.modified().ok(), temporary: true, display_name: Some(format!("{}.{}", document.path.file_stem().unwrap_or_default().to_string_lossy(), worker_operation)), origin_path: Some(document.path.clone()) };
                if let Ok(mut documents) = state.documents.lock() {
                    if documents.len() < MAX_DOCUMENTS { documents.insert(worker_result_id.clone(), result_doc); } else { let _ = fs::remove_file(&worker_result_path); finished.ok = false; finished.error = Some("Close an unused document before running another tool.".into()); finished.error_details = Some(serde_json::json!({"code":"resource_limit","message":"document handle limit reached"})); finished.result_document_id = None; finished.result_path = None; }
                }
            } else { finished.ok = false; finished.error = Some("The tool output was not created.".into()); finished.error_details = Some(serde_json::json!({"code":"execution","message":"The tool output was not created."})); finished.result_document_id = None; finished.result_path = None; }
        } else { let _ = fs::remove_file(&worker_result_path); }
        if let Ok(mut completed) = state.finished_jobs.lock() { completed.insert(worker_id.clone(), finished.clone()); while completed.len() > 32 { if let Some(oldest) = completed.keys().next().cloned() { completed.remove(&oldest); } else { break; } } }
        let _ = app.emit_to("main", "job-finished", finished);
    });
    Ok(StartedJob { job_id })
}

fn execute_registered_tool(
    tool_id: &str,
    operation_id: &str,
    input: &Document,
    options: &Value,
    token: &CancellationToken,
    progress: &impl Fn(Progress),
) -> Result<devtools_core::ToolResult, ToolError> {
    if token.is_cancelled() { return Err(ToolError::Cancelled); }
    match tool_id {
        "text.url" | "text.html" | "text.unicode" => {
            let kind = match tool_id { "text.url" => TextUtilityKind::Url, "text.html" => TextUtilityKind::Html, _ => TextUtilityKind::Unicode };
            let opts: TextUtilityOptions = serde_json::from_value(options.clone()).map_err(|error| ToolError::InvalidOptions { message: error.to_string() })?;
            progress(Progress { bytes_processed: 0, total_bytes: input.len() as u64, phase: "transforming".into() });
            let result = transform_text(input, kind, operation_id, &opts)?;
            progress(Progress { bytes_processed: input.len() as u64, total_bytes: input.len() as u64, phase: "complete".into() });
            Ok(result)
        }
        "encoding.hash" => {
            let algorithm = match operation_id { "sha256" => HashAlgorithm::Sha256, "sha512" => HashAlgorithm::Sha512, _ => return Err(ToolError::UnsupportedOperation { tool_id: tool_id.into(), operation_id: operation_id.into() }) };
            let (hash, _) = hash_document(input, algorithm, token, progress)?;
            let text = serde_json::to_string_pretty(&hash).map_err(|error| ToolError::Execution { message: error.to_string() })?;
            Ok(devtools_core::ToolResult { output: Document::from_text(text).with_kind(DocumentKind::Text).with_mime("application/json"), diagnostics: Vec::new() })
        }
        "encoding.image-base64" => {
            if operation_id != "encode" { return Err(ToolError::UnsupportedOperation { tool_id: tool_id.into(), operation_id: operation_id.into() }); }
            let opts: ImageBase64Options = serde_json::from_value(options.clone()).map_err(|error| ToolError::InvalidOptions { message: error.to_string() })?;
            encode_image_base64(input, &opts, token, progress).map(|(result, _)| result)
        }
        "encoding.base64-image" => {
            if operation_id != "decode" { return Err(ToolError::UnsupportedOperation { tool_id: tool_id.into(), operation_id: operation_id.into() }); }
            let opts: Base64ImageOptions = serde_json::from_value(options.clone()).map_err(|error| ToolError::InvalidOptions { message: error.to_string() })?;
            decode_base64_image(input, &opts, token, progress).map(|(result, _)| result)
        }
        "web.curl-code" => {
            let text = input.as_text().map_err(|_| ToolError::InvalidUtf8)?;
            let (request, diagnostics) = parse_curl(text).map_err(|items| ToolError::Execution { message: items.into_iter().map(|item| item.message).collect::<Vec<_>>().join("; ") })?;
            let output = match operation_id { "fetch" => generate_fetch(&request), "python" => generate_python(&request), _ => return Err(ToolError::UnsupportedOperation { tool_id: tool_id.into(), operation_id: operation_id.into() }) };
            Ok(devtools_core::ToolResult { output: Document::from_text(output).with_kind(DocumentKind::Text).with_mime("text/plain"), diagnostics })
        }
        _ => Err(ToolError::UnknownTool { tool_id: tool_id.into() }),
    }
}

/// Compare two open text documents through the same bounded scheduler used by
/// the single-document compatibility commands. Inputs are read-only and the
/// JSON diff is published as an app-owned temporary result document.
#[tauri::command]
fn run_compare(
    left_document_id: String,
    right_document_id: String,
    options: Value,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<HostState>>,
) -> Result<StartedJob, devtools_core::ToolError> {
    if !options.is_object() {
        return Err(devtools_core::ToolError::InvalidOptions { message: "options must be a JSON object".into() });
    }
    let options: CompareOptions = serde_json::from_value(options)
        .map_err(|error| devtools_core::ToolError::InvalidOptions { message: error.to_string() })?;
    let (left, right) = {
        let documents = state.documents.lock().map_err(|error| devtools_core::ToolError::Execution { message: error.to_string() })?;
        let left = documents.get(&left_document_id).cloned()
            .ok_or_else(|| devtools_core::ToolError::Execution { message: "Left document is no longer open.".into() })?;
        let right = documents.get(&right_document_id).cloned()
            .ok_or_else(|| devtools_core::ToolError::Execution { message: "Right document is no longer open.".into() })?;
        (left, right)
    };
    let token = CancellationToken::default();
    let job_id = state.next_id("job");
    let result_document_id = state.next_id("result");
    let result_path = std::env::temp_dir().join(format!("devtools-pro-{}-{}.diff.json", std::process::id(), result_document_id));
    {
        let mut jobs = state.jobs.lock().map_err(|error| devtools_core::ToolError::Execution { message: error.to_string() })?;
        if jobs.len() >= MAX_JOBS { return Err(devtools_core::ToolError::ResourceLimit { message: "Two operations are already running. Cancel or wait for one to finish.".into() }); }
        jobs.insert(job_id.clone(), token.clone());
    }
    let state = state.inner().clone();
    let worker_id = job_id.clone();
    let worker_result_id = result_document_id.clone();
    let worker_result_path = result_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let progress = |p: Progress| {
            let _ = app.emit_to("main", "job-progress", JobProgress { job_id: worker_id.clone(), bytes_processed: p.bytes_processed, total_bytes: p.total_bytes, phase: p.phase });
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(devtools_core::CompareResult, devtools_core::CompareStats), String> {
            let left_meta = fs::metadata(&left.path).map_err(|error| error.to_string())?;
            let right_meta = fs::metadata(&right.path).map_err(|error| error.to_string())?;
            if left_meta.len() != left.size || left_meta.modified().ok() != left.modified || right_meta.len() != right.size || right_meta.modified().ok() != right.modified {
                return Err("An input file changed. Reopen both documents before comparing.".into());
            }
            let left_doc = Document::from_bytes(fs::read(&left.path).map_err(|error| error.to_string())?);
            let right_doc = Document::from_bytes(fs::read(&right.path).map_err(|error| error.to_string())?);
            compare_documents(&left_doc, &right_doc, &options, &token, progress).map_err(|error| error.to_string())
        })).unwrap_or_else(|_| Err("The compare worker failed unexpectedly; the workbench is still available.".into()));
        if let Ok(mut jobs) = state.jobs.lock() { jobs.remove(&worker_id); }
        let mut finished = match result {
            Ok((comparison, stats)) => {
                let bytes = match serde_json::to_vec_pretty(&comparison) {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        let failed = JobFinished { job_id: worker_id.clone(), ok: false, cancelled: false, summary: "Operation failed.".into(), elapsed_ms: started.elapsed().as_millis() as u64, input_bytes: stats.input_bytes, output_bytes: None, output_path: None, result_document_id: None, result_path: None, error: Some(error.to_string()), error_details: Some(serde_json::json!({"code":"execution","message":error.to_string()})), renderer: Some(RendererKind::Diff), result_kind: None, result_mime: None, diagnostics: Vec::new(), source_document_id: Some(left_document_id.clone()), operation_id: Some("compare".into()) };
                        if let Ok(mut completed) = state.finished_jobs.lock() { completed.insert(worker_id.clone(), failed.clone()); }
                        let _ = app.emit_to("main", "job-finished", failed);
                        return;
                    }
                };
                if let Err(error) = fs::write(&worker_result_path, &bytes) {
                    JobFinished { job_id: worker_id.clone(), ok: false, cancelled: false, summary: "Operation failed.".into(), elapsed_ms: started.elapsed().as_millis() as u64, input_bytes: stats.input_bytes, output_bytes: None, output_path: None, result_document_id: None, result_path: None, error: Some(error.to_string()), error_details: Some(serde_json::json!({"code":"execution","message":error.to_string()})), renderer: Some(RendererKind::Diff), result_kind: None, result_mime: None, diagnostics: Vec::new(), source_document_id: Some(left_document_id.clone()), operation_id: Some("compare".into()) }
                } else {
                    JobFinished { job_id: worker_id.clone(), ok: true, cancelled: false, summary: serde_json::to_string(&comparison.summary).unwrap_or_else(|_| "Comparison completed.".into()), elapsed_ms: started.elapsed().as_millis() as u64, input_bytes: stats.input_bytes, output_bytes: Some(bytes.len() as u64), output_path: None, result_document_id: Some(worker_result_id.clone()), result_path: Some(worker_result_path.to_string_lossy().into_owned()), error: None, error_details: None, renderer: Some(RendererKind::Diff), result_kind: Some(InputKind::Text), result_mime: Some("application/json".into()), diagnostics: Vec::new(), source_document_id: Some(left_document_id.clone()), operation_id: Some("compare".into()) }
                }
            }
            Err(error) => { let details = serde_json::json!({"code":"execution","message":error}); JobFinished { job_id: worker_id.clone(), ok: false, cancelled: token.is_cancelled(), summary: if token.is_cancelled() { "Operation cancelled.".into() } else { "Operation failed.".into() }, elapsed_ms: started.elapsed().as_millis() as u64, input_bytes: left.size.saturating_add(right.size), output_bytes: None, output_path: None, result_document_id: None, result_path: None, error: Some(details["message"].as_str().unwrap_or("Operation failed.").into()), error_details: Some(details), renderer: Some(RendererKind::Diff), result_kind: None, result_mime: None, diagnostics: Vec::new(), source_document_id: Some(left_document_id.clone()), operation_id: Some("compare".into()) } },
        };
        if finished.ok {
            if let Ok(meta) = fs::metadata(&worker_result_path) {
                let result_doc = RegisteredDocument { path: worker_result_path.clone(), size: meta.len(), modified: meta.modified().ok(), temporary: true, display_name: Some(format!("{} vs {}.diff.json", left.path.file_stem().unwrap_or_default().to_string_lossy(), right.path.file_stem().unwrap_or_default().to_string_lossy())), origin_path: Some(left.path.clone()) };
                if let Ok(mut documents) = state.documents.lock() {
                    if documents.len() < MAX_DOCUMENTS { documents.insert(worker_result_id.clone(), result_doc); } else { let _ = fs::remove_file(&worker_result_path); finished.ok = false; finished.error = Some("Close an unused document before comparing another pair.".into()); finished.result_document_id = None; finished.result_path = None; }
                }
            } else { finished.ok = false; finished.error = Some("The comparison output was not created.".into()); finished.result_document_id = None; finished.result_path = None; }
        } else { let _ = fs::remove_file(&worker_result_path); }
        if let Ok(mut completed) = state.finished_jobs.lock() { completed.insert(worker_id.clone(), finished.clone()); while completed.len() > 32 { if let Some(oldest) = completed.keys().next().cloned() { completed.remove(&oldest); } else { break; } } }
        let _ = app.emit_to("main", "job-finished", finished);
    });
    Ok(StartedJob { job_id })
}

#[tauri::command]
fn start_operation(
    document_id: String, operation: String, format: Option<String>,
    app: tauri::AppHandle, state: tauri::State<'_, Arc<HostState>>,
) -> Result<StartedJob, String> {
    start_operation_impl(document_id, operation, format, app, state)
}

/// Compatibility adapter retained for existing JSON callers. New callers use
/// `run_tool`, which validates a manifest before entering this scheduler.
fn start_operation_impl(
    document_id: String, operation: String, format: Option<String>,
    app: tauri::AppHandle, state: tauri::State<'_, Arc<HostState>>,
) -> Result<StartedJob, String> {
    let document = state.documents.lock().map_err(|e| e.to_string())?
        .get(&document_id).cloned().ok_or("Document is no longer open.")?;
    let default_format = document.path.extension().and_then(|s| s.to_str()).unwrap_or("text");
    let format = parse_format(format.as_deref().unwrap_or(default_format))?;
    if !matches!(operation.as_str(), "inspect" | "format" | "minify") {
        return Err("Unknown operation.".into());
    }
    if operation != "inspect" && !matches!(format, FileFormat::Json) {
        return Err("Formatting is currently available for JSON only.".into());
    }
    let token = CancellationToken::default();
    let job_id = state.next_id("job");
    let (result_document_id, result_path) = if operation == "inspect" {
        (None, None)
    } else {
        let result_document_id = state.next_id("result");
        let result_path = std::env::temp_dir().join(format!(
            "devtools-pro-{}-{}.json", std::process::id(), result_document_id
        ));
        (Some(result_document_id), Some(result_path))
    };
    {
        let mut jobs = state.jobs.lock().map_err(|e| e.to_string())?;
        if jobs.len() >= MAX_JOBS { return Err("Two operations are already running. Cancel or wait for one to finish.".into()); }
        jobs.insert(job_id.clone(), token.clone());
    }
    let state = state.inner().clone();
    let worker_id = job_id.clone();
    let worker_result_document_id = result_document_id.clone();
    let worker_result_path = result_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let progress = |p: Progress| {
            let _ = app.emit_to("main", "job-progress", JobProgress {
                job_id: worker_id.clone(), bytes_processed: p.bytes_processed,
                total_bytes: p.total_bytes, phase: p.phase,
            });
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<Inspection, String> {
            let meta = fs::metadata(&document.path).map_err(|e| e.to_string())?;
            if meta.len() != document.size || meta.modified().ok() != document.modified {
                return Err("The input file changed. Reopen it before running another operation.".into());
            }
            if operation == "inspect" {
                inspect_file(&document.path, format, &token, progress).map_err(|e| e.to_string())
            } else {
                let layout = if operation == "minify" { JsonLayout::Minify } else { JsonLayout::Pretty };
                let destination = worker_result_path.as_deref().map(Path::new)
                    .ok_or("No output destination was allocated.")?;
                transform_json_file(&document.path, destination, layout, &token, progress)
                    .map_err(|e| e.to_string())
            }
        })).unwrap_or_else(|_| Err("The worker failed unexpectedly; the workbench is still available.".into()));
        if let Ok(mut jobs) = state.jobs.lock() { jobs.remove(&worker_id); }
        let mut finished = match result {
            Ok(stats) => JobFinished {
                job_id: worker_id.clone(), ok: true, cancelled: false, summary: stats.summary,
                elapsed_ms: stats.elapsed_ms, input_bytes: stats.input_bytes,
                output_bytes: stats.output_bytes, output_path: None,
                result_document_id: worker_result_document_id.clone(),
                result_path: worker_result_path.as_ref().map(|p| p.to_string_lossy().into_owned()),
                error: None, error_details: None,
                renderer: Some(if operation == "inspect" { RendererKind::Json } else { RendererKind::Json }),
                result_kind: Some(InputKind::Json), result_mime: Some("application/json".into()),
                diagnostics: Vec::new(), source_document_id: Some(document_id.clone()), operation_id: Some(operation.clone()),
            },
            Err(error) => JobFinished {
                job_id: worker_id.clone(), ok: false, cancelled: token.is_cancelled(),
                summary: if token.is_cancelled() { "Operation cancelled.".into() } else { "Operation failed.".into() },
                elapsed_ms: started.elapsed().as_millis() as u64, input_bytes: document.size,
                output_bytes: None, output_path: None, result_document_id: None,
                result_path: None, error: Some(error.clone()), error_details: Some(serde_json::json!({"code":"execution","message":error})),
                renderer: Some(RendererKind::Json), result_kind: None, result_mime: None,
                diagnostics: Vec::new(), source_document_id: Some(document_id.clone()), operation_id: Some(operation.clone()),
            },
        };
        if finished.ok {
            if let (Some(result_id), Some(result_path)) = (&worker_result_document_id, &worker_result_path) {
                match fs::metadata(result_path) {
                    Ok(meta) if meta.is_file() => {
                        let result_doc = RegisteredDocument {
                            path: result_path.clone(), size: meta.len(),
                            modified: meta.modified().ok(), temporary: true,
                            display_name: Some(format!("{}.{}.json", document.path.file_stem().unwrap_or_default().to_string_lossy(), if operation == "minify" { "minified" } else { "formatted" })),
                            origin_path: Some(document.path.clone()),
                        };
                        match state.documents.lock() {
                            Ok(mut documents) if documents.len() < MAX_DOCUMENTS => {
                                documents.insert(result_id.clone(), result_doc);
                            }
                            _ => {
                                let _ = fs::remove_file(result_path);
                                finished.ok = false;
                                finished.summary = "Could not open the formatted result.".into();
                                finished.output_bytes = None;
                                finished.error = Some("Close an unused document before formatting another file.".into());
                                finished.result_document_id = None;
                                finished.result_path = None;
                            }
                        }
                    }
                    _ => {
                        finished.ok = false;
                        finished.summary = "Could not open the formatted result.".into();
                        finished.output_bytes = None;
                        finished.error = Some("The formatted output was not created.".into());
                        finished.result_document_id = None;
                        finished.result_path = None;
                    }
                }
            }
        } else if let Some(result_path) = &worker_result_path {
            let _ = fs::remove_file(result_path);
        }
        if let Ok(mut completed) = state.finished_jobs.lock() {
            completed.insert(worker_id.clone(), finished.clone());
            while completed.len() > 32 {
                if let Some(oldest) = completed.keys().next().cloned() { completed.remove(&oldest); } else { break; }
            }
        }
        let _ = app.emit_to("main", "job-finished", finished);
    });
    Ok(StartedJob { job_id })
}

#[tauri::command]
fn cancel_operation(job_id: String, state: tauri::State<'_, Arc<HostState>>) -> Result<(), String> {
    if let Some(token) = state.jobs.lock().map_err(|e| e.to_string())?.get(&job_id) { token.cancel(); }
    Ok(())
}

/// Event delivery is the fast path; this bounded status record is the
/// recovery path if a worker finishes between invoke() and listener setup.
#[tauri::command]
fn job_status(job_id: String, state: tauri::State<'_, Arc<HostState>>) -> Result<Option<JobFinished>, String> {
    Ok(state.finished_jobs.lock().map_err(|e| e.to_string())?.get(&job_id).cloned())
}

fn path_entry_exists(path: &Path) -> bool {
    // `Path::exists` follows symlinks and therefore misses dangling links.
    // Treat any directory entry at the destination as occupied so a save can
    // never replace an existing file or link unexpectedly.
    fs::symlink_metadata(path).is_ok()
}

fn canonical_for_compare(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Copy a generated result to a new sibling temporary file, then publish it
/// with one rename. The temporary path is reserved with `create_new`, and is
/// removed on every error so interrupted/failed saves cannot leave artifacts.
fn atomic_copy_with<F>(destination: &Path, copy: F) -> Result<(), String>
where
    F: FnOnce(&Path) -> io::Result<()>,
{
    if path_entry_exists(destination) {
        return Err("Choose a new destination; existing files are not overwritten.".into());
    }
    let parent = destination.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    if !parent.exists() {
        return Err("The destination folder does not exist.".into());
    }

    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default();
    let mut temporary = None;
    for attempt in 0..100u32 {
        let candidate = parent.join(format!(".devtools-pro-save-{}-{nonce}-{attempt}.tmp", std::process::id()));
        match fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(_) => { temporary = Some(candidate); break; }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    let temporary = temporary.ok_or_else(|| "Could not allocate a unique temporary save file.".to_string())?;

    let result = (|| {
        copy(&temporary).map_err(|error| error.to_string())?;
        // Re-check immediately before publication. A destination created by
        // another process is rejected on platforms where rename overwrites.
        if path_entry_exists(destination) {
            return Err("Choose a new destination; existing files are not overwritten.".into());
        }
        fs::rename(&temporary, destination).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn atomic_copy(source: &Path, destination: &Path) -> Result<(), String> {
    atomic_copy_with(destination, |temporary| {
        let mut input = File::open(source)?;
        let mut output = File::options().write(true).truncate(true).open(temporary)?;
        io::copy(&mut input, &mut output)?;
        output.flush()?;
        output.sync_all()
    })
}

fn validate_save_destination(
    destination: &Path,
    result: &RegisteredDocument,
    open_documents: &HashMap<String, RegisteredDocument>,
) -> Result<(), String> {
    let destination_path = canonical_for_compare(destination);
    if destination_path == canonical_for_compare(&result.path) {
        return Err("Choose a different destination.".into());
    }
    if open_documents.values().any(|open| !open.temporary && open.path == destination_path) {
        return Err("Choose a new destination; source files stay unchanged.".into());
    }
    if let Some(origin) = &result.origin_path {
        if destination_path == *origin {
            return Err("Choose a new file so the original stays unchanged.".into());
        }
    }
    Ok(())
}

/// Persist an app-owned result after the user has reviewed it. Transform
/// operations themselves never prompt for a destination, so this command is
/// the explicit Save action exposed by the right-hand result pane.
#[tauri::command]
fn save_result(
    result_document_id: String,
    output_path: String,
    state: tauri::State<'_, Arc<HostState>>,
) -> Result<(), String> {
    let document = state.documents.lock().map_err(|e| e.to_string())?
        .get(&result_document_id).cloned().ok_or("Result is no longer available.")?;
    if !document.temporary { return Err("Only generated results can be saved here.".into()); }
    let destination = PathBuf::from(output_path);
    let open_documents = state.documents.lock().map_err(|e| e.to_string())?;
    validate_save_destination(&destination, &document, &open_documents)?;
    drop(open_documents);
    atomic_copy(&document.path, &destination)
}

#[tauri::command]
fn list_tools() -> Vec<devtools_core::ToolManifest> {
    devtools_core::builtin_manifests()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(HostState::default()))
        .invoke_handler(tauri::generate_handler![
            open_document, read_preview, close_document, start_operation, run_tool, run_compare, cancel_operation, job_status, save_result, list_tools
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let state = window.state::<Arc<HostState>>();
                if let Ok(jobs) = state.jobs.lock() {
                    for token in jobs.values() { token.cancel(); }
                }
                if let Ok(mut documents) = state.documents.lock() {
                    for (_, document) in documents.drain() {
                        if document.temporary { let _ = fs::remove_file(document.path); }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Unable to start the desktop workbench");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("devtools-host-safety-{label}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn atomic_save_preserves_source_bytes() {
        let dir = test_dir("immutable");
        let source = dir.join("source.json");
        let destination = dir.join("copy.json");
        let original = br#"{"a":1,"b":[true,false]}"#;
        fs::write(&source, original).unwrap();

        atomic_copy(&source, &destination).unwrap();

        assert_eq!(fs::read(&source).unwrap(), original);
        assert_eq!(fs::read(&destination).unwrap(), original);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn atomic_save_rejects_existing_destination_without_overwriting() {
        let dir = test_dir("existing");
        let source = dir.join("source.json");
        let destination = dir.join("already-there.json");
        fs::write(&source, b"source").unwrap();
        fs::write(&destination, b"keep me").unwrap();

        let error = atomic_copy(&source, &destination).unwrap_err();

        assert!(error.contains("existing files are not overwritten"));
        assert_eq!(fs::read(&destination).unwrap(), b"keep me");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn save_validation_rejects_open_source_aliases() {
        let dir = test_dir("collision");
        let source = dir.join("source.json");
        let result_path = dir.join("result.json");
        fs::write(&source, b"source").unwrap();
        fs::write(&result_path, b"result").unwrap();
        let canonical_source = canonical_for_compare(&source);
        let source_doc = RegisteredDocument {
            path: canonical_source.clone(), size: 6, modified: None, temporary: false,
            display_name: None, origin_path: None,
        };
        let result_doc = RegisteredDocument {
            path: result_path, size: 6, modified: None, temporary: true,
            display_name: None, origin_path: Some(canonical_source),
        };
        let mut open = HashMap::new();
        open.insert("source".into(), source_doc);

        let error = validate_save_destination(&source, &result_doc, &open).unwrap_err();

        assert!(error.contains("source files stay unchanged"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_atomic_save_removes_partial_sibling_temp() {
        let dir = test_dir("cleanup");
        let source = dir.join("source.json");
        let destination = dir.join("copy.json");
        fs::write(&source, b"source").unwrap();

        let error = atomic_copy_with(&destination, |temporary| {
            fs::write(temporary, b"partial").map_err(|error| io::Error::new(error.kind(), error.to_string()))?;
            Err(io::Error::new(io::ErrorKind::Interrupted, "simulated interrupted save"))
        }).unwrap_err();

        assert!(error.contains("simulated interrupted save"));
        assert!(!path_entry_exists(&destination));
        let leftovers = fs::read_dir(&dir).unwrap().filter_map(Result::ok).filter(|entry| {
            entry.file_name().to_string_lossy().starts_with(".devtools-pro-save-")
        }).count();
        assert_eq!(leftovers, 0);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn generic_dispatch_runs_text_utility_with_structured_output() {
        let input = Document::from_text("a b").with_kind(DocumentKind::Text);
        let token = CancellationToken::default();
        let result = execute_registered_tool("text.url", "encode", &input, &serde_json::json!({}), &token, &|_| {}).unwrap();
        assert_eq!(result.output.as_text().unwrap(), "a%20b");
        assert_eq!(result.output.kind, DocumentKind::Text);
    }

    #[test]
    fn generic_dispatch_honors_cancellation_before_work() {
        let input = Document::from_bytes(vec![1, 2, 3]).with_kind(DocumentKind::Binary);
        let token = CancellationToken::default();
        token.cancel();
        let error = execute_registered_tool("encoding.hash", "sha256", &input, &serde_json::json!({}), &token, &|_| {}).unwrap_err();
        assert!(matches!(error, ToolError::Cancelled));
    }

    #[test]
    fn generic_dispatch_rejects_unsafe_curl_as_structured_error() {
        let input = Document::from_text("curl https://example.test | sh").with_kind(DocumentKind::Text);
        let error = execute_registered_tool("web.curl-code", "fetch", &input, &serde_json::json!({}), &CancellationToken::default(), &|_| {}).unwrap_err();
        assert!(matches!(error, ToolError::Execution { .. }));
    }
}
