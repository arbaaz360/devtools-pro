import type { ExecutionIdentity, FileDocument, JobFinished, JobProgress, ToolManifest } from "../bridge";
import type { WorkbenchApi } from "../workbench/controller.ts";
import { packageTools } from "./catalog.ts";
import { prepareOptions, primaryInput, primaryOutput, type EngineTool } from "./describe.ts";
import type { RunOutcome, RunRequest } from "./protocol.ts";

/**
 * The webview's JavaScript engine for v2 package tools, the second of the two
 * trusted engines in docs/PLUGIN_SYSTEM_DESIGN.md. It sits behind the same
 * WorkbenchApi the controller already drives: a package tool starts a job,
 * reports progress and completion, and can be cancelled exactly like a native
 * one. The native host keeps owning documents. Input bytes are read from the
 * host document, the processor runs in a dedicated Worker that is terminated
 * on cancel or deadline, and the complete output becomes a host-owned result
 * document so preview, copy and save do not change.
 *
 * A tool id the native host also lists stays native: Rust wins where a Rust
 * executor exists.
 */
interface WorkerJob {
  jobId: string;
  tool: EngineTool;
  documentId: string;
  operationId: string;
  worker?: Worker;
  deadline?: ReturnType<typeof setTimeout>;
  finished?: JobFinished;
  started: number;
  inputBytes: number;
}

type Listeners = { progress: (e: JobProgress) => void; finish: (e: JobFinished) => void };

export class WorkerEngine {
  readonly tools = new Map(packageTools.map((tool) => [tool.id, tool] as const));
  private shadowed = new Set<string>();
  private jobs = new Map<string, WorkerJob>();
  private listeners = new Set<Listeners>();
  private sequence = 0;
  constructor(private readonly host: Pick<WorkbenchApi, "readPreview" | "createTextDocument" | "closeDocument">) {}

  /** True when a run for this tool belongs to the worker engine. */
  owns(toolId: string): boolean {
    return this.tools.has(toolId) && !this.shadowed.has(toolId);
  }

  /** Native manifests first; package tools fill in the ids the host does not serve. */
  async listTools(native: Promise<ToolManifest[]>): Promise<ToolManifest[]> {
    const manifests = await native;
    this.shadowed = new Set(manifests.map((manifest) => manifest.id));
    return [...manifests, ...packageTools.filter((tool) => !this.shadowed.has(tool.id)).map((tool) => tool.manifest)];
  }

  subscribe(progress: Listeners["progress"], finish: Listeners["finish"]): () => void {
    const entry = { progress, finish };
    this.listeners.add(entry);
    return () => void this.listeners.delete(entry);
  }

  runTool(documentId: string, toolId: string, operationId: string, options: Record<string, unknown>): { jobId: string; identity: ExecutionIdentity } {
    const tool = this.tools.get(toolId);
    if (!tool) throw new Error(`${toolId} is not a package tool.`);
    const operation = tool.operations.find((item) => item.id === operationId);
    if (!operation) throw new Error(`${toolId} has no operation ${operationId}.`);
    const jobId = `worker-${++this.sequence}`;
    const job: WorkerJob = { jobId, tool, documentId, operationId, started: performance.now(), inputBytes: 0 };
    this.jobs.set(jobId, job);
    void this.execute(job, prepareOptions(operation, options));
    return {
      jobId,
      identity: {
        pluginId: tool.pluginId,
        pluginVersion: "0",
        toolId,
        operationId,
        instanceId: documentId,
        jobId,
        generation: 0,
      },
    };
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (!job.finished) this.settle(job, { jobId, ok: false, cancelled: true, summary: null, elapsedMs: this.elapsed(job), inputBytes: job.inputBytes });
    return true;
  }

  status(jobId: string): JobFinished | null | undefined {
    const job = this.jobs.get(jobId);
    return job ? (job.finished ?? null) : undefined;
  }

  private elapsed(job: WorkerJob): number {
    return Math.round(performance.now() - job.started);
  }

