import test from "node:test";
import assert from "node:assert/strict";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorCancelled, ProcessorContext, SeededRandom, defaultLimits } from "./context.ts";
test("processor context is named, bounded, cancellable and deterministic", async () => { const reader = new MemoryReader().insert("input", "hello"); const sink = new MemoryOutputSink(); const cancel = new CancellationToken(); const random = new SeededRandom(7); const ctx = new ProcessorContext(reader, sink, cancel, new FixedClock("2025-01-01T00:00:00Z"), random, new MemorySecrets().insert("secret:1", "key"), { ...defaultLimits(), maxOutputBytes: 5 }); assert.equal(new TextDecoder().decode(await ctx.read("input")), "hello"); assert.equal(new TextDecoder().decode(await ctx.secret("secret:1")), "key"); assert.equal((await ctx.write("output", new TextEncoder().encode("hello"))).handle, "memory:output"); const first = new Uint8Array(3); random.fill(first); const second = new SeededRandom(7); const repeat = new Uint8Array(3); second.fill(repeat); assert.deepEqual(first, repeat); cancel.cancel(); await assert.rejects(() => ctx.read("input"), ProcessorCancelled); });

test("streaming reads use bounded ranges and observe cancellation between chunks", async () => {
  const reader = new MemoryReader().insert("input", "abcdefghij");
  const cancel = new CancellationToken();
  const ctx = new ProcessorContext(reader, new MemoryOutputSink(), cancel, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), { ...defaultLimits(), maxChunkBytes: 3 });
  const chunks: string[] = [];
  await assert.rejects(async () => {
    for await (const chunk of ctx.readChunks("input")) {
      chunks.push(new TextDecoder().decode(chunk));
      if (chunks.length === 2) cancel.cancel();
    }
  }, ProcessorCancelled);
  assert.deepEqual(chunks, ["abc", "def"]);
});

test("streaming reads reject inputs larger than the declared limit before allocation", async () => {
  const reader = new MemoryReader().insert("input", "0123456789");
  const ctx = new ProcessorContext(reader, new MemoryOutputSink(), new CancellationToken(), new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), { ...defaultLimits(), maxInputBytes: 5, maxChunkBytes: 2 });
  await assert.rejects(async () => { for await (const _chunk of ctx.readChunks("input")) { /* consume */ } }, /exceeds limit/);
});

test("named input reads reject unsupplied ports explicitly", async () => {
  const reader = new MemoryReader();
  const ctx = new ProcessorContext(reader, new MemoryOutputSink(), new CancellationToken(), new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets());
  await assert.rejects(() => ctx.read("missing"), /named input missing was not supplied/);
});

test("memory output sink accumulates chunks written to one port", async () => {
  const sink = new MemoryOutputSink();
  const limits = { ...defaultLimits(), maxChunkBytes: 4, maxOutputBytes: 7 };
  await sink.write("output", new TextEncoder().encode("abcd"), limits);
  const artifact = await sink.write("output", new TextEncoder().encode("efg"), limits);
  assert.equal(new TextDecoder().decode(sink.bytes.get("output")), "abcdefg");
  assert.equal(artifact.byteLength, 7);
  await assert.rejects(() => sink.write("output", new TextEncoder().encode("h"), limits), /output exceeds limit/);
  await assert.rejects(() => sink.write("other", new TextEncoder().encode("abcde"), limits), /output chunk exceeds limit/);
});
