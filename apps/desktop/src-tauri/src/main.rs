#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use devtools_core::{
    CancellationToken, FileFormat, Inspection, JsonLayout, Progress,
    inspect_file, transform_json_file,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
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

#[tauri::command]
fn start_operation(
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
                error: None,
            },
            Err(error) => JobFinished {
                job_id: worker_id.clone(), ok: false, cancelled: token.is_cancelled(),
                summary: if token.is_cancelled() { "Operation cancelled.".into() } else { "Operation failed.".into() },
                elapsed_ms: started.elapsed().as_millis() as u64, input_bytes: document.size,
                output_bytes: None, output_path: None, result_document_id: None,
                result_path: None, error: Some(error),
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
    if destination == document.path { return Err("Choose a different destination.".into()); }
    // Never allow an explicit save to replace any open source document.
    let comparison_path = fs::canonicalize(&destination).unwrap_or_else(|_| destination.clone());
    if state.documents.lock().map_err(|e| e.to_string())?.values().any(|open| !open.temporary && open.path == comparison_path) {
        return Err("Choose a new destination; source files stay unchanged.".into());
    }
    if let Some(origin) = &document.origin_path {
        if destination.exists() && fs::canonicalize(&destination).ok().as_ref() == Some(origin) {
            return Err("Choose a new file so the original stays unchanged.".into());
        }
    }
    if let Some(parent) = destination.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err("The destination folder does not exist.".into());
        }
    }
    if destination.exists() {
        return Err("Choose a new destination; existing files are not overwritten.".into());
    }
    let parent = destination.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default();
    let temporary = parent.join(format!(".devtools-pro-save-{}-{}.tmp", std::process::id(), nonce));
    fs::copy(&document.path, &temporary).map_err(|e| e.to_string())?;
    if let Err(error) = fs::rename(&temporary, &destination) {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(())
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
            open_document, read_preview, close_document, start_operation, cancel_operation, job_status, save_result, list_tools
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
