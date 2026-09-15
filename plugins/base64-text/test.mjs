import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorContext, SeededRandom } from "../../packages/plugin-sdk/src/context.ts";
import { execute } from "./processor.mjs";

async function run(options, input) {
  const outputs = new MemoryOutputSink();
  const ctx = new ProcessorContext(new MemoryReader().insert("input", input), outputs, new CancellationToken(), new FixedClock("2025-01-01T00:00:00Z"), new SeededRandom(1), new MemorySecrets());
  await execute({ options }, ctx);
  return { text: new TextDecoder().decode(outputs.bytes.get("output")), value: outputs.values.get("output") };
}

const vectors = JSON.parse(await readFile(new URL("./fixtures/roundtrip.json", import.meta.url), "utf8"));
for (const vector of vectors) {
  const encoded = await run({ mode: "encode", variant: "standard", padding: "required" }, vector.input);
  assert.equal(encoded.text, vector.encoded, vector.name);
  const decoded = await run({ mode: "decode", variant: "standard", padding: "required" }, vector.encoded);
  assert.equal(decoded.text, vector.input, vector.name);
  assert.equal(decoded.value.complete, true);
}
assert.equal((await run({ mode: "encode", variant: "url", padding: "omit" }, "?f" )).text, "P2Y");
assert.equal((await run({ mode: "decode", variant: "url", padding: "omit" }, "P2Y")).text, "?f");
assert.equal((await run({ mode: "decode", variant: "standard", padding: "optional", errorPolicy: "tolerant" }, " SGVsbG8=\n")).text, "Hello");
await assert.rejects(() => run({ mode: "decode", variant: "standard", padding: "required" }, "SGVsbG8"), /padding is required/);
await assert.rejects(() => run({ mode: "decode", variant: "standard", padding: "required" }, "SGVsbG8$="), /invalid Base64 character/);
await assert.rejects(() => run({ mode: "decode", variant: "standard", padding: "required" }, "//=="), /trailing bits/);
console.log("base64-text package tests passed");
