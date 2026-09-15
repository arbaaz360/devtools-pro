import assert from "node:assert/strict";
import { execute } from "./processor.mjs";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorContext, SeededRandom } from "../../packages/plugin-sdk/src/context.ts";
const run = async (request, input) => { const reader = new MemoryReader(); if (input) reader.insert("uuid", input); const outputs = new MemoryOutputSink(); const context = new ProcessorContext(reader, outputs, new CancellationToken(), new FixedClock("2025-01-01T00:00:00.000Z"), new SeededRandom(42), new MemorySecrets()); await execute(request, context); return { outputs, text: new TextDecoder().decode(outputs.bytes.get("uuid")) }; };
const v4 = await run({ options: { version: "v4", count: 3 } }); assert.equal(v4.text.trim().split("\n").length, 3); assert.match(v4.text, /^[0-9a-f-]+\n/);
const v5 = await run({ options: { version: "v5", namespace: "dns", name: "example.com", count: 2 } }); assert.equal(v5.text.trim().split("\n")[0], "cfbff0d1-9375-5685-968c-48ce8b15ae17"); assert.equal(v5.text.trim().split("\n")[0], v5.text.trim().split("\n")[1]);
const decoded = await run({ options: { mode: "decode" } }, "550e8400-e29b-41d4-a716-446655440000"); assert.equal(decoded.outputs.values.get("uuid").version, 4); assert.equal(decoded.outputs.values.get("uuid").variant, "RFC 4122");
await assert.rejects(() => run({ options: { version: "5", namespace: "dns" } }), /name is required/);
console.log("uuid package tests passed");
