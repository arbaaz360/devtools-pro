import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorCancelled, ProcessorContext, SeededRandom } from "../../packages/plugin-sdk/src/context.ts";
import { execute } from "./processor.mjs";
import { md5 } from "./md5.mjs";

const fixture = async name => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
const GENERATE = "identity.uuid.generate";
const DECODE = "identity.uuid.decode";
const generateOp = manifest.operations.find(item => item.id === GENERATE);
const decodeOp = manifest.operations.find(item => item.id === DECODE);
const generateOption = id => generateOp.options.find(item => item.id === id);
const decodeOption = id => decodeOp.options.find(item => item.id === id);
const CLOCK = "2025-01-01T00:00:00.000Z";
const CANONICAL_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL_UPPER = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const GREGORIAN_OFFSET = 0x01b21dd213814000n;
const text = bytes => new TextDecoder().decode(bytes);
const lines = value => value.slice(0, -1).split("\n");

function harness(operationId, options, { input, seed = 42, clock = CLOCK, cancellation = new CancellationToken(), randomness, limits } = {}) {
  const reader = new MemoryReader();
  if (input !== undefined && input !== null) reader.insert("uuid", input);
  const original = reader.inputs.get("uuid")?.slice();
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(reader, outputs, cancellation, new FixedClock(clock), randomness ?? new SeededRandom(seed), new MemorySecrets(), limits);
  const request = { pluginId: manifest.id, toolId: manifest.tools[0].id, operationId, options };
  return { outputs, reader, original, execute: () => execute(request, context) };
}
async function run(operationId, options, env) {
  const h = harness(operationId, options, env);
  const result = await h.execute();
  const value = h.outputs.values.get("uuid");
  assert.deepEqual(result, value, "execute returns the value written to the uuid port");
  assert.equal(value.complete, true);
  const output = text(h.outputs.bytes.get("uuid"));
  assert.ok(output.endsWith("\n") && !output.endsWith("\n\n"), "text artifact ends with exactly one newline");
  return { ...h, value, text: output, lines: lines(output) };
}
async function rejects(operationId, options, env, pattern) {
  const h = harness(operationId, options, env);
  await assert.rejects(h.execute, pattern);
  assert.equal(h.outputs.bytes.size, 0, "rejected runs write no text artifact");
  assert.equal(h.outputs.values.size, 0, "rejected runs write no value");
  return h;
}

// The bug this package was split to fix: generate must not carry inputChange,
// and must not declare a document input at all, or typing in the editor feeds
// the document to a port only decode should read.
assert.deepEqual(generateOp.trigger.modes, ["explicit", "heldRepeat"], "generate never runs on inputChange");
assert.deepEqual(decodeOp.trigger.modes, ["explicit", "inputChange"], "decode runs live as the document changes");
assert.equal(generateOp.inputs.length, 0, "generate declares no document input");
assert.equal(decodeOp.inputs[0].id, "uuid");
assert.equal(decodeOp.inputs[0].required, true);

