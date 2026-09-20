import { CancellationToken, ProcessorContext, MemoryOutputSink, FixedClock, SeededRandom, MemorySecrets } from "../../packages/plugin-sdk/src/context.ts";
import { execute } from "./processor.mjs";

class ChunkedReader {
  constructor(bytes, chunk, { cancellation, withSize = true } = {}) { this.bytes = bytes; this.chunk = chunk; this.cancellation = cancellation; this.calls = 0; if (!withSize) this.size = undefined; }
  read() { throw new Error("streaming processors must not read the whole input"); }
  size() { return this.bytes.byteLength; }
  readRange(_port, offset, maxBytes) {
    this.calls += 1;
    console.log("readRange called with offset", offset, "maxBytes", maxBytes);
    if (this.cancellation && offset > 0) {
        console.log("Cancelling!");
        this.cancellation.cancel();
    }
    return this.bytes.slice(offset, offset + Math.min(maxBytes, this.chunk));
  }
}

async function runTest() {
  const encoder = new TextEncoder();
  const cancellation = new CancellationToken();
  const bytes = encoder.encode("a".repeat(100_000));
  const reader = new ChunkedReader(bytes, 65536, { cancellation });
  const context = new ProcessorContext(reader, new MemoryOutputSink(), cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), { maxInputBytes: 1048576, maxOutputBytes: 1048576 });
  
  try {
    await execute({ options: { target: "camel" } }, context);
    console.log("Finished successfully - this is wrong!");
  } catch (e) {
    console.log("Rejected with", e);
  }
}

runTest();
