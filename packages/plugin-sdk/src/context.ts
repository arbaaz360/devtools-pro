import { createHash } from "node:crypto";

export interface Limits { maxInputBytes: number; maxOutputBytes: number; maxChunkBytes: number; deadlineMs: number; }
export const defaultLimits = (): Limits => ({ maxInputBytes: 16 * 1024 * 1024, maxOutputBytes: 16 * 1024 * 1024, maxChunkBytes: 1024 * 1024, deadlineMs: 0 });
export class ProcessorCancelled extends Error { constructor() { super("processor cancelled"); this.name = "ProcessorCancelled"; } }
export interface NamedReader {
  read(port: string, maxBytes: number): Uint8Array | Promise<Uint8Array>;
  /** Optional bounded range access used by streaming processors. */
  readRange?(port: string, offset: number, maxBytes: number): Uint8Array | Promise<Uint8Array>;
  /** Optional size probe; hosts should return the immutable byte length. */
  size?(port: string): number | Promise<number>;
}
export interface OutputArtifact { handle: string; byteLength: number; contentHash: string; }
export interface OutputSink { write(port: string, bytes: Uint8Array, limits: Limits): OutputArtifact | Promise<OutputArtifact>; value(port: string, value: unknown): void | Promise<void>; }
export interface Cancellation { isCancelled(): boolean; }
export interface Clock { now(): string; }
export interface Randomness { fill(bytes: Uint8Array): void; readonly id: string; }
export interface SecretStore { resolve(handle: string): Uint8Array | Promise<Uint8Array>; }

export class ProcessorContext {
  readonly reader: NamedReader; readonly outputs: OutputSink; readonly cancellation: Cancellation; readonly clock: Clock; readonly randomness: Randomness; readonly secrets: SecretStore; readonly limits: Limits;
  constructor(reader: NamedReader, outputs: OutputSink, cancellation: Cancellation, clock: Clock, randomness: Randomness, secrets: SecretStore, limits: Limits = defaultLimits()) { this.reader = reader; this.outputs = outputs; this.cancellation = cancellation; this.clock = clock; this.randomness = randomness; this.secrets = secrets; this.limits = limits; }
  async read(port: string): Promise<Uint8Array> { this.check(); const value = await this.reader.read(port, this.limits.maxInputBytes); if (value.byteLength > this.limits.maxInputBytes) throw new Error(`read of ${port} exceeds limit`); return value; }
  /**
   * Iterate an input without placing the whole document in processor memory.
   * A host-provided range reader is preferred; the fallback keeps small test
   * readers compatible while still enforcing the same input limit.
   */
  async *readChunks(port: string, chunkBytes = this.limits.maxChunkBytes): AsyncGenerator<Uint8Array> {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new Error("chunk size must be a positive safe integer");
    const size = this.reader.size ? await this.reader.size(port) : undefined;
    if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) throw new Error(`invalid size for ${port}`);
    if (size !== undefined && size > this.limits.maxInputBytes) throw new Error(`read of ${port} exceeds limit`);
    let offset = 0;
    let total = 0;
    if (this.reader.readRange) {
      while (size === undefined ? true : offset < size) {
        this.check();
        const value = await this.reader.readRange(port, offset, Math.min(chunkBytes, this.limits.maxInputBytes - total));
        if (value.byteLength === 0) break;
        total += value.byteLength;
        if (total > this.limits.maxInputBytes) throw new Error(`read of ${port} exceeds limit`);
        offset += value.byteLength;
        yield value;
      }
      return;
    }
    const value = await this.read(port);
    for (let start = 0; start < value.byteLength; start += chunkBytes) {
      this.check();
      yield value.slice(start, Math.min(start + chunkBytes, value.byteLength));
    }
  }
  async write(port: string, bytes: Uint8Array): Promise<OutputArtifact> { this.check(); if (bytes.byteLength > this.limits.maxChunkBytes) throw new Error("output chunk exceeds limit"); if (bytes.byteLength > this.limits.maxOutputBytes) throw new Error("output exceeds limit"); return await this.outputs.write(port, bytes, this.limits); }
  async writeValue(port: string, value: unknown): Promise<void> { this.check(); await this.outputs.value(port, value); }
  async secret(handle: string): Promise<Uint8Array> { this.check(); return await this.secrets.resolve(handle); }
  private check(): void { if (this.cancellation.isCancelled()) throw new ProcessorCancelled(); }
}

export class MemoryReader implements NamedReader {
  readonly inputs = new Map<string, Uint8Array>();
  insert(port: string, value: Uint8Array | string): this { this.inputs.set(port, typeof value === "string" ? new TextEncoder().encode(value) : value); return this; }
  read(port: string, maxBytes: number): Uint8Array { const value = this.inputs.get(port); if (!value) throw new Error(`named input ${port} was not supplied`); if (value.byteLength > maxBytes) throw new Error(`read of ${port} exceeds the ${maxBytes} byte limit`); return value.slice(); }
  size(port: string): number { const value = this.inputs.get(port); if (!value) throw new Error(`named input ${port} was not supplied`); return value.byteLength; }
  readRange(port: string, offset: number, maxBytes: number): Uint8Array { const value = this.inputs.get(port); if (!value) throw new Error(`named input ${port} was not supplied`); if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`invalid offset for ${port}`); return value.slice(offset, offset + maxBytes); }
}
export class MemoryOutputSink implements OutputSink {
  readonly artifacts = new Map<string, OutputArtifact>(); readonly bytes = new Map<string, Uint8Array>(); readonly values = new Map<string, unknown>();
  write(port: string, bytes: Uint8Array, limits: Limits): OutputArtifact { if (bytes.byteLength > limits.maxChunkBytes) throw new Error("output chunk exceeds limit"); if (bytes.byteLength > limits.maxOutputBytes) throw new Error("output exceeds limit"); const contentHash = createHash("sha256").update(bytes).digest("hex"); const artifact = { handle: `memory:${port}`, byteLength: bytes.byteLength, contentHash }; this.bytes.set(port, bytes.slice()); this.artifacts.set(port, artifact); return artifact; }
  value(port: string, value: unknown): void { this.values.set(port, value); }
}
export class FixedClock implements Clock { readonly value: string; constructor(value: string) { this.value = value; } now(): string { return this.value; } }
export class CancellationToken implements Cancellation { private cancelled = false; cancel(): void { this.cancelled = true; } isCancelled(): boolean { return this.cancelled; } }
export class SeededRandom implements Randomness { private state: number; readonly id: string; constructor(seed: number) { this.state = seed >>> 0; this.id = `seed:${seed}`; } fill(bytes: Uint8Array): void { for (let i = 0; i < bytes.length; i++) { this.state ^= this.state << 13; this.state ^= this.state >>> 17; this.state ^= this.state << 5; bytes[i] = this.state & 255; } } }
export class MemorySecrets implements SecretStore { readonly values = new Map<string, Uint8Array>(); insert(handle: string, value: Uint8Array | string): this { this.values.set(handle, typeof value === "string" ? new TextEncoder().encode(value) : value); return this; } resolve(handle: string): Uint8Array { const value = this.values.get(handle); if (!value) throw new Error(`secret handle ${handle} is unavailable`); return value.slice(); } }
