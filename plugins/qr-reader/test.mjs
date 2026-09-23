import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import {
  CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorContext, SeededRandom,
} from "../../packages/plugin-sdk/src/context.ts";
import { qrcode } from "../../packages/vendor/qrcode-generator/qrcode.mjs";
import { QrReaderError, execute, OPERATION_ID, normalizeOptions } from "./processor.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const readFixture = async (file) => JSON.parse(await readFile(new URL(`./fixtures/${file}`, import.meta.url), "utf8"));

function expandToPixels({ width, height, scale, modules }) {
  const rows = modules.length;
  const cols = modules[0].length;
  assert.equal(rows * scale, height, "fixture height must equal the module row count times scale");
  assert.equal(cols * scale, width, "fixture width must equal the module column count times scale");
  const pixels = new Uint8Array(width * height * 4);
  for (let moduleY = 0; moduleY < rows; moduleY++) {
    for (let moduleX = 0; moduleX < cols; moduleX++) {
      const dark = modules[moduleY][moduleX] === "1";
      const value = dark ? 0 : 255;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = moduleX * scale + dx;
          const py = moduleY * scale + dy;
          const idx = (py * width + px) * 4;
          pixels[idx] = value; pixels[idx + 1] = value; pixels[idx + 2] = value; pixels[idx + 3] = 255;
        }
      }
    }
  }
  return pixels;
}

function padModules(modules, top, right, bottom, left) {
  const cols = modules[0].length + left + right;
  const out = [];
  for (let i = 0; i < top; i++) out.push("0".repeat(cols));
  for (const row of modules) out.push("0".repeat(left) + row + "0".repeat(right));
  for (let i = 0; i < bottom; i++) out.push("0".repeat(cols));
  return out;
}

/**
 * The vendored encoder's byte-mode path truncates each JS string character to its low byte
 * instead of doing real UTF-8 (packages/vendor/qrcode-generator/qrcode.mjs:737-742), so it
 * corrupts non-ASCII text. Converting to UTF-8 bytes first, one character per byte, makes
 * that truncation a no-op and lets the encoder carry arbitrary Unicode text correctly.
 */
function utf8ByteString(text) {
  return Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join("");
}

/** The oracle: encodes text with the vendored qrcode-generator and reads back its module matrix. */
function encodeModules(text, errorCorrection = "M") {
  const qr = qrcode(0, errorCorrection);
  qr.addData(utf8ByteString(text), "Byte");
  qr.make();
  const count = qr.getModuleCount();
  const rows = [];
  for (let row = 0; row < count; row++) {
    let line = "";
    for (let col = 0; col < count; col++) line += qr.isDark(row, col) ? "1" : "0";
    rows.push(line);
  }
  return rows;
}

async function run(options, image, { cancellation = new CancellationToken(), limits } = {}) {
  const pixels = expandToPixels(image);
  const reader = new MemoryReader().insertImage("input", pixels, image.width, image.height, "image/png");
  const before = reader.inputs.get("input").slice();
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(reader, outputs, cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), limits);
  const result = await execute({ pluginId: OPERATION_ID, toolId: OPERATION_ID, operationId: OPERATION_ID, options }, context);
  assert.deepEqual(reader.inputs.get("input"), before, "source pixels must be untouched");
  const bytes = outputs.bytes.get("output");
  return { result, value: outputs.values.get("output"), bytes, text: bytes ? decoder.decode(bytes) : undefined };
}

async function rejects(options, image, code) {
  const pixels = expandToPixels(image);
  const reader = new MemoryReader().insertImage("input", pixels, image.width, image.height, "image/png");
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(reader, outputs, new CancellationToken(), new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets());
  let caught;
  try {
    await execute({ operationId: OPERATION_ID, options }, context);
  } catch (error) { caught = error; }
  assert.ok(caught, `expected ${code}`);
  assert.ok(caught instanceof QrReaderError, `expected QrReaderError, got ${caught?.name}: ${caught?.message}`);
  assert.equal(caught.code, code, caught.message);
  assert.equal(outputs.bytes.size, 0, "no output bytes may be written on failure");
  assert.equal(outputs.values.size, 0, "no output value may be written on failure");
  return caught;
}

test("fixtures decode, or fail, exactly as the vendored encoder's input predicts", async () => {
  const files = (await readdir(new URL("./fixtures", import.meta.url))).filter((file) => file.endsWith(".json"));
  assert.ok(files.length >= 12, `expected at least 12 fixtures, found ${files.length}`);
  for (const file of files) {
    const item = await readFixture(file);
    if (item.error) {
      await rejects(item.options, item.image, item.error);
      continue;
    }
    const { value, text } = await run(item.options, item.image);
    assert.equal(text, item.output.text, `fixture ${item.name} decoded output bytes mismatch`);
    assert.equal(value.text, item.output.text, `fixture ${item.name} properties.text mismatch`);
    assert.equal(value.bytes, encoder.encode(item.output.text).byteLength, `fixture ${item.name} properties.bytes mismatch`);
    assert.equal(value.imageWidth, item.image.width, `fixture ${item.name} properties.imageWidth mismatch`);
    assert.equal(value.imageHeight, item.image.height, `fixture ${item.name} properties.imageHeight mismatch`);
    assert.ok(Number.isInteger(value.version) && value.version >= 1 && value.version <= 40, `fixture ${item.name} properties.version out of range`);
    for (const corner of ["topLeft", "topRight", "bottomLeft", "bottomRight"]) {
      assert.ok(Number.isInteger(value.location[corner].x), `fixture ${item.name} location.${corner}.x must be an integer`);
      assert.ok(Number.isInteger(value.location[corner].y), `fixture ${item.name} location.${corner}.y must be an integer`);
    }
  }
});

