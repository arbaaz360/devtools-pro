import type { RendererKind } from './bridge';

export interface ResultScope {
  toolId: string;
  sourceDocumentId: string | null;
  operationId: string;
  renderer: RendererKind;
}

export interface PendingJob extends ResultScope {
  revision: number;
  jobId: string | null;
}

export interface ResultReadToken extends ResultScope {
  revision: number;
  jobId: string;
  resultDocumentId: string;
}

export class ResultLifecycle {
  private revision = 0;
  private pending: PendingJob | null = null;
  private running = false;
  private completedJobId: string | null = null;

  begin(scope: ResultScope): PendingJob {
    this.revision += 1;
    this.pending = { ...scope, revision: this.revision, jobId: null };
    this.running = true;
    this.completedJobId = null;
    return this.pending;
  }

  attach(pending: PendingJob, jobId: string): boolean {
    if (this.pending !== pending || pending.revision !== this.revision) return false;
    pending.jobId = jobId;
    return true;
  }

  accepts(jobId: string): boolean {
    return this.pending?.jobId === jobId && this.pending.revision === this.revision;
  }

  resultToken(jobId: string, resultDocumentId: string): ResultReadToken | null {
    if (!this.accepts(jobId) || !this.pending) return null;
    return { ...this.pending, jobId, resultDocumentId };
  }

  finish(jobId: string): boolean {
    if (!this.accepts(jobId)) return false;
    this.running = false;
    this.completedJobId = jobId;
    return true;
  }

  isFinished(jobId: string): boolean { return this.completedJobId === jobId; }

  isCurrent(token: ResultReadToken): boolean {
    return token.revision === this.revision && this.pending?.jobId === token.jobId;
  }

  invalidate(): string | null {
    const jobId = this.pending?.jobId ?? null;
    this.revision += 1;
    this.pending = null;
    this.running = false;
    this.completedJobId = null;
    return jobId;
  }

  activeJobId(): string | null {
    return this.running ? this.pending?.jobId ?? null : null;
  }
}
