import test from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import { execute, LineToolsError } from "./processor.mjs";

const defaultLimits = {
  maxInputBytes: 4194304,
  maxOutputBytes: 4194304,
  maxChunkBytes: 4194304,
  deadlineMs: 2000
};

async function run(options, inputStr, { limits = defaultLimits, cancelFlag = false } = {}) {
  let cancelled = false;
  const context = {
    limits,
    cancellation: {
      isCancelled: () => cancelFlag || cancelled
    },
    read: async () => {
      if (inputStr === null) return null;
      const buf = new TextEncoder().encode(inputStr);
      inputStr = null;
      return buf;
    },
    write: async (port, data) => {},
    writeValue: async (port, value) => {
      context.result = value;
    }
  };

  try {
    const result = await execute({ options }, context);
    return { result };
  } catch (error) {
    return { error };
  }
}

test("Fixtures", async (t) => {
  const json = await fs.readFile(new URL("fixtures/test.json", import.meta.url), "utf-8");
  const fixtures = JSON.parse(json);

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const { result, error } = await run(fixture.options, fixture.input);
      if (error) throw error;
      assert.equal(result.text, fixture.output);
    });
  }
});

test("Options: unknown options and wrong types", async () => {
  let res = await run({ unknown: true }, "a\nb");
  assert.ok(res.error instanceof LineToolsError);
  assert.equal(res.error.code, "lines.invalid-option");

  res = await run({ "ignore-case": "yes" }, "a\nb");
  assert.ok(res.error instanceof LineToolsError);

  res = await run({ compare: "magic" }, "a\nb");
  assert.ok(res.error instanceof LineToolsError);
});

test("Limits: input bytes", async () => {
  const res = await run({ action: "sort" }, "a\nb\nc", { limits: { ...defaultLimits, maxInputBytes: 2 } });
  assert.ok(res.error instanceof LineToolsError);
  assert.equal(res.error.code, "lines.input-limit");
});

test("Limits: output bytes", async () => {
  const res = await run({ action: "sort" }, "a\nb\nc", { limits: { ...defaultLimits, maxOutputBytes: 2 } });
  assert.ok(res.error instanceof LineToolsError);
  assert.equal(res.error.code, "lines.output-limit");
});

test("Performance: 100,000 lines sorted inside the deadline", async () => {
  const lines = Array.from({ length: 100000 }, (_, i) => `line${100000 - i}`);
  const input = lines.join("\n");

  const start = performance.now();
  const { result, error } = await run({ action: "sort", compare: "natural" }, input);
  const end = performance.now();

  if (error) throw error;
  assert.ok(result, "should return a result");
  assert.equal(result.lines, 100000);
  assert.equal(result.linesOut, 100000);
  assert.ok(end - start < 2000, `took ${end - start}ms, limit is 2000ms`);
});

test("Cancellation is checked", async () => {
  const res = await run({ action: "sort" }, "a\nb\nc", { cancelFlag: true });
  assert.equal(res.error.name, "ProcessorCancelled");

  // test cancellation during sort
  const lines = Array.from({ length: 150000 }, (_, i) => `line${(i * 17) % 150000}`);
  const input = lines.join("\n");

  let readOnce = false;
  const context = {
    limits: defaultLimits,
    cancellation: {
      isCancelled: () => readOnce
    },
    read: async () => {
      if (!readOnce) {
        readOnce = true;
        return new TextEncoder().encode(input);
      }
      return null;
    },
    write: async () => {},
    writeValue: async () => {}
  };

  try {
    await execute({ options: { action: "sort", compare: "natural" } }, context);
    assert.fail("Should have cancelled");
  } catch (error) {
    if (error.name === "AssertionError") throw error;
    assert.equal(error.name, "ProcessorCancelled");
  }
});

test("Empty document properties", async () => {
  const { result } = await run({}, "");
  assert.equal(result.lines, 0);
  assert.equal(result.linesOut, 0);
  assert.equal(result.removed, 0);
  assert.equal(result.text, "");

  const { result: resultRm } = await run({ action: "remove-blank" }, "");
  assert.equal(resultRm.lines, 0);
  assert.equal(resultRm.linesOut, 0);
  assert.equal(resultRm.removed, 0);
  assert.equal(resultRm.text, "");
});
