import { createHash } from "node:crypto";
import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";

// RFC 4122 §C name-space IDs; any canonical UUID is accepted as a custom namespace.
const NAMESPACES = {
  dns: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  url: "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
  oid: "6ba7b812-9dad-11d1-80b4-00c04fd430c8",
  x500: "6ba7b814-9dad-11d1-80b4-00c04fd430c8"
};
const CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSIONS = new Map([["v1", 1], ["v3", 3], ["v4", 4], ["v5", 5]]);
const MAX_COUNT = 100;
// 100-nanosecond ticks between the Gregorian reform (1582-10-15) and the Unix epoch.
const GREGORIAN_OFFSET = 0x01b21dd213814000n;
const MAX_TICKS = 1n << 60n;
const utf8 = new TextEncoder();

const check = context => { if (context.cancellation.isCancelled()) throw new ProcessorCancelled(); };
const present = (value, upper) => upper ? value.toUpperCase() : value;
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
const formatUuid = bytes => { const h = hex(bytes); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
function parseUuid(value) {
  if (typeof value !== "string" || !CANONICAL.test(value)) throw new Error("UUID must be canonical xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx");
  const digits = value.replaceAll("-", "");
  return Uint8Array.from({ length: 16 }, (_, index) => parseInt(digits.slice(index * 2, index * 2 + 2), 16));
}

function parseCase(value) {
  if (value === undefined || value === null || value === "lower") return false;
  if (value === "upper") return true;
  throw new Error("case must be lower or upper");
}
function parseMode(value) {
  const mode = value ?? "generate";
  if (mode !== "generate" && mode !== "decode") throw new Error("mode must be generate or decode");
  return mode;
}
function parseVersion(value) {
  const key = value === undefined || value === null ? "v4" : `v${String(value).replace(/^v/i, "")}`;
  const version = VERSIONS.get(key.toLowerCase());
  if (version === undefined) throw new Error("version must be v1, v3, v4 or v5");
  return version;
}
function parseCount(value) {
  // Integer options travel as decimal strings on the wire; plain integers are accepted for tests and headless runs.
  const count = typeof value === "string" && /^\d{1,3}$/.test(value) ? Number(value) : value ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) throw new Error(`count must be an integer from 1 to ${MAX_COUNT}`);
  return count;
}
function parseNamespace(value) {
  const preset = typeof value === "string" ? NAMESPACES[value.trim().toLowerCase()] : undefined;
  try { return parseUuid(preset ?? value); } catch { throw new Error("namespace must be dns, url, oid, x500 or a canonical UUID"); }
}
function parseName(value, limits) {
  if (typeof value !== "string" || value.length === 0) throw new Error("name is required for v3 and v5");
  const bytes = utf8.encode(value);
  if (bytes.byteLength > limits.maxInputBytes) throw new Error("name exceeds the input limit");
  return bytes;
}

