import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";

/**
 * Row and node limits for `url.parse-query`. They mirror `manifest.json`
 * (test.mjs asserts they stay equal). The SDK `Limits` type carries only byte
 * and deadline limits, so a host that materialises the manifest's `maxRows` /
 * `maxNodes` onto `context.limits` overrides these package defaults.
 */
export const PACKAGE_LIMITS = Object.freeze({ maxRows: 10000, maxNodes: 20000 });
export const BRACKET_SEMANTICS = "a decoded name ending in [] is an array parameter under the name without []; every other bracket is literal";
const CHECK_EVERY = 4096; // bytes between cooperative cancellation checks
const READ_CHUNK = 64 * 1024;

const decoder = new TextDecoder("utf-8"); // only applied to bytes already validated as UTF-8
const HEX = "0123456789ABCDEF";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const table = (chars) => { const set = new Uint8Array(256); for (const c of chars) set[c.charCodeAt(0)] = 1; return set; };
const RFC3986_UNRESERVED = table(`${ALNUM}-._~`);
const FORM_SAFE = table(`${ALNUM}*-._`);
const SCHEME_TAIL = table(`${ALNUM}+-.`);
const ASCII_WHITESPACE = table(" \t\r\n");

function check(context) { if (context.cancellation.isCancelled()) throw new ProcessorCancelled(); }
const hex = (byte) => `0x${HEX[byte >> 4]}${HEX[byte & 15]}`;
const token = (bytes, start, end) => JSON.stringify(decoder.decode(bytes.subarray(start, end)));
function indexOf(bytes, byte, start, end) { for (let i = start; i < end; i += 1) if (bytes[i] === byte) return i; return -1; }

/** Offset of the first byte that does not begin a well-formed UTF-8 sequence (RFC 3629), or -1. */
export function utf8InvalidOffset(bytes) {
  const length = bytes.length;
  for (let i = 0; i < length;) {
    const lead = bytes[i];
    if (lead < 0x80) { i += 1; continue; }
    let need;
    if (lead >= 0xC2 && lead <= 0xDF) need = 1;
    else if (lead >= 0xE0 && lead <= 0xEF) need = 2;
    else if (lead >= 0xF0 && lead <= 0xF4) need = 3;
    else return i;
    if (i + need >= length) return i;
    let low = 0x80, high = 0xBF;
    if (lead === 0xE0) low = 0xA0; else if (lead === 0xED) high = 0x9F; else if (lead === 0xF0) low = 0x90; else if (lead === 0xF4) high = 0x8F;
    const second = bytes[i + 1];
    if (second < low || second > high) return i;
    for (let k = 2; k <= need; k += 1) { const c = bytes[i + k]; if (c < 0x80 || c > 0xBF) return i; }
    i += need + 1;
  }
  return -1;
}

async function readInput(context) {
  const chunks = [];
  let length = 0;
  for await (const chunk of context.readChunks("input", READ_CHUNK)) { chunks.push(chunk); length += chunk.byteLength; }
  let bytes;
  if (chunks.length === 1) bytes = chunks[0];
  else { bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } }
  const bad = utf8InvalidOffset(bytes);
  if (bad >= 0) throw new Error(`input is not valid UTF-8 text: byte ${hex(bytes[bad])} at byte offset ${bad} does not begin a well-formed sequence`);
  return bytes;
}

function ensureOutputFits(length, context) {
  const { maxOutputBytes, maxChunkBytes } = context.limits;
  if (length > maxOutputBytes) throw new Error(`output of ${length} bytes exceeds the ${maxOutputBytes} byte output limit`);
  if (length > maxChunkBytes) throw new Error(`output of ${length} bytes exceeds the ${maxChunkBytes} byte chunk limit`);
}

