import fs from 'fs';
import crypto from 'crypto';
import { execute, OPERATION_ID } from '../processor.mjs';
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorContext, SeededRandom } from "../../../packages/plugin-sdk/src/context.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

async function run(options, input, limits) {
  const source = new MemoryReader().insert("input", encoder.encode(input));
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(source, outputs, new CancellationToken(), new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets(), limits);
  try {
    await execute({ pluginId: OPERATION_ID, toolId: OPERATION_ID, operationId: OPERATION_ID, options }, context);
    const bytes = outputs.bytes.get("output");
    return { output: decoder.decode(bytes), properties: outputs.values.get("output") };
  } catch (e) {
    return { error: e.code, message: e.message };
  }
}

const TESTS = [
  { desc: "https://example.com default", in: "https://example.com", opts: {} },

  // 2953 fits, 2954 fails (version 40, L capacity)
  { desc: "2953 bytes level L fits", in: "A".repeat(2953), opts: { "error-correction": "L" } },
  { desc: "2954 bytes level L fails", in: "A".repeat(2954), opts: { "error-correction": "L" }, err: "qr.capacity" },

  // each error level
  { desc: "error level L", in: "hello", opts: { "error-correction": "L" } },
  { desc: "error level M", in: "hello", opts: { "error-correction": "M" } },
  { desc: "error level Q", in: "hello", opts: { "error-correction": "Q" } },
  { desc: "error level H", in: "hello", opts: { "error-correction": "H" } },

  // cell sizes
  { desc: "cell size 1", in: "hello", opts: { "cell-size": 1 } },
  { desc: "cell size 40", in: "hello", opts: { "cell-size": 40 } },

  // margin
  { desc: "margin 0", in: "hello", opts: { "margin": 0 } },
  { desc: "margin 16", in: "hello", opts: { "margin": 16 } },

  // explicit versions
  { desc: "explicit version 1", in: "hello", opts: { "version": 1 } },
  { desc: "explicit version 40", in: "hello", opts: { "version": 40 } },

  // special chars
  { desc: "UTF-8 astral characters", in: "hello 🌍🚀", opts: {} },
  { desc: "newline containing input", in: "hello\nworld", opts: {} },

  // rejections
  { desc: "empty input rejected", in: "", opts: {}, err: "qr.empty" },
  { desc: "version 1 too large rejected", in: "A".repeat(100), opts: { "version": 1 }, err: "qr.capacity" },

  // additional tests to reach 25
  { desc: "alias errorCorrection", in: "test", opts: { errorCorrection: "Q" } },
  { desc: "alias cellSize", in: "test", opts: { cellSize: 15 } },
  { desc: "unknown option", in: "test", opts: { unknown: 1 }, err: "qr.invalid-option" },
  { desc: "wrong error-correction", in: "test", opts: { "error-correction": "X" }, err: "qr.invalid-option" },
  { desc: "wrong cell-size", in: "test", opts: { "cell-size": 0 }, err: "qr.invalid-option" },
  { desc: "wrong margin", in: "test", opts: { "margin": -1 }, err: "qr.invalid-option" },
  { desc: "wrong version", in: "test", opts: { "version": 41 }, err: "qr.invalid-option" },
  { desc: "normal input 1", in: "12345", opts: {} },
  { desc: "normal input 2", in: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", opts: { "error-correction": "H" } },
  { desc: "normal input 3", in: "https://example.org/?query=1", opts: { "error-correction": "Q" } }
];

async function generate() {
  for (const test of TESTS) {
    const id = `DU-21-${crypto.createHash("md5").update(test.desc).digest("hex").slice(0, 8)}`;
    const fixture = {
      id,
      operationId: OPERATION_ID,
      options: test.opts,
      input: { "input": test.in }
    };

    const limits = test.limits || { maxInputBytes: 4096, maxOutputBytes: 4 * 1024 * 1024, maxChunkBytes: 65536, deadlineMs: 0 };
    const res = await run(test.opts, test.in, limits);

    if (test.err) {
      if (res.error !== test.err) {
        console.error(`Test ${test.desc} expected error ${test.err} but got ${res.error}: ${res.message}`);
        process.exit(1);
      }
      fixture.error = test.err;
    } else {
      if (res.error) {
        console.error(`Test ${test.desc} failed unexpectedly: ${res.error} ${res.message}`);
        process.exit(1);
      }
      if (!res.output) {
        console.error(`res.output is undefined for test ${test.desc}`);
      }
      fixture.output = { "output": res.output };
      fixture.properties = res.properties;
    }

    fs.writeFileSync(`plugins/qr/fixtures/${id}.json`, JSON.stringify(fixture, null, 2));
  }
  console.log("Fixtures generated successfully.");
}

generate().catch(console.error);