// Name-based vectors: DNS, URL, OID, X500 and custom namespaces against published references.
for (const vector of await fixture("vectors")) {
  for (const version of [3, 5]) {
    const expected = vector[`v${version}`];
    const { lines: out, value } = await run(GENERATE, { version: `v${version}`, namespace: vector.namespace, name: vector.input, count: 2 });
    assert.deepEqual(out, [expected, expected], `${vector.name} v${version}`);
    assert.equal(value.version, version);
    assert.equal(value.name, vector.input);
    assert.match(value.namespace, CANONICAL_LOWER);
    assert.equal(value.uuids.length, 2);
    assert.equal(value.uuids[0].version, version);
    assert.equal(value.uuids[0].variant, "RFC 4122");
    assert.equal(value.uuids[0].timestamp, undefined, "name-based UUIDs carry no time fields");
    const other = await run(GENERATE, { version: String(version), namespace: vector.namespace, name: vector.input }, { seed: 7, clock: "2030-06-15T12:00:00Z" });
    assert.equal(other.lines[0], expected, "v3/v5 ignore clock and randomness");
    const upper = await run(GENERATE, { version: `v${version}`, namespace: vector.namespace, name: vector.input, case: "upper" });
    assert.equal(upper.lines[0], expected.toUpperCase());
    assert.equal(upper.value.uuids[0].hexadecimal, expected.replaceAll("-", "").toUpperCase());
    assert.deepEqual(upper.value.uuids[0].bytes, other.value.uuids[0].bytes, "case never changes bytes");
  }
}
const presets = { dns: "6ba7b810-9dad-11d1-80b4-00c04fd430c8", url: "6ba7b811-9dad-11d1-80b4-00c04fd430c8", oid: "6ba7b812-9dad-11d1-80b4-00c04fd430c8", x500: "6ba7b814-9dad-11d1-80b4-00c04fd430c8" };
for (const [preset, uuid] of Object.entries(presets)) {
  const byPreset = await run(GENERATE, { version: "v5", namespace: ` ${preset.toUpperCase()} `, name: "example.com" });
  const byUuid = await run(GENERATE, { version: "v5", namespace: uuid.toUpperCase(), name: "example.com" });
  assert.equal(byPreset.value.namespace, uuid, `${preset} preset resolves to its RFC 4122 namespace UUID`);
  assert.equal(byPreset.lines[0], byUuid.lines[0], `${preset} preset equals the explicit namespace UUID`);
}
const defaultNamespace = await run(GENERATE, { version: "v5", name: "example.com" });
assert.equal(defaultNamespace.value.namespace, presets.dns, "namespace defaults to dns");
assert.equal(defaultNamespace.lines[0], "cfbff0d1-9375-5685-968c-48ce8b15ae17");
const throwingServices = { randomness: { id: "never", fill() { throw new Error("randomness must not be used"); } } };
assert.equal((await run(GENERATE, { version: "v3", name: "www.example.com" }, { ...throwingServices, clock: "not a date" })).lines[0], "5df41881-3aed-3515-88a7-2f4a814cf09e");