function countLimit(context, name) {
  const supplied = context.limits?.[name];
  if (supplied === undefined || supplied === null) return PACKAGE_LIMITS[name];
  const value = typeof supplied === "string" && /^[0-9]+$/u.test(supplied) ? Number(supplied) : supplied;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} limit must be a non-negative integer`);
  return value;
}

function encodePercent(bytes, form, context) {
  const safe = form ? FORM_SAFE : RFC3986_UNRESERVED;
  let length = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (i % CHECK_EVERY === 0) check(context);
    length += safe[bytes[i]] || (form && bytes[i] === 0x20) ? 1 : 3;
  }
  ensureOutputFits(length, context);
  const out = new Uint8Array(length);
  let o = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (i % CHECK_EVERY === 0) check(context);
    const byte = bytes[i];
    if (safe[byte]) out[o++] = byte;
    else if (form && byte === 0x20) out[o++] = 0x2B;
    else { out[o++] = 0x25; out[o++] = HEX.charCodeAt(byte >> 4); out[o++] = HEX.charCodeAt(byte & 15); }
  }
  return out;
}

function hexValue(byte) {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  return -1;
}

/** Source offset of the byte that produced decoded byte `decodedIndex` (valid once escapes are known well-formed). */
function sourceOffset(bytes, start, end, decodedIndex) {
  let i = start;
  for (let o = 0; i < end && o < decodedIndex; o += 1) i += bytes[i] === 0x25 ? 3 : 1;
  return i;
}

/**
 * Single-pass percent decoding of bytes[start, end). `%XX` becomes one byte,
 * `+` becomes a space only in form mode, every other byte is copied. The
 * result is validated as UTF-8; escapes are never re-scanned.
 */
function decodePercent(bytes, start, end, form, context, where = "") {
  const out = new Uint8Array(end - start);
  let o = 0;
  for (let i = start; i < end;) {
    if ((i - start) % CHECK_EVERY === 0) check(context);
    const byte = bytes[i];
    if (byte === 0x25) {
      if (i + 2 >= end) throw new Error(`percent escape ${token(bytes, i, end)}${where} at byte offset ${i} is truncated; expected two hexadecimal digits`);
      const high = hexValue(bytes[i + 1]);
      const low = hexValue(bytes[i + 2]);
      if (high < 0 || low < 0) throw new Error(`percent escape ${token(bytes, i, i + 3)}${where} at byte offset ${i} must use two hexadecimal digits`);
      out[o++] = high * 16 + low;
      i += 3;
      continue;
    }
    out[o++] = form && byte === 0x2B ? 0x20 : byte;
    i += 1;
  }
  const decoded = out.subarray(0, o);
  const bad = utf8InvalidOffset(decoded);
  if (bad >= 0) {
    const offset = sourceOffset(bytes, start, end, bad);
    throw new Error(`decoded bytes${where} are not valid UTF-8: byte ${hex(decoded[bad])} produced at input byte offset ${offset} does not begin a well-formed sequence`);
  }
  return decoded;
}

/** True for `scheme://...` (RFC 3986 scheme followed by an authority). */
function isAbsoluteUrl(bytes, start, end) {
  const first = bytes[start];
  const alpha = start < end && ((first >= 0x41 && first <= 0x5A) || (first >= 0x61 && first <= 0x7A));
  if (!alpha) return false;
  let i = start + 1;
  while (i < end && SCHEME_TAIL[bytes[i]]) i += 1;
  return i + 2 < end && bytes[i] === 0x3A && bytes[i + 1] === 0x2F && bytes[i + 2] === 0x2F;
}

/**
 * Locate the query inside the trimmed input. The first unencoded `?` always
 * starts the query and the first `#` always ends it; without a `?`, the whole
 * input (up to `#`) is the query.
 */
function locateQuery(bytes) {
  let start = 0;
  let end = bytes.length;
  while (start < end && ASCII_WHITESPACE[bytes[start]]) start += 1;
  while (end > start && ASCII_WHITESPACE[bytes[end - 1]]) end -= 1;
  const question = indexOf(bytes, 0x3F, start, end);
  const hash = indexOf(bytes, 0x23, start, end);
  const queryEnd = hash >= 0 ? hash : end;
  const delimiter = question >= 0 && question < queryEnd ? question : -1;
  const fragment = hash >= 0 ? decoder.decode(bytes.subarray(hash + 1, end)) : null;
  const components = { href: null, scheme: null, host: null, path: null, query: "", fragment };
  let form;
  let queryStart;
  if (isAbsoluteUrl(bytes, start, end)) {
    const text = decoder.decode(bytes.subarray(start, end));
    let url;
    try { url = new URL(text); } catch { throw new Error("input looks like an absolute URL but is malformed"); }
    form = "url";
    queryStart = delimiter >= 0 ? delimiter + 1 : queryEnd;
    Object.assign(components, { href: url.href, scheme: url.protocol.slice(0, -1), host: url.host, path: url.pathname });
  } else if (delimiter >= 0) {
    form = delimiter === start ? "query" : "reference";
    queryStart = delimiter + 1;
    components.path = decoder.decode(bytes.subarray(start, delimiter));
  } else {
    form = "raw";
    queryStart = start;
  }
  components.query = decoder.decode(bytes.subarray(queryStart, queryEnd));
  return { form, components, queryStart, queryEnd, trimmedBytes: bytes.length - (end - start) };
}

