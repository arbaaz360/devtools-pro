// Base64 text codec (RFC 4648 §4 standard and §5 URL-safe alphabets).
//
// Encode works on the exact input bytes; decode works on the exact input
// bytes as ASCII. Nothing here re-decodes text through a lossy path, so the
// source document is never altered by the codec. All diagnostics are thrown
// as Base64Error with a stable `code`, the byte `offset` and the 1-based
// `line`/`column` of the first offending byte, plus a hint naming the option
// that would accept the input when one exists.
import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";

export const STANDARD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export const URL_SAFE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export const PAD = "=";
export const MODES = ["encode", "decode"];
export const VARIANTS = ["standard", "url"];
export const PADDINGS = ["required", "omit", "optional"];
export const ERROR_POLICIES = ["strict", "tolerant", "replace"];
/** ASCII whitespace ignored by the tolerant and replace policies. */
export const WHITESPACE = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20];
/** Input is streamed through the SDK in bounded pieces; the output is one artifact. */
export const READ_CHUNK_BYTES = 64 * 1024;
const HEX_PREVIEW_BYTES = 32;

export class Base64Error extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "Base64Error";
    this.code = code;
    Object.assign(this, details);
  }
}

const encoder = new TextEncoder();
// ignoreBOM keeps a leading U+FEFF in the text; the artifact bytes keep it too.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lossyUtf8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

// Reverse lookup per alphabet. >= 0: sextet value; -1: not Base64; -2: the
// other alphabet's symbol; -3: padding; -4: ASCII whitespace.
const OTHER_ALPHABET = -2;
const PADDING = -3;
const SPACE = -4;
function reverseTable(alphabet, foreign) {
  const table = new Int8Array(256).fill(-1);
  for (let i = 0; i < alphabet.length; i += 1) table[alphabet.charCodeAt(i)] = i;
  for (const character of foreign) table[character.charCodeAt(0)] = OTHER_ALPHABET;
  table[PAD.charCodeAt(0)] = PADDING;
  for (const code of WHITESPACE) table[code] = SPACE;
  return table;
}
const TABLES = {
  standard: { forward: encoder.encode(STANDARD_ALPHABET), reverse: reverseTable(STANDARD_ALPHABET, "-_"), foreign: "URL-safe", label: "standard" },
  url: { forward: encoder.encode(URL_SAFE_ALPHABET), reverse: reverseTable(URL_SAFE_ALPHABET, "+/"), foreign: "standard", label: "URL-safe" },
};

function choice(options, id, alias, allowed, fallback) {
  const value = options[id] ?? (alias ? options[alias] : undefined) ?? fallback;
  if (!allowed.includes(value))
    throw new Base64Error("invalid-option", `${id} must be one of ${allowed.map((item) => JSON.stringify(item)).join(", ")} (received ${JSON.stringify(value)})`, { option: id });
  return value;
}

export function readOptions(options = {}) {
  return {
    mode: choice(options, "mode", null, MODES, "encode"),
    variant: choice(options, "variant", null, VARIANTS, "standard"),
    padding: choice(options, "padding", null, PADDINGS, "required"),
    errorPolicy: choice(options, "error-policy", "errorPolicy", ERROR_POLICIES, "strict"),
  };
}

/** Exact encoded length for `inputBytes` input bytes under a padding policy. */
export function encodedLength(inputBytes, padding) {
  const remainder = inputBytes % 3;
  const full = (inputBytes - remainder) / 3 * 4;
  if (remainder === 0) return full;
  return full + (padding === "omit" ? remainder + 1 : 4);
}

function check(context) {
  if (context.cancellation.isCancelled()) throw new ProcessorCancelled();
}

/** One artifact per port: the sink caps a single write at maxChunkBytes. */
function outputCap(limits) {
  return Math.min(limits.maxOutputBytes, limits.maxChunkBytes);
}