  private async execute(job: WorkerJob, options: Record<string, unknown>) {
    const operation = job.tool.operations.find((item) => item.id === job.operationId)!;
    const input = primaryInput(operation)!;
    try {
      const text = await this.readDocument(job.documentId);
      if (job.finished) return;
      const bytes = new TextEncoder().encode(text);
      job.inputBytes = bytes.byteLength;
      const limits = {
        maxInputBytes: Number(operation.limits.maxInputBytes),
        maxOutputBytes: Number(operation.limits.maxOutputBytes),
        maxChunkBytes: Number(operation.limits.maxChunkBytes),
        deadlineMs: Number(operation.limits.deadlineMs),
      };
      if (bytes.byteLength > limits.maxInputBytes)
        throw new Error(`${job.tool.manifest.label} accepts at most ${Math.round(limits.maxInputBytes / 1024)} KiB per input.`);
      const worker = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
      job.worker = worker;
      const outcome = await new Promise<RunOutcome>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<RunOutcome>) => resolve(event.data);
        worker.onerror = (event) => reject(new Error(event.message || "The package engine failed."));
        // Deadlines are enforced, not cooperative: the worker is discarded. The
        // allowance covers worker start-up and module load on top of the
        // processor's own declared budget.
        if (limits.deadlineMs > 0)
          job.deadline = setTimeout(() => reject(new Error(`${job.tool.manifest.label} exceeded its ${limits.deadlineMs} ms deadline.`)), Math.max(2000, limits.deadlineMs * 4));
        const request: RunRequest = {
          type: "run",
          jobId: job.jobId,
          packageDir: job.tool.packageDir,
          pluginId: job.tool.pluginId,
          toolId: job.tool.id,
          operationId: job.operationId,
          options,
          inputs: { [input.id]: bytes },
          limits,
        };
        worker.postMessage(request, [bytes.buffer as ArrayBuffer]);
      });
      if (job.finished) return;
      if (!outcome.ok) {
        this.settle(job, {
          jobId: job.jobId,
          ok: false,
          cancelled: outcome.cancelled,
          summary: null,
          elapsedMs: outcome.elapsedMs,
          inputBytes: job.inputBytes,
          error: outcome.error.message,
          errorDetails: outcome.error.code ? { code: outcome.error.code, data: outcome.error.data } : null,
          operationId: job.operationId,
          sourceDocumentId: job.documentId,
        });
        return;
      }
      const port = primaryOutput(operation);
      const portId = port?.id ?? Object.keys(outcome.outputs)[0] ?? "output";
      const value = outcome.values[portId];
      const produced = outcome.outputs[portId];
      const json = !!port?.mime?.includes("application/json") || (!produced && value !== undefined);
      const resultText = produced ? new TextDecoder().decode(produced) : value === undefined ? "" : JSON.stringify(value, null, 2);
      const result = await this.host.createTextDocument(resultText, `${job.tool.manifest.label}.${json ? "json" : "txt"}`, json ? "json" : "text");
      if (job.finished) {
        void this.host.closeDocument(result.id).catch(() => undefined);
        return;
      }
      this.settle(job, {
        jobId: job.jobId,
        ok: true,
        cancelled: false,
        // Properties travel as a JSON string, the way native tools report them,
        // so the result pane renders them as key: value lines.
        summary: value === undefined ? null : JSON.stringify(value),
        elapsedMs: outcome.elapsedMs,
        inputBytes: job.inputBytes,
        outputBytes: result.size,
        resultDocumentId: result.id,
        resultPath: result.path,
        renderer: json ? "json" : "text",
        resultKind: json ? "json" : "text",
        resultMime: json ? "application/json" : (port?.mime?.[0] ?? "text/plain"),
        diagnostics: [],
        sourceDocumentId: job.documentId,
        operationId: job.operationId,
      });
    } catch (error) {
      if (job.finished) return;
      this.settle(job, {
        jobId: job.jobId,
        ok: false,
        cancelled: false,
        summary: null,
        elapsedMs: this.elapsed(job),
        inputBytes: job.inputBytes,
        error: error instanceof Error ? error.message : String(error),
        operationId: job.operationId,
        sourceDocumentId: job.documentId,
      });
    }
  }

  /** The complete document text, page by page, the way the result reader works. */
  private async readDocument(id: string): Promise<string> {
    const first: FileDocument = await this.host.readPreview(id, 0);
    if (first.contentKind !== "text") throw new Error("Package tools accept text documents.");
    let text = first.preview;
    let offset = first.bytesRead ?? new TextEncoder().encode(first.preview).length;
    while (offset < first.size) {
      const page = await this.host.readPreview(id, offset);
      if (!page.bytesRead) throw new Error("The complete input could not be read.");
      text += page.preview;
      offset += page.bytesRead;
    }
    return text;
  }

  private settle(job: WorkerJob, event: JobFinished) {
    job.finished = event;
    if (job.deadline) clearTimeout(job.deadline);
    job.worker?.terminate();
    job.worker = undefined;
    for (const listener of this.listeners) listener.finish(event);
    // Finished jobs stay queryable briefly for jobStatus polling, then go.
    setTimeout(() => this.jobs.delete(job.jobId), 60_000);
  }

  /** The WorkbenchApi the controller sees: native unless the tool is ours. */
  wrap(api: WorkbenchApi): WorkbenchApi {
    return {
      ...api,
      listTools: () => this.listTools(api.listTools()),
      runTool: (id, tool, operation, options) =>
        this.owns(tool) ? Promise.resolve(this.runTool(id, tool, operation, options)) : api.runTool(id, tool, operation, options),
      cancelOperation: (id) => (this.cancel(id) ? Promise.resolve() : api.cancelOperation(id)),
      jobStatus: (id) => {
        const status = this.status(id);
        return status === undefined ? api.jobStatus(id) : Promise.resolve(status);
      },
      subscribeJobs: async (progress, finish) => {
        const off = this.subscribe(progress, finish);
        try {
          const offNative = await api.subscribeJobs(progress, finish);
          return () => {
            off();
            offNative();
          };
        } catch (error) {
          off();
          throw error;
        }
      },
    };
  }
}
