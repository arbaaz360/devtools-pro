import type { FileDocument, RendererKind, ToolManifest } from '../bridge';

export interface SavePresentation {
  title: string;
  suffix: string;
  label: string;
  savedStatus: string;
  filterName: string;
  extensions: string[];
}

export interface JobRequest {
  documentId: string;
  toolId: string;
  operationId: string;
  options?: Record<string, unknown>;
  title: string;
  status: string;
  sourceDocumentId?: string;
  run?: () => Promise<{ jobId: string }>;
}

export interface ToolViewRuntime {
  manifest: ToolManifest;
  document: FileDocument | null;
  busy: boolean;
  optionsHost: HTMLElement;
  actionsHost: HTMLElement;
  sourceHost: HTMLElement;
  documents: ReadonlyMap<string, FileDocument>;
  bytes(value: number | null | undefined): string;
  fail(message: string): void;
  setStatus(message: string): void;
  chooseDocument(): Promise<FileDocument | null>;
  createTextDocument(text: string): Promise<FileDocument>;
  removeDocument(id: string): Promise<void>;
  setActiveDocument(id: string): void;
  startJob(request: JobRequest): Promise<void>;
}

export interface ToolView {
  readonly ids: readonly string[];
  readonly group: string;
  readonly icon: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly sourceMode?: 'document' | 'custom';
  render(runtime: ToolViewRuntime): void;
  run(runtime: ToolViewRuntime, operationId: string): void | Promise<void>;
  canRun?(runtime: ToolViewRuntime, operationId: string): boolean;
  savePresentation(manifest: ToolManifest, operationId: string, mime: string | null): SavePresentation;
}

export interface RegisteredToolView {
  manifest: ToolManifest;
  view: ToolView | null;
  renderer: RendererKind;
}

export function defaultSavePresentation(manifest: ToolManifest, operationId: string, mime: string | null): SavePresentation {
  const binary = manifest.renderer === 'binary' || mime?.startsWith('image/');
  const extension = mime === 'image/jpeg' ? 'jpg' : binary ? 'png' : manifest.renderer === 'diff' ? 'json' : 'txt';
  return {
    title: `Save ${manifest.label} result`,
    suffix: `.${operationId}.${extension}`,
    label: binary ? 'Save image…' : manifest.renderer === 'diff' ? 'Save diff…' : 'Save result…',
    savedStatus: `${manifest.label} result saved`,
    filterName: binary ? 'Image' : manifest.renderer === 'diff' ? 'JSON' : 'Text',
    extensions: binary ? ['png', 'jpg', 'jpeg'] : [extension],
  };
}
