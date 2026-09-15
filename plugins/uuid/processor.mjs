import { createHash } from "node:crypto";

const PRESETS = {
  dns: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  url: "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
  oid: "6ba7b812-9dad-11d1-80b4-00c04fd430c8",
  x500: "6ba7b814-9dad-11d1-80b4-00c04fd430c8"
};
const HEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = new TextEncoder();
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
const bytesOf = value => Uint8Array.from(value.match(/[0-9a-f]{2}/gi).map(x => parseInt(x, 16)));
const parseUuid = value => {
  if (typeof value !== "string" || !HEX.test(value)) throw new Error("UUID must be canonical xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx");
  return bytesOf(value.replaceAll("-", ""));
};
const formatUuid = bytes => { const h = hex(bytes); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`; };
const namespaceValue = value => parseUuid(PRESETS[String(value ?? "").toLowerCase()] ?? value);

function variant(bytes) {
  const b = bytes[8];
  return (b & 0x80) === 0 ? "NCS" : (b & 0xc0) === 0x80 ? "RFC 4122" : (b & 0xe0) === 0xc0 ? "Microsoft" : "future";
}
function decodeUuid(value) {
  const b = parseUuid(value), version = (b[6] >>> 4) & 15;
  const properties = { uuid: value, version, variant: variant(b), bytes: [...b], hexadecimal: hex(b) };
  if (version === 1) {
    const timeLow = BigInt((b[0]<<24)|(b[1]<<16)|(b[2]<<8)|b[3]) & 0xffffffffn;
    const timeMid = BigInt((b[4]<<8)|b[5]), timeHi = BigInt(((b[6]&15)<<8)|b[7]);
    const ticks = (timeHi << 48n) | (timeMid << 32n) | timeLow;
    properties.timestamp = new Date(Number((ticks - 0x01b21dd213814000n) / 10000n)).toISOString();
    properties.clockSequence = ((b[8] & 0x3f) << 8) | b[9];
    properties.node = [...b.slice(10)].map(x=>x.toString(16).padStart(2,"0")).join(":");
  }
  return properties;
}
function randomUuid(context) { const b = new Uint8Array(16); context.randomness.fill(b); b[6] = (b[6] & 15) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; return formatUuid(b); }
function timeUuid(context) {
  const millis = Date.parse(context.clock.now());
  if (!Number.isFinite(millis)) throw new Error("clock must provide an ISO timestamp");
  const ticks = BigInt(millis) * 10000n + 0x01b21dd213814000n;
  const b = new Uint8Array(16); const random = new Uint8Array(8); context.randomness.fill(random);
  let x = ticks; for (let i=3;i>=0;i--){ b[i]=Number(x&255n); x>>=8n; } for(let i=5;i>=4;i--){b[i]=Number(x&255n);x>>=8n;} for(let i=7;i>=6;i--){b[i]=Number(x&255n);x>>=8n;}
  b[6]=(b[6]&15)|0x10; b[8]=(random[0]&0x3f)|0x80; b[9]=random[1]; b.set(random.slice(2,8),10); b[10]|=1;
  return formatUuid(b);
}
function nameUuid(version, namespace, name) {
  const algo = version === "3" ? "md5" : "sha1"; const digest = createHash(algo).update(namespace).update(text.encode(name)).digest();
  const b = Uint8Array.from(digest.slice(0,16)); b[6]=(b[6]&15)|(Number(version)<<4); b[8]=(b[8]&0x3f)|0x80; return formatUuid(b);
}

export async function execute(request, context) {
  const options = request?.options ?? {};
  if (options.case !== undefined && options.case !== "lower" && options.case !== "upper") throw new Error("case must be lower or upper");
  const mode = options.mode ?? "generate";
  let input = "";
  try { input = new TextDecoder().decode(await context.read("uuid")).trim(); } catch (error) { if (!(error instanceof Error) || !error.message.includes("named input")) throw error; }
  if (mode === "decode" || input) {
    const value = input || options.uuid;
    if (!value) throw new Error("decode mode requires a UUID input");
    const props = decodeUuid(value); await context.writeValue("uuid", props); await context.write("uuid", text.encode(value + "\n")); return props;
  }
  const version = String(options.version ?? "v4").replace(/^v/, ""); if (!["1","3","4","5"].includes(version)) throw new Error("version must be 1, 3, 4 or 5");
  const count = Number(options.count ?? 1); if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error("count must be an integer from 1 to 100");
  let namespace, name; if (version === "3" || version === "5") { namespace = namespaceValue(options.namespace ?? "dns"); name = options.name; if (typeof name !== "string" || !name) throw new Error("name is required for v3/v5"); }
  const values = []; for (let i=0;i<count;i++) values.push(version === "1" ? timeUuid(context) : version === "4" ? randomUuid(context) : nameUuid(version, namespace, name));
  const out = options.case === "upper" ? values.map(v=>v.toUpperCase()) : values;
  await context.writeValue("uuid", out.map(uuid => ({ uuid, ...decodeUuid(uuid) }))); await context.write("uuid", text.encode(out.join("\n") + "\n")); return out;
}
