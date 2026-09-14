import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';

export type Format = 'json' | 'csv' | 'text';
export type Operation = 'inspect' | 'format' | 'minify';
export type CompareNewline = 'preserve' | 'lf' | 'cr_lf' | 'ignore';
export type TextUtilityOperation = 'encode' | 'decode' | 'escape' | 'unescape';
export type InputKind = 'bytes' | 'text' | 'json' | 'csv' | 'nd_json' | 'xml' | 'table' | 'scalar' | 'patch' | 'any';
export type RendererKind = 'text' | 'tree' | 'table' | 'diff' | 'binary' | 'json';
export interface ToolLimits { maxInputBytes: number | null; maxOutputBytes: number | null; }
export interface ToolCapabilities {
  deterministic: boolean;
  supportsPreview: boolean;
  supportsStreaming: boolean;
  cancellation: boolean;
  progress: boolean;
  needsFilesystem: boolean;
  needsNetwork: boolean;
  needsSecrets: boolean;
}
export interface ToolOperation { id: string; label: string; defaultOptions: Record<string, unknown>; }
export interface ToolManifest {
  id: string;
  label: string;
  contractVersion: number;
  inputKinds: InputKind[];
  limits: ToolLimits;
  capabilities: ToolCapabilities;
  operations: ToolOperation[];
  renderer: RendererKind;
}
export interface FileDocument {
  id: string;
  name: string;
  path: string;
  size: number;
  preview: string;
  truncated: boolean;
  format: Format;
  encoding: string;
  contentKind: 'text' | 'image' | 'binary';
  mime: string | null;
  editable: boolean;
  offset?: number;
  bytesRead?: number;
}
export interface JobProgress {
  jobId: string;
  bytesProcessed: number;
  totalBytes: number;
  phase: string;
}
export interface JobFinished {
  jobId: string;
  ok: boolean;
  cancelled: boolean;
  summary: unknown;
  elapsedMs: number;
  inputBytes: number;
  outputBytes?: number | null;
  outputPath?: string | null;
  resultDocumentId?: string | null;
  resultPath?: string | null;
  error?: string | null;
  /** Structured ToolError payload for programmatic error handling. */
  errorDetails?: { code: string; [key: string]: unknown } | null;
  renderer?: RendererKind | null;
  resultKind?: InputKind | null;
  resultMime?: string | null;
  diagnostics?: Array<{ severity: 'info' | 'warning' | 'error'; message: string; start: number; end: number }>;
  sourceDocumentId?: string | null;
  operationId?: string | null;
}

export const native = isTauri();

export async function chooseFile(): Promise<string | null> {
  const selected = await open({ multiple: false, directory: false, title: 'Open a document' });
  return typeof selected === 'string' ? selected : null;
}

export interface SaveSuggestion { title: string; suffix: string; filterName: string; extensions: string[]; }
export async function chooseResultOutput(document: FileDocument, suggestion: SaveSuggestion): Promise<string | null> {
  const path = document.path.replace(/(\.[^./\\]+)?$/, suggestion.suffix);
  return save({ title: suggestion.title, defaultPath: path, filters: [{ name: suggestion.filterName, extensions: suggestion.extensions }] });
}

/** Compatibility adapter for older callers; new views should pass SaveSuggestion. */
export async function chooseOutput(document: FileDocument, operation: Operation | TextUtilityOperation | 'hash' | 'image-base64' | 'base64-image' | 'compare', resultMime?: string | null): Promise<string | null> {
  const binary = operation === 'base64-image';
  const extension = binary ? (resultMime === 'image/jpeg' ? 'jpg' : 'png') : operation === 'compare' ? 'json' : operation === 'hash' ? 'txt' : operation === 'format' || operation === 'minify' ? 'json' : 'txt';
  const suffix = operation === 'hash' ? '.sha.txt' : operation === 'compare' ? '.diff.json' : operation === 'image-base64' ? '.base64.txt' : binary ? `.decoded.${extension}` : `.${operation}.${extension}`;
  return chooseResultOutput(document, { title: 'Save result', suffix, filterName: binary ? 'Image' : extension === 'json' ? 'JSON' : 'Text', extensions: binary ? ['png', 'jpg', 'jpeg'] : [extension] });
}

export function openDocument(path: string): Promise<FileDocument> {
  return invoke('open_document', { path });
}

