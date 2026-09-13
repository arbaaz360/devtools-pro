import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';

export type Format = 'json' | 'csv' | 'text';
export type Operation = 'inspect' | 'format' | 'minify';
export interface FileDocument {
  id: string;
  name: string;
  path: string;
  size: number;
  preview: string;
  truncated: boolean;
  format: Format;
  encoding: string;
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
}

export const native = isTauri();

export async function chooseFile(): Promise<string | null> {
  const selected = await open({ multiple: false, directory: false, title: 'Open a document' });
  return typeof selected === 'string' ? selected : null;
}

export async function chooseOutput(document: FileDocument, operation: Operation): Promise<string | null> {
  const path = document.path.replace(/(\.[^./\\]+)?$/, `.${operation === 'format' ? 'formatted' : 'minified'}.json`);
  return save({ title: 'Save JSON to a new file', defaultPath: path, filters: [{ name: 'JSON', extensions: ['json'] }] });
}

export function openDocument(path: string): Promise<FileDocument> {
  return invoke('open_document', { path });
}

export function closeDocument(documentId: string): Promise<void> {
  return invoke('close_document', { documentId });
}

export function readPreview(documentId: string, offset = 0): Promise<FileDocument> {
  return invoke('read_preview', { documentId, offset });
}

export function startOperation(documentId: string, operation: Operation, format: Format): Promise<{ jobId: string }> {
  return invoke('start_operation', { documentId, operation, format });
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
