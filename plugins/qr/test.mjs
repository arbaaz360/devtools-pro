import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import {
  CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorCancelled, ProcessorContext, SeededRandom,
} from "../../packages/plugin-sdk/src/context.ts";
import jsQR from "../../packages/vendor/jsqr/jsqr.mjs";
import { QrError, execute, OPERATION_ID } from "./processor.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const readFixture = async (file) => JSON.parse(await readFile(new URL(`./fixtures/${file}`, import.meta.url), "utf8"));

async function run(operationId, options, input, { reader, cancellation = new CancellationToken(), limits } = {}) {
  const source = reader ?? new MemoryReader().insert("input", encoder.encode(input));
  const before = source instanceof MemoryReader ? source.inputs.get("input").slice() : null;
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(source, outputs, cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), limits);
  const result = await execute({ pluginId: OPERATION_ID, toolId: OPERATION_ID, operationId, options }, context);
  if (before) assert.deepEqual(source.inputs.get("input"), before, "source bytes must be untouched");
  const bytes = outputs.bytes.get("output");
  return { result, value: outputs.values.get("output"), bytes, text: bytes ? decoder.decode(bytes) : undefined, outputs };
}

async function rejects(operationId, options, input, code, extra = {}) {
  const outputs = { written: false };
  let caught;
  try {
    const sink = new MemoryOutputSink();
    const context = new ProcessorContext(new MemoryReader().insert("input", encoder.encode(input)), sink, new CancellationToken(), new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), extra.limits);
    await execute({ operationId, options }, context);
    outputs.written = sink.bytes.size > 0 || sink.values.size > 0;
  } catch (error) { caught = error; }
  assert.ok(caught, `expected ${code} for ${JSON.stringify(input)}`);
  assert.ok(caught instanceof QrError, `expected QrError, got ${caught?.name}: ${caught?.message}`);
  assert.equal(caught.code, code, caught.message);
  assert.equal(outputs.written, false, "no output may be written on failure");
  return caught;
}

test("fixtures produce the expected SVG output or error", async () => {
  const files = await readdir(new URL("./fixtures", import.meta.url));
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const item = await readFixture(file);
    if (item.error) {
      await rejects(item.operationId, item.options, item.input.input, item.error);
    } else {
      const result = await run(item.operationId, item.options, item.input.input);
      assert.equal(result.text, item.output.output, `fixture ${item.id} output SVG mismatch`);
      assert.ok(result.text.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), `fixture ${item.id} output must start with XML declaration`);
      assert.ok(result.text.trim().endsWith("</svg>"), `fixture ${item.id} output must end with </svg>`);
      const byteLength = encoder.encode(result.text).byteLength;
      if (item.properties) {
        assert.equal(byteLength, item.properties.bytes, `fixture ${item.id} UTF-8 length must equal properties.bytes`);
        for (const [key, value] of Object.entries(item.properties)) {
          assert.deepEqual(result.value[key], value, `fixture ${item.id} property ${key} mismatch`);
        }
      }
    }
  }
});

/**
 * Rasterizes the dark modules drawn in a generated SVG's `<path>` into an RGBA pixel
 * buffer, the same layout plugins/qr-reader/test.mjs builds from a module matrix — except
 * these squares are parsed out of the actual SVG the processor produced, not recomputed
 * independently, so this decodes the real generator output rather than a re-encoding of it.
 */
function svgToPixels(svg, size) {
  const pixels = new Uint8Array(size * size * 4).fill(255);
  const rectRe = /M(\d+),(\d+)l(\d+),0/g;
  let match;
  while ((match = rectRe.exec(svg))) {
    const x0 = Number(match[1]);
    const y0 = Number(match[2]);
    const cell = Number(match[3]);
    for (let dy = 0; dy < cell; dy++) {
      for (let dx = 0; dx < cell; dx++) {
        const idx = ((y0 + dy) * size + (x0 + dx)) * 4;
        pixels[idx] = 0; pixels[idx + 1] = 0; pixels[idx + 2] = 0; pixels[idx + 3] = 255;
      }
    }
  }
  return pixels;
}