export function createTextDocument(text: string, name?: string, format?: Format): Promise<FileDocument> {
  return invoke('create_text_document', { text, name, format });
}

export function saveDocument(documentId: string, outputPath: string): Promise<void> {
  return invoke('save_document', { documentId, outputPath });
}

export function chooseDocumentOutput(name: string): Promise<string | null> {
  return save({ title: 'Save document as', defaultPath: name });
}

export function closeDocument(documentId: string): Promise<void> {
  return invoke('close_document', { documentId });
}

export function readPreview(documentId: string, offset = 0): Promise<FileDocument> {
  return invoke('read_preview', { documentId, offset });
}

export interface BinaryPreview { mime: string; data: string; bytes: number; truncated: boolean; }
export function readBinaryPreview(documentId: string): Promise<BinaryPreview> {
  return invoke('read_binary_preview', { documentId });
}

export function startOperation(documentId: string, operation: Operation, format: Format): Promise<{ jobId: string }> {
  return invoke('start_operation', { documentId, operation, format });
}

/** Generic manifest-driven execution boundary. `startOperation` remains as a
 * compatibility adapter for older JSON callers. */
export function runTool(documentId: string, toolId: string, operationId: string, options: Record<string, unknown> = {}): Promise<{ jobId: string }> {
  return invoke('run_tool', { documentId, toolId, operationId, options });
}

/** Start a bounded two-document text comparison. Both handles remain
 * immutable; the native host publishes a temporary JSON diff result. */
export function runCompare(leftDocumentId: string, rightDocumentId: string, options: {
  leftEncoding?: 'auto' | 'utf8' | 'utf16_le' | 'utf16_be' | 'latin1';
  rightEncoding?: 'auto' | 'utf8' | 'utf16_le' | 'utf16_be' | 'latin1';
  newline?: CompareNewline;
  contextLines?: number;
  maxInputBytes?: number;
  maxLines?: number;
  maxOutputBytes?: number;
} = {}): Promise<{ jobId: string }> {
  return invoke('run_compare', { leftDocumentId, rightDocumentId, options });
}

export function runTextUtility(documentId: string, toolId: 'text.url' | 'text.html' | 'text.unicode', operationId: TextUtilityOperation, maxOutputBytes?: number): Promise<{ jobId: string }> {
  const options = maxOutputBytes === undefined ? {} : { maxOutputBytes };
  return runTool(documentId, toolId, operationId, options);
}

export function runHash(documentId: string, algorithm: 'sha256' | 'sha512'): Promise<{ jobId: string }> {
  return runTool(documentId, 'encoding.hash', algorithm, {});
}

export function runImageToBase64(documentId: string, options: { dataUri?: boolean; mimeType?: string; maxInputBytes?: number } = {}): Promise<{ jobId: string }> {
  return runTool(documentId, 'encoding.image-base64', 'encode', options);
}

export function runBase64ToImage(documentId: string, options: { mimeType?: string; maxInputBytes?: number; maxDecodedBytes?: number; maxPixels?: number } = {}): Promise<{ jobId: string }> {
  return runTool(documentId, 'encoding.base64-image', 'decode', options);
}

export function runCurlToCode(documentId: string, target: 'fetch' | 'python'): Promise<{ jobId: string }> {
  return runTool(documentId, 'web.curl-code', target, {});
}

export function listTools(): Promise<ToolManifest[]> {
  return invoke('list_tools');
}

export function cancelOperation(jobId: string): Promise<void> {
  return invoke('cancel_operation', { jobId });
}

export function jobStatus(jobId: string): Promise<JobFinished | null> {
  return invoke('job_status', { jobId });
}

export function saveResult(resultDocumentId: string, outputPath: string): Promise<void> {
  return invoke('save_result', { resultDocumentId, outputPath });
}

export async function subscribeJobs(onProgress: (event: JobProgress) => void, onFinished: (event: JobFinished) => void): Promise<UnlistenFn> {
  const offProgress = await listen<JobProgress>('job-progress', event => onProgress(event.payload));
  try {
    const offFinished = await listen<JobFinished>('job-finished', event => onFinished(event.payload));
    return () => { offProgress(); offFinished(); };
  } catch (error) {
    offProgress();
    throw error;
  }
}