test("live round trip for the DU-21 sample: the encoder is the oracle, not a recorded expectation", async () => {
  const text = "https://example.com";
  const modules = padModules(encodeModules(text, "M"), 4, 4, 4, 4);
  const scale = 4;
  const image = { width: modules[0].length * scale, height: modules.length * scale, scale, modules };

  const { text: decodedText, value } = await run({}, image);
  assert.equal(decodedText, text, "decoding the encoder's own output must return the text that was encoded");
  assert.equal(value.text, text);
});

test("options: unknown keys and wrong types are rejected", () => {
  const rejectsOption = (raw) => assert.throws(() => normalizeOptions(raw), (error) => error instanceof QrReaderError && error.code === "qr.invalid-option");
  rejectsOption({ unknown: true });
  rejectsOption({ invert: "yes" });
  rejectsOption({ "try-harder": 1 });
  rejectsOption([true]);
  rejectsOption("nope");
});

test("options: defaults and camelCase aliases", () => {
  assert.deepEqual(normalizeOptions(undefined), { invert: false, tryHarder: true });
  assert.deepEqual(normalizeOptions({}), { invert: false, tryHarder: true });
  assert.deepEqual(normalizeOptions({ invert: true, tryHarder: false }), { invert: true, tryHarder: false });
  assert.deepEqual(normalizeOptions({ invert: true, "try-harder": false }), { invert: true, tryHarder: false });
});

test("qr.not-an-image when the port is not an image", async () => {
  const reader = new MemoryReader().insert("input", "not an image", { contentKind: "text" });
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(reader, outputs, new CancellationToken(), new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets());
  let caught;
  try { await execute({ operationId: OPERATION_ID, options: {} }, context); } catch (error) { caught = error; }
  assert.ok(caught instanceof QrReaderError);
  assert.equal(caught.code, "qr.not-an-image");
});

test("qr.not-an-image when width/height are missing", async () => {
  const reader = new MemoryReader().insert("input", new Uint8Array(16), { contentKind: "image", mime: "image/png" });
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(reader, outputs, new CancellationToken(), new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets());
  let caught;
  try { await execute({ operationId: OPERATION_ID, options: {} }, context); } catch (error) { caught = error; }
  assert.ok(caught instanceof QrReaderError);
  assert.equal(caught.code, "qr.not-an-image");
});

test("qr.not-an-image when the pixel buffer does not match width * height * 4", async () => {
  const reader = new MemoryReader().insertImage("input", new Uint8Array(10), 4, 4);
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(reader, outputs, new CancellationToken(), new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets());
  let caught;
  try { await execute({ operationId: OPERATION_ID, options: {} }, context); } catch (error) { caught = error; }
  assert.ok(caught instanceof QrReaderError);
  assert.equal(caught.code, "qr.not-an-image");
});

test("cooperative cancellation before the decode starts", async () => {
  const cancellation = new CancellationToken();
  cancellation.cancel();
  const reader = new MemoryReader().insertImage("input", new Uint8Array(4 * 4 * 4).fill(255), 4, 4);
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(reader, outputs, cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets());
  try {
    await execute({ operationId: OPERATION_ID, options: {} }, context);
    assert.fail("should have been cancelled");
  } catch (error) {
    assert.equal(error.name, "ProcessorCancelled");
  }
  assert.equal(outputs.bytes.size, 0);
});

test("cooperative cancellation between reading the image and decoding it", async () => {
  const cancellation = new CancellationToken();
  const modules = padModules(encodeModules("cancel between read and decode", "M"), 4, 4, 4, 4);
  const scale = 4;
  const width = modules[0].length * scale;
  const height = modules.length * scale;
  const pixels = expandToPixels({ width, height, scale, modules });
  const reader = {
    info: () => ({ contentKind: "image", width, height }),
    read: () => { cancellation.cancel(); return pixels; },
  };
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(reader, outputs, cancellation, new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets());
  try {
    await execute({ operationId: OPERATION_ID, options: {} }, context);
    assert.fail("should have been cancelled");
  } catch (error) {
    assert.equal(error.name, "ProcessorCancelled");
  }
  assert.equal(outputs.bytes.size, 0, "no output may be written once cancelled");
});

test("determinism", async () => {
  const item = await readFixture("du21-sample-example-com.json");
  const first = await run(item.options, item.image);
  const second = await run(item.options, item.image);
  assert.deepEqual(first.bytes, second.bytes, "two runs must produce byte-identical output");
  assert.deepEqual(first.value, second.value, "two runs must produce identical properties");
});
