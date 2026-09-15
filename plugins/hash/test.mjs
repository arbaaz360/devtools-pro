import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorCancelled, ProcessorContext, SeededRandom } from "../../packages/plugin-sdk/src/context.ts";
import { execute } from "./processor.mjs";

const ids = ["md5", "sha1", "sha224", "sha256", "sha384", "sha512"];
const vectors = JSON.parse(await readFile(new URL("./fixtures/vectors.json", import.meta.url), "utf8"));

async function run(input, options = {}, reader = null, cancellation = new CancellationToken(), limits = undefined) {
  const outputs = new MemoryOutputSink();
  const source = reader ?? new MemoryReader().insert("input", input);
  const context = new ProcessorContext(source, outputs, cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), limits);
  const result = await execute({ options }, context);
  return { outputs, result };
}

for (const vector of vectors) {
  const { outputs, result } = await run(vector.input);
  for (const id of ids) {
    assert.equal(outputs.values.get(id).digest, vector.digests[id], vector.name + ":" + id);
    assert.equal(new TextDecoder().decode(outputs.bytes.get(id)), vector.digests[id]);
    assert.equal(outputs.values.get(id).complete, true);
    assert.equal(outputs.values.get(id).inputBytes, new TextEncoder().encode(vector.input).byteLength);
    assert.equal(result[id].digest, vector.digests[id]);
  }
}

const upper = await run("abc", { case: "upper" });
assert.equal(upper.outputs.values.get("sha256").digest, vectors[1].digests.sha256.toUpperCase());
assert.equal(new TextDecoder().decode(upper.outputs.bytes.get("sha256")), vectors[1].digests.sha256.toUpperCase());
await assert.rejects(() => run("abc", { case: "mixed" }), /case must be lower or upper/);

const crlf = await run(new Uint8Array([65, 13, 10, 66]));
assert.equal(crlf.outputs.values.get("md5").inputBytes, 4);
assert.equal(crlf.outputs.values.get("md5").digest, "2f55aade65656fbcf1942ab77dce28c5");

class CancellingReader {
  constructor(bytes, cancellation) { this.bytes = bytes; this.cancellation = cancellation; }
  size() { return this.bytes.byteLength; }
  readRange(_port, offset, maxBytes) {
    const chunk = this.bytes.slice(offset, offset + Math.min(maxBytes, 4));
    if (offset === 0) this.cancellation.cancel();
    return chunk;
  }
}
const cancellation = new CancellationToken();
await assert.rejects(() => run(new Uint8Array(32), {}, new CancellingReader(new Uint8Array(32), cancellation), cancellation), ProcessorCancelled);

const tooLarge = { size: () => 17, readRange: () => new Uint8Array() };
await assert.rejects(() => run("", {}, tooLarge, new CancellationToken(), { maxInputBytes: 16, maxOutputBytes: 1024, maxChunkBytes: 1024, deadlineMs: 0 }), /exceeds limit/);
console.log("hash package tests passed");