async function assertDecodesTo(text, options = {}) {
  const { result, text: svg } = await run(OPERATION_ID, options, text);
  const pixels = svgToPixels(svg, result.widthPx);
  const decoded = jsQR(pixels, result.widthPx, result.widthPx, { inversionAttempts: "dontInvert" });
  assert.ok(decoded, `expected an independently decodable QR code for ${JSON.stringify(text)}`);
  assert.equal(decoded.data, text, `decoded text must equal the input for ${JSON.stringify(text)}`);
  return result;
}

test("UTF-8 round trip, verified by independently decoding the generated SVG with jsQR", async () => {
  await assertDecodesTo("https://example.com");
  await assertDecodesTo("café");
  await assertDecodesTo("日本語のテキスト");
  await assertDecodesTo("family: 👨‍👩‍👧‍👦"); // emoji built from a zero-width joiner sequence
  await assertDecodesTo("mixed scripts: Hello Привет 你好 مرحبا"); // Latin, Cyrillic, Han, Arabic in one string
});

test("2,953 UTF-8 bytes fits at level L and decodes back to the same text; 2,954 does not fit", async () => {
  const fits = "a".repeat(2953);
  const result = await assertDecodesTo(fits, { "error-correction": "L" });
  assert.equal(result.inputBytes, 2953);

  await rejects(OPERATION_ID, { "error-correction": "L" }, "a".repeat(2954), "qr.capacity");
});

class ChunkedReader {
  constructor(bytes, chunk, { cancellation, withSize = true } = {}) { this.bytes = bytes; this.chunk = chunk; this.cancellation = cancellation; this.calls = 0; if (!withSize) this.size = undefined; }
  read() { throw new Error("streaming processors must not read the whole input"); }
  size() { return this.bytes.byteLength; }
  readRange(_port, offset, maxBytes) {
    this.calls += 1;
    if (this.cancellation && offset > 0) this.cancellation.cancel();
    return this.bytes.slice(offset, offset + Math.min(maxBytes, this.chunk));
  }
}

test("cooperative cancellation", async () => {
  const cancellation = new CancellationToken();
  const bytes = encoder.encode("a".repeat(1000));
  const reader = new ChunkedReader(bytes, 500, { cancellation });
  const context = new ProcessorContext(reader, new MemoryOutputSink(), cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets());
  try {
    await execute({ operationId: OPERATION_ID, options: {} }, context);
    assert.fail("should have rejected");
  } catch (err) {
    if (err.name !== 'ProcessorCancelled') {
      assert.fail(`rejected with wrong error: ${err.name} ${err.message}`);
    }
  }
});

test("options validation", async () => {
  // outside ranges
  await rejects(OPERATION_ID, { "error-correction": "Z" }, "hello", "qr.invalid-option");
  await rejects(OPERATION_ID, { "cell-size": 0 }, "hello", "qr.invalid-option");
  await rejects(OPERATION_ID, { "cell-size": 41 }, "hello", "qr.invalid-option");
  await rejects(OPERATION_ID, { margin: -1 }, "hello", "qr.invalid-option");
  await rejects(OPERATION_ID, { margin: 17 }, "hello", "qr.invalid-option");
  await rejects(OPERATION_ID, { version: -1 }, "hello", "qr.invalid-option");
  await rejects(OPERATION_ID, { version: 41 }, "hello", "qr.invalid-option");

  // unknown keys
  await rejects(OPERATION_ID, { unknown: true }, "hello", "qr.invalid-option");
});

test("camelCase aliases accepted", async () => {
  const result = await run(OPERATION_ID, { errorCorrection: "H", cellSize: 10 }, "hello");
  assert.equal(result.value.errorCorrection, "H");
  assert.equal(result.value.cellSize, 10);
});

test("determinism", async () => {
  const result1 = await run(OPERATION_ID, { version: 5 }, "hello");
  const result2 = await run(OPERATION_ID, { version: 5 }, "hello");
  assert.deepEqual(result1.bytes, result2.bytes, "two runs must produce byte-identical SVG");
});
