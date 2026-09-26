import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorCancelled, ProcessorContext, SeededRandom, defaultLimits
} from "../../packages/plugin-sdk/src/index.ts";
import { HexError, execute } from "./processor.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder("latin1"); // to properly load bytes from json strings

const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

/** Run the processor through the public SDK context only. */
async function run(options, input, { reader, cancellation = new CancellationToken(), limits } = {}) {
  const source = reader ?? new MemoryReader().insert("input", input);
  const before = source instanceof MemoryReader ? source.inputs.get("input").slice() : null;
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(source, outputs, cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), limits || defaultLimits);
  const request = { pluginId: "encoding.hex", toolId: "encoding.hex", operationId: "encoding.hex", options };
  let result, error;
  try {
    result = await execute(request, context);
  } catch (caught) {
    error = caught;
  }
  if (before) assert.deepEqual(source.inputs.get("input"), before, "source bytes must remain strictly untouched");
  return { outputs, result, error };
}

test("Fixtures", async (t) => {
  const tests = await fixture("test");
  for (const item of tests) {
    await t.test(item.name, async () => {
      const inputBytes = new Uint8Array(item.input.split("").map(c => c.charCodeAt(0)));
      const { result, outputs, error } = await run(item.options, inputBytes);
      
      if (item.error) {
        assert.ok(error, "expected an error but got success");
        assert.ok(error instanceof HexError, "expected a HexError");
        assert.equal(error.code, item.error.code);
        if (item.error.offset !== undefined) {
          assert.equal(error.diagnostic.offset, item.error.offset);
        }
      } else {
        if (error) throw error;
        const expectedBytes = new Uint8Array(item.output.split("").map(c => c.charCodeAt(0)));
        const outputBytes = outputs.bytes.get("output");
        assert.deepEqual(outputBytes, expectedBytes);
        assert.deepEqual(result.complete, true);
        
        if (item.options.mode === "decode") {
          // Verify labelling for non-utf8
          if (item.name === "decode non-utf8") {
            assert.equal(result.utf8, false);
            assert.equal(result.contentKind, "binary");
          }
        }
      }
    });
  }
});

test("Options: unknown options and wrong types", async () => {
  const { error: unknown } = await run({ unknownOption: "yes" }, new Uint8Array());
  assert.equal(unknown.code, "hex.invalid-option");
  assert.equal(unknown.diagnostic.option, "unknownOption");

  const { error: wrongType } = await run({ "bytes-per-line": "hello" }, new Uint8Array());
  assert.equal(wrongType.code, "hex.invalid-option");
  assert.equal(wrongType.diagnostic.option, "bytes-per-line");
});

test("1 MiB round trip inside deadline", async () => {
  // Generate 1 MiB of random data
  const len = 1024 * 1024;
  const input = new Uint8Array(len);
  for (let i = 0; i < len; i++) input[i] = i % 256;
  
  const startEncode = performance.now();
  const encodeRes = await run({ mode: "encode", case: "upper", separator: "none" }, input);
  const encodeTime = performance.now() - startEncode;
  assert.ok(!encodeRes.error, encodeRes.error?.message);
  
  const encodedBytes = encodeRes.outputs.bytes.get("output");
  
  const startDecode = performance.now();
  const decodeRes = await run({ mode: "decode" }, encodedBytes);
  const decodeTime = performance.now() - startDecode;
  assert.ok(!decodeRes.error, decodeRes.error?.message);
  
  const decodedBytes = decodeRes.outputs.bytes.get("output");
  
  assert.deepEqual(decodedBytes, input);
  assert.ok(encodeTime + decodeTime < 1000, "1 MiB roundtrip should complete within deadline (1000ms)");
});

test("Cancellation is checked between chunks", async () => {
  const cancellation = new CancellationToken();
  const reader = {
    async read(port) {
      if (port !== "input") return null;
      cancellation.cancel();
      return new Uint8Array(10);
    }
  };
  const { error } = await run({ mode: "encode" }, null, { reader, cancellation });
  assert.ok(error instanceof ProcessorCancelled);
});

test("Over-limit result fails explicitly", async () => {
  const limits = { ...defaultLimits, maxOutputBytes: 10 };
  const input = new Uint8Array(10); // encode will be 20 bytes
  const { error } = await run({ mode: "encode" }, input, { limits });
  assert.ok(error instanceof HexError, "should be a HexError");
  assert.equal(error.code, "hex.output-limit");
  assert.equal(error.diagnostic.needed, 20);
  assert.equal(error.diagnostic.limit, 10);
});