function parseParameters(bytes, queryStart, queryEnd, context, limits) {
  const values = new Map();
  const entries = [];
  let rows = 0;
  let emptySegments = 0;
  let nodes = 0;
  for (let segmentStart = queryStart; ;) {
    check(context);
    const ampersand = indexOf(bytes, 0x26, segmentStart, queryEnd);
    const segmentEnd = ampersand < 0 ? queryEnd : ampersand;
    if (segmentEnd === segmentStart) { if (queryEnd > queryStart) emptySegments += 1; }
    else {
      rows += 1;
      if (rows > limits.maxRows) throw new Error(`query has more than ${limits.maxRows} parameters (row limit)`);
      const equals = indexOf(bytes, 0x3D, segmentStart, segmentEnd);
      const nameEnd = equals < 0 ? segmentEnd : equals;
      const name = decoder.decode(decodePercent(bytes, segmentStart, nameEnd, true, context, ` in the name of parameter ${rows}`));
      const value = equals < 0 ? "" : decoder.decode(decodePercent(bytes, equals + 1, segmentEnd, true, context, ` in the value of parameter ${rows}`));
      const arrayNotation = name.endsWith("[]");
      const key = arrayNotation ? name.slice(0, -2) : name;
      entries.push({ key, name, value, arrayNotation, hadEquals: equals >= 0, offset: segmentStart });
      const existing = values.get(key);
      if (existing === undefined) { values.set(key, arrayNotation ? [value] : value); nodes += arrayNotation ? 2 : 1; }
      else if (Array.isArray(existing)) { existing.push(value); nodes += 1; }
      else { values.set(key, [existing, value]); nodes += 2; }
      if (nodes > limits.maxNodes) throw new Error(`parameter tree has more than ${limits.maxNodes} nodes (node limit)`);
    }
    if (ampersand < 0) break;
    segmentStart = ampersand + 1;
  }
  return { values, entries, counts: { parameters: rows, names: values.size, nodes, emptySegments } };
}

/** JSON text in first-encounter order; JSON.stringify would hoist integer-like names. */
function serializeParameters(values, indent) {
  if (values.size === 0) return "{}";
  const pad = " ".repeat(indent);
  const newline = indent > 0 ? "\n" : "";
  const separator = indent > 0 ? ": " : ":";
  const members = [];
  for (const [key, value] of values) members.push(`${pad}${JSON.stringify(key)}${separator}${JSON.stringify(value, null, indent).replaceAll("\n", `\n${pad}`)}`);
  return `{${newline}${members.join(`,${newline}`)}${newline}}`;
}

async function emit(context, bytes, value) {
  ensureOutputFits(bytes.byteLength, context);
  await context.writeValue("output", value);
  await context.write("output", bytes);
}

function integerOption(options, name, fallback, minimum, maximum) {
  const raw = options[name] ?? fallback;
  const value = typeof raw === "string" && /^[0-9]+$/u.test(raw) ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

async function transform(options, context) {
  const mode = options.mode ?? "encode";
  const encoding = options.encoding ?? "rfc3986";
  if (mode !== "encode" && mode !== "decode") throw new Error("mode must be encode or decode");
  if (encoding !== "rfc3986" && encoding !== "form") throw new Error("encoding must be rfc3986 or form");
  check(context); // readChunks never polls for an empty document
  const input = await readInput(context);
  const form = encoding === "form";
  const output = mode === "encode" ? encodePercent(input, form, context) : decodePercent(input, 0, input.length, form, context);
  const value = { mode, encoding, text: decoder.decode(output), inputBytes: input.length, outputBytes: output.length, complete: true };
  await emit(context, output, value);
  return value;
}

async function parseQuery(options, context) {
  const indent = integerOption(options, "indent", 2, 0, 8);
  const limits = { maxRows: countLimit(context, "maxRows"), maxNodes: countLimit(context, "maxNodes") };
  check(context); // readChunks never polls for an empty document
  const input = await readInput(context);
  const { form, components, queryStart, queryEnd, trimmedBytes } = locateQuery(input);
  const { values, entries, counts } = parseParameters(input, queryStart, queryEnd, context, limits);
  const output = new TextEncoder().encode(serializeParameters(values, indent));
  const value = {
    form, parameters: Object.fromEntries(values), entries, components, counts, limits, trimmedBytes,
    bracketSemantics: BRACKET_SEMANTICS, inputBytes: input.length, outputBytes: output.length, complete: true,
  };
  await emit(context, output, value);
  return value;
}

export async function execute(request, context) {
  const operationId = request?.operationId ?? "url.transform";
  const options = request?.options ?? {};
  if (operationId === "url.transform") return transform(options, context);
  if (operationId === "url.parse-query") return parseQuery(options, context);
  throw new Error(`unsupported operation ${operationId}`);
}
