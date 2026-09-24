/// <reference lib="webworker" />
import {
  ProcessorCancelled,
  ProcessorContext,
  type Limits,
  type InputInfo,
  type NamedReader,
  type OutputArtifact,
  type OutputSink,
} from "../../../../packages/plugin-sdk/src/context.ts";
import type { RunError, RunOutcome, RunRequest } from "./protocol.ts";

// One module per package, loaded on demand. The negated entries are the
// Node-only processors listed in catalog.ts; they never reach the webview.
const processors = import.meta.glob([
  "../../../../plugins/*/processor.mjs",
  "!../../../../plugins/hash/processor.mjs",
]) as Record<string, () => Promise<Processor>>;

interface Processor {
  execute?: (
    request: { pluginId: string; toolId: string; operationId: string; options: Record<string, unknown> },
    context: ProcessorContext,
  ) => unknown;
}

/** The host hands the worker immutable bytes; the reader only ever copies out of them. */
class BytesReader implements NamedReader {
  constructor(
    private readonly inputs: Record<string, Uint8Array>,
    private readonly infos: Record<string, InputInfo> = {},
  ) {}
  info(port: string): InputInfo { return this.infos[port] ?? { contentKind: "text" }; }
  private port(port: string): Uint8Array {
    const value = this.inputs[port];
    if (!value) throw new Error(`named input ${port} was not supplied`);
    return value;
  }
  read(port: string, maxBytes: number): Uint8Array {
    const value = this.port(port);
    if (value.byteLength > maxBytes) throw new Error(`read of ${port} exceeds the ${maxBytes} byte limit`);
    return value.slice();
  }
  size(port: string): number {
    return this.port(port).byteLength;
  }
  readRange(port: string, offset: number, maxBytes: number): Uint8Array {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`invalid offset for ${port}`);
    return this.port(port).slice(offset, offset + maxBytes);
  }
}

/** Collects each port's chunks; the total per port is bounded by the limits. */
class CollectingSink implements OutputSink {
  readonly chunks = new Map<string, Uint8Array[]>();
  readonly totals = new Map<string, number>();
  readonly values = new Map<string, unknown>();
  async write(port: string, bytes: Uint8Array, limits: Limits): Promise<OutputArtifact> {
    if (bytes.byteLength > limits.maxChunkBytes) throw new Error("output chunk exceeds limit");
    const total = (this.totals.get(port) ?? 0) + bytes.byteLength;
    if (total > limits.maxOutputBytes) throw new Error("output exceeds limit");
    this.totals.set(port, total);
    const list = this.chunks.get(port) ?? [];
    list.push(bytes.slice());
    this.chunks.set(port, list);
    const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
    const contentHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return { handle: `worker:${port}`, byteLength: total, contentHash };
  }
  value(port: string, value: unknown): void {
    this.values.set(port, value);
  }
  outputs(): Record<string, Uint8Array> {
    const result: Record<string, Uint8Array> = {};
    for (const [port, list] of this.chunks) {
      const bytes = new Uint8Array(this.totals.get(port) ?? 0);
      let offset = 0;
      for (const chunk of list) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      result[port] = bytes;
    }
    return result;
  }
}

function describeError(error: unknown): RunError {
  if (error instanceof Error) {
    const extra = error as Error & { code?: unknown; diagnostic?: { data?: unknown }; data?: unknown };
    return {
      name: error.name,
      message: error.message,
      code: typeof extra.code === "string" ? extra.code : undefined,
      data: extra.diagnostic?.data ?? extra.data,
    };
  }
  return { name: "Error", message: String(error) };
}

async function run(request: RunRequest): Promise<RunOutcome> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  try {
    const key = Object.keys(processors).find((path) => path.endsWith(`/${request.packageDir}/processor.mjs`));
    if (!key) throw new Error(`package ${request.packageDir} is not bundled for the webview engine`);
    const processor = await processors[key]!();
    if (typeof processor.execute !== "function")
      throw new Error(`processor for ${request.pluginId} does not export execute`);
    const sink = new CollectingSink();
    const context = new ProcessorContext(
      new BytesReader(request.inputs, request.inputInfo ?? {}),
      sink,
      { isCancelled: () => false },
      { now: () => new Date().toISOString(), timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone },
      { id: "webcrypto", fill: (bytes) => void crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>) },
      { resolve: (handle) => { throw new Error(`secret handle ${handle} is unavailable`); } },
      request.limits,
    );
    await processor.execute(
      { pluginId: request.pluginId, toolId: request.toolId, operationId: request.operationId, options: request.options },
      context,
    );
    return { type: "finished", jobId: request.jobId, ok: true, outputs: sink.outputs(), values: Object.fromEntries(sink.values), elapsedMs: elapsed() };
  } catch (error) {
    return {
      type: "finished",
      jobId: request.jobId,
      ok: false,
      cancelled: error instanceof ProcessorCancelled,
      error: describeError(error),
      elapsedMs: elapsed(),
    };
  }
}

self.onmessage = (event: MessageEvent<RunRequest>) => {
  if (event.data?.type !== "run") return;
  void run(event.data).then((outcome) => {
    const transfer = outcome.ok ? Object.values(outcome.outputs).map((bytes) => bytes.buffer as ArrayBuffer) : [];
    self.postMessage(outcome, transfer);
  });
};