function variant(byte) {
  if ((byte & 0x80) === 0) return "NCS";
  if ((byte & 0xc0) === 0x80) return "RFC 4122";
  if ((byte & 0xe0) === 0xc0) return "Microsoft";
  return "future";
}
function timeFields(bytes, upper) {
  const low = BigInt(((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0);
  const mid = BigInt((bytes[4] << 8) | bytes[5]);
  const high = BigInt(((bytes[6] & 0x0f) << 8) | bytes[7]);
  const ticks = (high << 48n) | (mid << 32n) | low;
  const unix = ticks - GREGORIAN_OFFSET;
  let millis = unix / 10000n, fraction = unix % 10000n;
  if (fraction < 0n) { millis -= 1n; fraction += 10000n; }
  const iso = new Date(Number(millis)).toISOString();
  return {
    timestamp: `${iso.slice(0, -1)}${String(fraction).padStart(4, "0")}Z`,
    ticks: ticks.toString(),
    clockSequence: ((bytes[8] & 0x3f) << 8) | bytes[9],
    node: present(Array.from(bytes.subarray(10), byte => byte.toString(16).padStart(2, "0")).join(":"), upper),
    multicast: (bytes[10] & 0x01) === 0x01
  };
}
function describe(bytes, upper) {
  const version = bytes[6] >>> 4, kind = variant(bytes[8]);
  const properties = { uuid: present(formatUuid(bytes), upper), version, variant: kind, bytes: Array.from(bytes), hexadecimal: present(hex(bytes), upper) };
  if (version === 1 && kind === "RFC 4122") Object.assign(properties, timeFields(bytes, upper));
  return properties;
}

function nameUuid(version, namespace, name) {
  const digest = createHash(version === 3 ? "md5" : "sha1").update(namespace).update(name).digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | (version << 4);
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes;
}
function randomUuid(context) {
  const bytes = new Uint8Array(16);
  context.randomness.fill(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes;
}
function timeBase(context, count) {
  const now = context.clock.now();
  const millis = typeof now === "string" ? Date.parse(now) : Number.NaN;
  if (!Number.isFinite(millis)) throw new Error("clock must provide an ISO 8601 timestamp");
  const ticks = BigInt(millis) * 10000n + GREGORIAN_OFFSET;
  if (ticks < 0n || ticks + BigInt(count - 1) >= MAX_TICKS) throw new Error("clock is outside the UUID v1 timestamp range");
  // One batch behaves like one node: clock sequence and node are drawn once, node has the multicast bit set (RFC 4122 §4.5).
  const tail = new Uint8Array(8);
  context.randomness.fill(tail);
  tail[0] = (tail[0] & 0x3f) | 0x80;
  tail[2] |= 0x01;
  return { now, ticks, tail };
}
function timeUuid(base, index) {
  const ticks = base.ticks + BigInt(index);
  const low = Number(ticks & 0xffffffffn), mid = Number((ticks >> 32n) & 0xffffn), high = Number((ticks >> 48n) & 0x0fffn) | 0x1000;
  const bytes = new Uint8Array(16);
  bytes[0] = low >>> 24; bytes[1] = (low >>> 16) & 0xff; bytes[2] = (low >>> 8) & 0xff; bytes[3] = low & 0xff;
  bytes[4] = mid >>> 8; bytes[5] = mid & 0xff; bytes[6] = high >>> 8; bytes[7] = high & 0xff;
  bytes.set(base.tail, 8);
  return bytes;
}

async function readInput(context) {
  try { return new TextDecoder().decode(await context.read("uuid")); }
  catch (error) { if (error instanceof Error && error.message.includes("named input")) return undefined; throw error; }
}

async function decode(source, origin, upper, context) {
  if (typeof source !== "string") throw new Error("UUID must be canonical xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx");
  const value = { mode: "decode", origin, source, case: upper ? "upper" : "lower", ...describe(parseUuid(source.trim()), upper), complete: true };
  await context.write("uuid", utf8.encode(`${value.uuid}\n`));
  await context.writeValue("uuid", value);
  return value;
}

async function generate(options, upper, context) {
  const version = parseVersion(options.version), count = parseCount(options.count);
  const value = { mode: "generate", version, count, case: upper ? "upper" : "lower" };
  let make;
  if (version === 3 || version === 5) {
    const namespace = parseNamespace(options.namespace ?? "dns"), name = parseName(options.name, context.limits);
    value.namespace = formatUuid(namespace);
    value.name = options.name;
    make = () => nameUuid(version, namespace, name);
  } else if (version === 4) {
    value.randomness = context.randomness.id;
    make = () => randomUuid(context);
  } else {
    const base = timeBase(context, count);
    value.clock = base.now;
    value.randomness = context.randomness.id;
    make = index => timeUuid(base, index);
  }
  const uuids = [];
  for (let index = 0; index < count; index += 1) { check(context); uuids.push(describe(make(index), upper)); }
  value.uuids = uuids;
  value.complete = true;
  await context.write("uuid", utf8.encode(`${uuids.map(item => item.uuid).join("\n")}\n`));
  await context.writeValue("uuid", value);
  return value;
}

export async function execute(request, context) {
  const options = request?.options ?? {};
  check(context);
  const mode = parseMode(options.mode), upper = parseCase(options.case);
  const input = await readInput(context);
  // Text on the optional `uuid` port always decodes; explicit decode mode may take the UUID from the `uuid` option instead.
  if (input !== undefined && input.trim() !== "") return decode(input, "input", upper, context);
  if (mode === "decode") {
    if (options.uuid === undefined || options.uuid === null || options.uuid === "") throw new Error("decode mode requires a UUID input");
    return decode(options.uuid, "option", upper, context);
  }
  return generate(options, upper, context);
}