// Deterministic v1/v4 vectors from the SDK clock and randomness services.
for (const vector of await fixture("deterministic")) {
  const first = await run(GENERATE, vector.options, { seed: vector.seed, clock: vector.clock });
  const second = await run(GENERATE, vector.options, { seed: vector.seed, clock: vector.clock });
  assert.equal(first.text, vector.text, vector.name);
  assert.equal(second.text, vector.text, `${vector.name} is reproducible`);
  const { uuids, complete, ...summary } = first.value;
  assert.deepEqual(summary, vector.value, `${vector.name} summary`);
  assert.equal(uuids.length, vector.value.count);
  assert.deepEqual(uuids[0], vector.first, `${vector.name} first properties`);
  for (const item of uuids) assert.equal(item.uuid, (await run(DECODE, { case: vector.options.case }, { input: item.uuid })).value.uuid, "decoding a generated value round-trips");
}
{
  // Independent derivation: v4 is sixteen randomness bytes with version and variant bits forced.
  const random = new SeededRandom(42), bytes = new Uint8Array(16);
  random.fill(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const generated = await run(GENERATE, { version: "v4" });
  assert.deepEqual(generated.value.uuids[0].bytes, [...bytes]);
  assert.equal(generated.value.randomness, "seed:42");
  // v1 is the clock in 100-ns Gregorian ticks, then eight randomness bytes: clock sequence (variant forced) and node (multicast forced).
  const ticks = BigInt(Date.parse(CLOCK)) * 10000n + GREGORIAN_OFFSET, tail = new Uint8Array(8);
  new SeededRandom(42).fill(tail);
  const v1 = await run(GENERATE, { version: "v1", count: 3 });
  assert.equal(v1.value.clock, CLOCK);
  assert.equal(v1.value.uuids[0].ticks, ticks.toString());
  assert.equal(v1.value.uuids[0].clockSequence, ((tail[0] & 0x3f) << 8) | tail[1]);
  assert.equal(v1.value.uuids[0].node, [tail[2] | 1, ...tail.slice(3)].map(b => b.toString(16).padStart(2, "0")).join(":"));
  assert.equal(v1.value.uuids[0].multicast, true);
  assert.deepEqual(v1.value.uuids.map(item => item.ticks), [ticks, ticks + 1n, ticks + 2n].map(String), "one batch steps the timestamp by one tick per value");
  assert.equal(new Set(v1.value.uuids.map(item => item.clockSequence + item.node)).size, 1, "one batch shares clock sequence and node");
  assert.equal(new Set(v1.lines).size, 3);
  assert.equal(v1.value.uuids[1].timestamp, "2025-01-01T00:00:00.0000001Z");
  const seeded = await run(GENERATE, { version: "v1" }, { seed: 43 });
  assert.notEqual(seeded.lines[0].slice(19), v1.lines[0].slice(19), "a different seed changes clock sequence and node");
  assert.equal(seeded.lines[0].slice(0, 18), v1.lines[0].slice(0, 18), "the timestamp fields come from the clock alone");
  assert.equal((await run(GENERATE, { version: "v4" }, { clock: "not a date" })).value.uuids[0].version, 4, "v4 ignores the clock");
}
assert.equal((await run(GENERATE, { version: "v1" }, { clock: "1582-10-15T00:00:00.000Z" })).lines[0].slice(0, 19), "00000000-0000-1000-", "earliest Gregorian tick");
assert.equal((await run(GENERATE, { version: "v1" }, { clock: "5236-03-31T21:21:00.684Z" })).value.uuids[0].timestamp, "5236-03-31T21:21:00.6840000Z", "last millisecond inside the 60-bit range");
await rejects(GENERATE, { version: "v1" }, { clock: "5236-03-31T21:21:00.685Z" }, /outside the UUID v1 timestamp range/);
await rejects(GENERATE, { version: "v1" }, { clock: "1582-10-14T23:59:59.999Z" }, /outside the UUID v1 timestamp range/);
await rejects(GENERATE, { version: "v1" }, { clock: "yesterday" }, /clock must provide an ISO 8601 timestamp/);
await rejects(GENERATE, { version: "v1" }, { clock: 1735689600000 }, /clock must provide an ISO 8601 timestamp/);

// Decode fixtures: version, variant, bytes, hexadecimal and v1 time fields.
for (const vector of await fixture("decode")) {
  const decoded = await run(DECODE, vector.options, { input: vector.input });
  assert.equal(decoded.text, vector.text, vector.name);
  assert.deepEqual(decoded.value, vector.value, vector.name);
}

// Batch counts and presentation.
for (const count of [1, 2, "2", 10, 50, 99, "99", 100, "100"]) {
  const expected = Number(count);
  const batch = await run(GENERATE, { version: "v4", count });
  assert.equal(batch.lines.length, expected, `count ${JSON.stringify(count)} yields ${expected} lines`);
  assert.equal(batch.value.count, expected);
  assert.equal(batch.value.uuids.length, expected);
  assert.equal(new Set(batch.lines).size, expected, "batch values are distinct");
  for (const line of batch.lines) assert.match(line, CANONICAL_LOWER);
  assert.equal(batch.text, `${batch.value.uuids.map(item => item.uuid).join("\n")}\n`, "text artifact lists every value in order");
  assert.ok(new TextEncoder().encode(batch.text).byteLength <= Number(generateOp.limits.maxOutputBytes), "largest batch fits the declared output limit");
}
assert.equal(Number(generateOption("count").maximum), 100, "manifest count maximum matches the processor bound");
assert.equal(Number(generateOption("count").minimum), 1);
assert.deepEqual(generateOption("version").choices.map(choice => choice.id), ["v1", "v3", "v4", "v5"]);
assert.deepEqual(generateOption("case").choices.map(choice => choice.id), ["lower", "upper"]);
assert.deepEqual(decodeOption("case").choices.map(choice => choice.id), ["lower", "upper"]);
assert.equal(generateOption("namespace").default, "dns");
const defaults = Object.fromEntries(generateOp.options.map(item => [item.id, item.default]));
const withDefaults = await run(GENERATE, defaults);
assert.equal(withDefaults.value.version, 4, "manifest defaults generate one lowercase v4");
assert.equal(withDefaults.value.count, 1);
assert.equal(withDefaults.value.case, "lower");
for (const version of ["v4", "V4", "4", 4]) assert.equal((await run(GENERATE, { version })).value.version, 4, `version ${JSON.stringify(version)}`);
for (const version of ["v1", "1", 1]) assert.equal((await run(GENERATE, { version })).value.version, 1, `version ${JSON.stringify(version)}`);
const upper = await run(GENERATE, { version: "v4", count: 5, case: "upper" });
for (const line of upper.lines) assert.match(line, CANONICAL_UPPER);
assert.equal(upper.value.case, "upper");
assert.equal(upper.value.uuids[0].hexadecimal, upper.value.uuids[0].hexadecimal.toUpperCase());
assert.deepEqual((await run(GENERATE, { version: "v4", count: 5, case: "lower" })).lines, upper.lines.map(line => line.toLowerCase()), "case is presentation only");
assert.deepEqual((await run(GENERATE, { version: "v4", count: 5 })).lines, upper.lines.map(line => line.toLowerCase()), "case defaults to lower");
for (const item of upper.value.uuids) assert.deepEqual((await run(DECODE, {}, { input: item.uuid })).value.bytes, item.bytes, "uppercase output decodes to the same bytes");
assert.notEqual((await run(GENERATE, { version: "v4" }, { seed: 1 })).lines[0], (await run(GENERATE, { version: "v4" }, { seed: 2 })).lines[0], "different randomness yields different v4 values");

// No-input generator behavior: an omitted or unrecognized operationId falls back to generate.
for (const request of [undefined, {}, { options: null }]) {
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(new MemoryReader(), outputs, new CancellationToken(), new FixedClock(CLOCK), new SeededRandom(42), new MemorySecrets());
  const result = await execute(request, context);
  assert.equal(result.mode, "generate");
  assert.equal(result.version, 4);
  assert.equal(result.count, 1);
  assert.match(text(outputs.bytes.get("uuid")), /^[0-9a-f-]{36}\n$/);
}
// Generate never reads the document, even when one is present on the port (the DU-10 defect this package was split to fix).
const blank = await run(GENERATE, { version: "v4", count: 2 }, { input: " \n\t" });
assert.equal(blank.value.mode, "generate");
assert.equal(blank.lines.length, 2);
assert.deepEqual(blank.reader.inputs.get("uuid"), blank.original, "the document is left untouched");
const oversized = await run(GENERATE, { version: "v4" }, { input: "x".repeat(5000) });
assert.equal(oversized.value.mode, "generate", "generate ignores a document that would exceed the input limit, because it never reads it");

// Source input is preserved exactly; decode reads it and never rewrites it.
const preserved = await run(DECODE, {}, { input: "  550E8400-E29B-41D4-A716-446655440000\r\n" });
assert.equal(preserved.value.source, "  550E8400-E29B-41D4-A716-446655440000\r\n");
assert.equal(preserved.value.uuid, "550e8400-e29b-41d4-a716-446655440000");
assert.deepEqual(preserved.reader.inputs.get("uuid"), preserved.original, "input bytes are unchanged after decode");
assert.equal((await run(DECODE, { version: "v9", count: 0, namespace: "bogus" }, { input: "550e8400-e29b-41d4-a716-446655440000" })).value.version, 4, "decode ignores options that belong to generate");

// Invalid inputs and options are rejected before any output is written.
for (const vector of await fixture("invalid")) {
  const operationId = vector.operation === "decode" ? DECODE : GENERATE;
  await rejects(operationId, vector.options, { input: vector.input }, new RegExp(vector.error.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

// Output, input and name limits come from the injected SDK limits.
const limits = (overrides) => ({ maxInputBytes: 4096, maxOutputBytes: 1048576, maxChunkBytes: 1048576, deadlineMs: 0, ...overrides });
assert.equal((await run(GENERATE, { version: "v4", count: 2 }, { limits: limits({ maxOutputBytes: 74 }) })).lines.length, 2);
await rejects(GENERATE, { version: "v4", count: 3 }, { limits: limits({ maxOutputBytes: 74 }) }, /output exceeds limit/);
await rejects(GENERATE, { version: "v4", count: 2 }, { limits: limits({ maxChunkBytes: 50 }) }, /output chunk exceeds limit/);
assert.equal((await run(DECODE, {}, { input: "550e8400-e29b-41d4-a716-446655440000", limits: limits({ maxInputBytes: 36 }) })).value.version, 4);
await rejects(DECODE, {}, { input: "550e8400-e29b-41d4-a716-446655440000\n", limits: limits({ maxInputBytes: 36 }) }, /exceeds the 36 byte limit/);
assert.equal((await run(GENERATE, { version: "v5", name: "12345678" }, { limits: limits({ maxInputBytes: 8 }) })).value.name, "12345678");
await rejects(GENERATE, { version: "v5", name: "123456789" }, { limits: limits({ maxInputBytes: 8 }) }, /name exceeds the input limit/);
await rejects(GENERATE, { version: "v3", name: "🌍🌍🌍" }, { limits: limits({ maxInputBytes: 8 }) }, /name exceeds the input limit/);

// Cooperative cancellation: before the run, between generated values and before writes.
const cancelled = new CancellationToken();
cancelled.cancel();
await rejects(GENERATE, { version: "v4" }, { cancellation: cancelled }, ProcessorCancelled);
await rejects(DECODE, {}, { input: "550e8400-e29b-41d4-a716-446655440000", cancellation: cancelled }, ProcessorCancelled);
class CancelAfterFills { constructor(token, after) { this.token = token; this.after = after; this.fills = 0; this.id = "cancel-after-fills"; } fill(bytes) { new SeededRandom(9).fill(bytes); if (++this.fills === this.after) this.token.cancel(); } }
const midBatch = new CancellationToken();
await rejects(GENERATE, { version: "v4", count: 10 }, { cancellation: midBatch, randomness: new CancelAfterFills(midBatch, 5) }, ProcessorCancelled);
class CancelAfterChecks { constructor(after) { this.after = after; this.checks = 0; } isCancelled() { return ++this.checks > this.after; } }
await rejects(GENERATE, { version: "v5", name: "example.com", count: 100 }, { cancellation: new CancelAfterChecks(3) }, ProcessorCancelled);
await rejects(GENERATE, { version: "v1", count: 100 }, { cancellation: new CancelAfterChecks(50) }, ProcessorCancelled);

// RFC 1321 MD5 test vectors
const md5Hex = bytes => Array.from(md5(bytes), b => b.toString(16).padStart(2, "0")).join("");
const encoder = new TextEncoder();
assert.equal(md5Hex(encoder.encode("")), "d41d8cd98f00b204e9800998ecf8427e", "RFC 1321 md5 empty");
assert.equal(md5Hex(encoder.encode("a")), "0cc175b9c0f1b6a831c399e269772661", "RFC 1321 md5 a");
assert.equal(md5Hex(encoder.encode("abc")), "900150983cd24fb0d6963f7d28e17f72", "RFC 1321 md5 abc");
assert.equal(md5Hex(encoder.encode("message digest")), "f96b697d7cb7938d525a2f31aaf161d0", "RFC 1321 md5 message digest");
assert.equal(md5Hex(encoder.encode("abcdefghijklmnopqrstuvwxyz")), "c3fcd3d76192e4007dfb496cca67e13b", "RFC 1321 md5 alphabet");
assert.equal(md5Hex(encoder.encode("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")), "d174ab98d277d9f5a5611c2c9f419d9f", "RFC 1321 md5 alphanum");
assert.equal(md5Hex(encoder.encode("12345678901234567890123456789012345678901234567890123456789012345678901234567890")), "57edf4a22be3c955ac49da2e2107b67a", "RFC 1321 md5 80 chars");

console.log("uuid package tests passed");