function asciiText(bytes) {
  let text = "";
  for (let start = 0; start < bytes.length; start += 8192) text += String.fromCharCode.apply(null, bytes.subarray(start, Math.min(start + 8192, bytes.length)));
  return text;
}

function printable(byte) {
  if (byte === 0x0a) return "\\n";
  if (byte === 0x0d) return "\\r";
  if (byte === 0x09) return "\\t";
  if (byte < 0x20 || byte >= 0x7f) return `0x${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  return JSON.stringify(String.fromCharCode(byte));
}

async function knownSize(context) {
  if (typeof context.reader.size !== "function") return undefined;
  const size = await context.reader.size("input");
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

function limitError(kind, needed, cap) {
  return new Base64Error("output-limit", `${kind} would produce ${needed.toLocaleString("en-US")} bytes, above the ${cap.toLocaleString("en-US")} byte output limit; split the input or raise the limit`, { needed, limit: cap });
}

class Growable {
  constructor(initial, cap, kind) { this.bytes = new Uint8Array(Math.min(Math.max(initial, 0), cap)); this.length = 0; this.cap = cap; this.kind = kind; }
  ensure(extra) {
    const needed = this.length + extra;
    if (needed > this.cap) throw limitError(this.kind, needed, this.cap);
    if (needed > this.bytes.length) {
      const next = new Uint8Array(Math.min(this.cap, Math.max(needed, this.bytes.length * 2)));
      next.set(this.bytes.subarray(0, this.length));
      this.bytes = next;
    }
  }
  finish() { return this.bytes.subarray(0, this.length); }
}

async function encodeStream(context, settings) {
  const table = TABLES[settings.variant].forward;
  const cap = outputCap(context.limits);
  const size = await knownSize(context);
  if (size !== undefined) {
    const needed = encodedLength(size, settings.padding);
    if (needed > cap) throw limitError("Encoding", needed, cap);
  }
  const out = new Growable(size === undefined ? 4096 : encodedLength(size, settings.padding), cap, "Encoding");
  const carry = new Uint8Array(3);
  let carried = 0;
  let inputBytes = 0;
  const emit = (a, b, c) => {
    const bytes = out.bytes;
    let at = out.length;
    bytes[at++] = table[a >> 2];
    bytes[at++] = table[((a & 3) << 4) | (b >> 4)];
    bytes[at++] = table[((b & 15) << 2) | (c >> 6)];
    bytes[at++] = table[c & 63];
    out.length = at;
  };
  for await (const chunk of context.readChunks("input", READ_CHUNK_BYTES)) {
    check(context);
    inputBytes += chunk.byteLength;
    // Exact accounting: only complete triples are emitted from this chunk.
    out.ensure(Math.floor((carried + chunk.byteLength) / 3) * 4);
    let index = 0;
    while (carried > 0 && carried < 3 && index < chunk.byteLength) carry[carried++] = chunk[index++];
    if (carried === 3) { emit(carry[0], carry[1], carry[2]); carried = 0; }
    const stop = chunk.byteLength - ((chunk.byteLength - index) % 3);
    for (; index < stop; index += 3) emit(chunk[index], chunk[index + 1], chunk[index + 2]);
    while (index < chunk.byteLength) carry[carried++] = chunk[index++];
  }
  check(context);
  if (carried > 0) {
    out.ensure(settings.padding === "omit" ? carried + 1 : 4);
    const a = carry[0];
    const b = carried > 1 ? carry[1] : 0;
    const bytes = out.bytes;
    let at = out.length;
    bytes[at++] = table[a >> 2];
    bytes[at++] = table[((a & 3) << 4) | (b >> 4)];
    if (carried === 2) bytes[at++] = table[(b & 15) << 2];
    if (settings.padding !== "omit") {
      if (carried === 1) bytes[at++] = 0x3d;
      bytes[at++] = 0x3d;
    }
    out.length = at;
  }
  const output = out.finish();
  return { output, inputBytes, padded: settings.padding !== "omit" && inputBytes % 3 !== 0 };
}

async function decodeStream(context, settings) {
  const { reverse, label, foreign } = TABLES[settings.variant];
  const lenient = settings.errorPolicy !== "strict";
  const cap = outputCap(context.limits);
  const size = await knownSize(context);
  const out = new Growable(size === undefined ? 4096 : Math.ceil(size * 3 / 4), cap, "Decoding");
  const quad = new Uint8Array(4);
  let quadLength = 0;
  let pads = 0;
  let padStart = -1;
  let significant = 0;
  let whitespace = 0;
  let inputBytes = 0;
  let offset = 0;
  let line = 1;
  let column = 1;
  let lastByte = -1;
  const fail = (code, message, extra = {}) => new Base64Error(code, `${message} at offset ${offset} (line ${line}, column ${column})`, { offset, line, column, ...extra });
  for await (const chunk of context.readChunks("input", READ_CHUNK_BYTES)) {
    check(context);
    inputBytes += chunk.byteLength;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      const byte = chunk[index];
      const value = reverse[byte];
      if (value >= 0) {
        if (pads > 0) throw fail("data-after-padding", `Base64 character ${printable(byte)} follows padding; padding "=" may only end the input`);
        quad[quadLength++] = value;
        significant += 1;
        lastByte = byte;
        if (quadLength === 4) {
          if (out.length + 3 > out.bytes.length) out.ensure(3);
          const bytes = out.bytes;
          bytes[out.length++] = (quad[0] << 2) | (quad[1] >> 4);
          bytes[out.length++] = ((quad[1] & 15) << 4) | (quad[2] >> 2);
          bytes[out.length++] = ((quad[2] & 3) << 6) | quad[3];
          quadLength = 0;
        }
      } else if (value === PADDING) {
        if (settings.padding === "omit") throw fail("padding-forbidden", 'padding "=" is not allowed with the Omit padding policy; choose Required or Optional padding to accept padded input');
        if (pads === 0) {
          if (quadLength === 0) throw fail("padding-position", significant === 0 ? 'input starts with padding "="; padding may only complete a final group of 2 or 3 characters' : 'padding "=" follows a complete group of 4 characters; the encoded data is not padded here');
          if (quadLength === 1) throw fail("padding-position", 'padding "=" follows a single character; a Base64 group needs at least 2 characters, so the input is truncated or corrupted');
          padStart = quadLength;
        }
        pads += 1;
        if (pads > 4 - padStart) throw fail("padding-excess", `too many padding characters: ${4 - padStart} "=" complete this group but ${pads} were found`);
      } else if (value === SPACE) {
        if (!lenient) throw fail("whitespace", `whitespace ${printable(byte)} is not allowed by the strict error policy; choose the tolerant policy to ignore ASCII whitespace`);
        whitespace += 1;
      } else if (value === OTHER_ALPHABET) {
        throw fail("wrong-alphabet", `${printable(byte)} belongs to the ${foreign} alphabet, not the ${label} alphabet; switch Alphabet to ${foreign} if the whole input uses it`);
      } else if (byte >= 0x80) {
        const bom = offset === 0 && byte === 0xef && chunk[index + 1] === 0xbb && chunk[index + 2] === 0xbf;
        throw fail("not-ascii", `byte 0x${byte.toString(16).toUpperCase().padStart(2, "0")} is not ASCII${bom ? " (the input starts with a UTF-8 byte-order mark; remove it)" : "; Base64 text uses only ASCII characters"}`);
      } else {
        throw fail("invalid-character", `${printable(byte)} is not a Base64 character; the ${label} alphabet is ${settings.variant === "standard" ? "A-Z a-z 0-9 + /" : "A-Z a-z 0-9 - _"} with "=" padding`);
      }
      offset += 1;
      if (byte === 0x0a) { line += 1; column = 1; } else column += 1;
    }
  }
  check(context);
  let trailingBitsIgnored = false;
  if (pads > 0 && pads !== 4 - padStart) {
    throw fail("padding-incomplete", `input ends with ${pads} padding character${pads === 1 ? "" : "s"} but this group needs ${4 - padStart}; append ${"=".repeat(4 - padStart - pads)}`);
  }
  if (quadLength === 1) throw fail("length", `${significant.toLocaleString("en-US")} Base64 characters leave a single trailing character; the input is truncated or corrupted`);
  if (quadLength > 0 && pads === 0 && settings.padding === "required") {
    throw fail("padding-missing", `input ends without padding; ${quadLength === 2 ? '"=="' : '"="'} is required, or choose Optional or Omit padding to accept unpadded input`);
  }
  if (quadLength > 0) {
    const unusedBits = quadLength === 2 ? quad[1] & 15 : quad[2] & 3;
    if (unusedBits !== 0) {
      if (!lenient) throw fail("trailing-bits", `the final character ${printable(lastByte)} carries non-zero unused bits, so this is not canonical Base64; choose the tolerant policy to discard the extra bits`);
      trailingBitsIgnored = true;
    }
    out.ensure(quadLength - 1);
    const bytes = out.bytes;
    bytes[out.length++] = (quad[0] << 2) | (quad[1] >> 4);
    if (quadLength === 3) bytes[out.length++] = ((quad[1] & 15) << 4) | (quad[2] >> 2);
  }
  return { decoded: out.finish(), inputBytes, significant, pads, whitespace, trailingBitsIgnored };
}

function hexPreview(bytes) {
  const shown = bytes.subarray(0, HEX_PREVIEW_BYTES);
  const hex = Array.from(shown, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
  return bytes.length > shown.length ? `${hex} …` : hex;
}

export async function execute(request, context) {
  const settings = readOptions(request?.options ?? {});
  const base = { mode: settings.mode, variant: settings.variant, padding: settings.padding, errorPolicy: settings.errorPolicy };
  if (settings.mode === "encode") {
    const { output, inputBytes, padded } = await encodeStream(context, settings);
    const result = {
      ...base,
      contentKind: "text", mime: "text/plain; charset=us-ascii", utf8: true,
      text: asciiText(output), inputBytes, outputBytes: output.byteLength, padded, complete: true,
    };
    await context.writeValue("output", result);
    await context.write("output", output);
    return result;
  }
  const { decoded, inputBytes, significant, pads, whitespace, trailingBitsIgnored } = await decodeStream(context, settings);
  const parse = { significantCharacters: significant, paddingCharacters: pads, whitespaceIgnored: whitespace, trailingBitsIgnored };
  let text = null;
  let utf8 = true;
  try { text = strictUtf8.decode(decoded); } catch { utf8 = false; }
  let result;
  let output = decoded;
  if (utf8) {
    result = { ...base, contentKind: "text", mime: "text/plain; charset=utf-8", utf8: true, text, inputBytes, outputBytes: decoded.byteLength, decodedBytes: decoded.byteLength, ...parse, complete: true };
  } else if (settings.errorPolicy === "replace") {
    // The artifact is the replaced text, not the raw bytes: the user asked for
    // text, and the replacement count says how lossy that was.
    text = lossyUtf8.decode(decoded);
    let replacements = 0;
    for (const character of text) if (character === "�") replacements += 1;
    output = encoder.encode(text);
    result = { ...base, contentKind: "text", mime: "text/plain; charset=utf-8", utf8: false, replacements, text, inputBytes, outputBytes: output.byteLength, decodedBytes: decoded.byteLength, ...parse, complete: true };
  } else {
    result = { ...base, contentKind: "binary", mime: "application/octet-stream", utf8: false, text: null, hexPreview: hexPreview(decoded), inputBytes, outputBytes: decoded.byteLength, decodedBytes: decoded.byteLength, ...parse, complete: true };
  }
  await context.writeValue("output", result);
  await context.write("output", output);
  return result;
}
