import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";

/**
 * Reference JSON processor for `structured.json`.
 *
 * The grammar is RFC 8259 with no extensions. String and number lexemes are
 * copied from the source bytes verbatim, so `1.2300`, `12345678901234567890`,
 * `"\u00e9"` and `"\/"` survive format and minify exactly as written. Nothing
 * is ever routed through `JSON.parse` or JavaScript `Number`.
 *
 * Execution has two passes over the immutable input: a validating pass that
 * collects statistics and diagnostics and computes the exact output size, and
 * an emitting pass into a pre-sized buffer. Validation errors therefore always
 * take precedence over output limits, and no partial artifact is written.
 */

/** Maximum container nesting; matches MAX_DEPTH in the native streaming core. */
export const MAX_DEPTH = 256;
/** Chunk size requested from the SDK reader. */
export const READ_CHUNK_BYTES = 64 * 1024;
/** Bytes scanned between cooperative cancellation checks. */
export const CANCELLATION_STRIDE = 64 * 1024;
/** Cap on retained diagnostics per code; the remainder is counted, not stored. */
export const MAX_DIAGNOSTICS_PER_CODE = 100;
/** Spaces per indentation level in `format`; matches the native core. */
export const INDENT_WIDTH = 2;
export const OPERATIONS = Object.freeze(["format", "minify", "inspect"]);

const BOM = [0xef, 0xbb, 0xbf];
const MAX_SAFE_INTEGER_DIGITS = "9007199254740991";
const WHITESPACE = new Uint8Array(256);
for (const byte of [0x20, 0x09, 0x0a, 0x0d]) WHITESPACE[byte] = 1;
// ignoreBOM keeps a U+FEFF that appears inside a lexeme; the document BOM is handled separately.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Thrown for every structured failure; `diagnostic` carries the position when one exists. */
export class JsonError extends Error {
  constructor(diagnostic) {
    const where = diagnostic.offset === null ? "" : ` at line ${diagnostic.line}, column ${diagnostic.column} (byte ${diagnostic.offset})`;
    super(`${diagnostic.code}: ${diagnostic.message}${where}`);
    this.name = "JsonError";
    this.code = diagnostic.code;
    this.diagnostic = diagnostic;
  }
}

function cancellationCheck(context) {
  return () => { if (context.cancellation.isCancelled()) throw new ProcessorCancelled(); };
}

async function readInput(context) {
  const chunks = [];
  let length = 0;
  for await (const chunk of context.readChunks("input", READ_CHUNK_BYTES)) { chunks.push(chunk); length += chunk.byteLength; }
  if (chunks.length === 1) return chunks[0];
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function printable(byte) {
  if (byte >= 0x20 && byte < 0x7f) return `"${String.fromCharCode(byte)}"`;
  return `U+${byte.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Describes the (already UTF-8 validated) character starting at `offset` for a message. */
function describeAt(bytes, offset) {
  const lead = bytes[offset];
  if (lead < 0x80) return printable(lead);
  const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
  const text = utf8.decode(bytes.subarray(offset, offset + length));
  return `"${text}" (U+${text.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")})`;
}

/** Returns the byte offset of the first invalid UTF-8 sequence, or -1. Table 3-7 of the Unicode standard. */
export function findInvalidUtf8(bytes, start, end, check) {
  let next = start + CANCELLATION_STRIDE;
  for (let i = start; i < end;) {
    if (i >= next) { check?.(); next = i + CANCELLATION_STRIDE; }
    const lead = bytes[i];
    if (lead < 0x80) { i += 1; continue; }
    let need;
    let low = 0x80;
    let high = 0xbf;
    if (lead >= 0xc2 && lead <= 0xdf) need = 1;
    else if (lead === 0xe0) { need = 2; low = 0xa0; }
    else if ((lead >= 0xe1 && lead <= 0xec) || lead === 0xee || lead === 0xef) need = 2;
    else if (lead === 0xed) { need = 2; high = 0x9f; }
    else if (lead === 0xf0) { need = 3; low = 0x90; }
    else if (lead >= 0xf1 && lead <= 0xf3) need = 3;
    else if (lead === 0xf4) { need = 3; high = 0x8f; }
    else return i;
    if (i + need >= end) return i;
    const second = bytes[i + 1];
    if (second < low || second > high) return i;
    for (let k = 2; k <= need; k += 1) { const byte = bytes[i + k]; if (byte < 0x80 || byte > 0xbf) return i; }
    i += need + 1;
  }
  return -1;
}

/** Decodes a validated string lexeme (including quotes) to a JavaScript string. Used for member-name comparison only. */
export function decodeStringLexeme(bytes, start, end) {
  let out = "";
  let runStart = start + 1;
  const last = end - 1;
  for (let i = start + 1; i < last;) {
    const byte = bytes[i];
    if (byte !== 0x5c) { i += 1; continue; }
    if (i > runStart) out += utf8.decode(bytes.subarray(runStart, i));
    const escape = bytes[i + 1];
    switch (escape) {
      case 0x22: out += "\""; break;
      case 0x5c: out += "\\"; break;
      case 0x2f: out += "/"; break;
      case 0x62: out += "\b"; break;
      case 0x66: out += "\f"; break;
      case 0x6e: out += "\n"; break;
      case 0x72: out += "\r"; break;
      case 0x74: out += "\t"; break;
      case 0x75: out += String.fromCharCode(parseInt(utf8.decode(bytes.subarray(i + 2, i + 6)), 16)); i += 6; runStart = i; continue;
      default: throw new Error("decodeStringLexeme received an unvalidated escape");
    }
    i += 2; runStart = i;
  }
  if (last > runStart) out += utf8.decode(bytes.subarray(runStart, last));
  return out;
}

function isUnsafeIntegerLexeme(bytes, start, end) {
  const digitsStart = bytes[start] === 0x2d ? start + 1 : start;
  const digits = end - digitsStart;
  if (digits < MAX_SAFE_INTEGER_DIGITS.length) return false;
  if (digits > MAX_SAFE_INTEGER_DIGITS.length) return true;
  for (let i = 0; i < digits; i += 1) {
    const byte = bytes[digitsStart + i];
    const limit = MAX_SAFE_INTEGER_DIGITS.charCodeAt(i);
    if (byte !== limit) return byte > limit;
  }
  return false;
}

const EXPECT = Object.freeze({ VALUE: 0, VALUE_OR_CLOSE: 1, KEY_OR_CLOSE: 2, KEY: 3, COLON: 4, COMMA_OR_CLOSE: 5, END: 6 });

function expectation(expect, frame) {
  switch (expect) {
    case EXPECT.VALUE: return frame ? "expected a value" : "expected a JSON value";
    case EXPECT.VALUE_OR_CLOSE: return "expected a value or \"]\"";
    case EXPECT.KEY_OR_CLOSE: return "expected a member name or \"}\"";
    case EXPECT.KEY: return "expected a member name";
    case EXPECT.COLON: return "expected \":\" after the member name";
    case EXPECT.COMMA_OR_CLOSE: return frame.isObject ? "expected \",\" or \"}\"" : "expected \",\" or \"]\"";
    default: return "expected end of input";
  }
}

/**
 * Validating token walk over `bytes[start, end)`. Listeners receive lexeme
 * ranges, never decoded values. Throws a JsonError with an unresolved
 * position (offset only; line/column filled in by the caller).
 */
export function scanDocument(bytes, start, end, listeners, check) {
  const fail = (code, offset, spanEnd, message) => { throw new JsonError({ code, severity: "error", message, offset, end: Math.min(spanEnd, end), line: null, column: null }); };
  const stack = [];
  let expect = EXPECT.VALUE;
  let i = start;
  let nextCheck = start + CANCELLATION_STRIDE;
  const afterValue = () => { expect = stack.length === 0 ? EXPECT.END : EXPECT.COMMA_OR_CLOSE; };
  const open = (byte, offset) => {
    if (stack.length >= MAX_DEPTH) fail("json.depth-limit", offset, offset + 1, `nesting exceeds the maximum depth of ${MAX_DEPTH}`);
    const frame = { isObject: byte === 0x7b, count: 0, offset };
    stack.push(frame);
    for (const listener of listeners) listener.open(byte, stack.length, offset);
    expect = frame.isObject ? EXPECT.KEY_OR_CLOSE : EXPECT.VALUE_OR_CLOSE;
  };
  const close = (byte, offset) => {
    const frame = stack.pop();
    for (const listener of listeners) listener.close(byte, stack.length + 1, frame.count, offset);
    afterValue();
  };
  const item = (frame) => {
    for (const listener of listeners) listener.item(frame.count, stack.length, frame.isObject);
    frame.count += 1;
  };
  const scanString = (offset) => {
    let j = offset + 1;
    while (true) {
      if (j >= nextCheck) { check(); nextCheck = j + CANCELLATION_STRIDE; }
      if (j >= end) fail("json.unterminated-string", offset, end, "unterminated string");
      const byte = bytes[j];
      if (byte === 0x22) return j + 1;
      if (byte < 0x20) fail("json.control-character", j, j + 1, `control character ${printable(byte)} must be escaped inside a string`);
      if (byte !== 0x5c) { j += 1; continue; }
      if (j + 1 >= end) fail("json.unterminated-string", offset, end, "unterminated string");
      const escape = bytes[j + 1];
      if (escape === 0x75) {
        for (let k = 0; k < 4; k += 1) {
          const hex = j + 2 + k < end ? bytes[j + 2 + k] : -1;
          const isHex = (hex >= 0x30 && hex <= 0x39) || (hex >= 0x41 && hex <= 0x46) || (hex >= 0x61 && hex <= 0x66);
          if (!isHex) fail("json.invalid-escape", j, Math.min(j + 6, end), "invalid Unicode escape; expected \\u followed by four hexadecimal digits");
        }
        j += 6; continue;
      }
      if (escape === 0x22 || escape === 0x5c || escape === 0x2f || escape === 0x62 || escape === 0x66 || escape === 0x6e || escape === 0x72 || escape === 0x74) { j += 2; continue; }
      fail("json.invalid-escape", j, j + 2, `invalid escape sequence \\${escape >= 0x20 && escape < 0x7f ? String.fromCharCode(escape) : printable(escape)}`);
    }
  };
  const digits = (from) => {
    let j = from;
    while (j < end && bytes[j] >= 0x30 && bytes[j] <= 0x39) { j += 1; if (j >= nextCheck) { check(); nextCheck = j + CANCELLATION_STRIDE; } }
    return j;
  };
  const scanNumber = (offset) => {
    let j = offset;
    if (bytes[j] === 0x2d) j += 1;
    if (j >= end || bytes[j] < 0x30 || bytes[j] > 0x39) fail("json.invalid-number", offset, j + 1, "a digit is required after \"-\"");
    if (bytes[j] === 0x30) { j += 1; if (j < end && bytes[j] >= 0x30 && bytes[j] <= 0x39) fail("json.invalid-number", offset, j + 1, "leading zeros are not allowed"); }
    else j = digits(j);
    let integer = true;
    if (j < end && bytes[j] === 0x2e) {
      integer = false; j += 1;
      if (j >= end || bytes[j] < 0x30 || bytes[j] > 0x39) fail("json.invalid-number", offset, j + 1, "a digit is required after the decimal point");
      j = digits(j);
    }
    if (j < end && (bytes[j] === 0x65 || bytes[j] === 0x45)) {
      integer = false; j += 1;
      if (j < end && (bytes[j] === 0x2b || bytes[j] === 0x2d)) j += 1;
      if (j >= end || bytes[j] < 0x30 || bytes[j] > 0x39) fail("json.invalid-number", offset, j + 1, "a digit is required in the exponent");
      j = digits(j);
    }
    return { end: j, integer };
  };
  const scanLiteral = (offset, word) => {
    for (let k = 0; k < word.length; k += 1) if (bytes[offset + k] !== word.charCodeAt(k)) fail("json.invalid-literal", offset, Math.min(offset + word.length, end), `invalid literal; expected "${word}"`);
    return offset + word.length;
  };
  const value = (byte, offset) => {
    if (byte === 0x7b || byte === 0x5b) { open(byte, offset); return offset + 1; }
    let next;
    let kind;
    let integer = false;
    if (byte === 0x22) { next = scanString(offset); kind = "string"; }
    else if (byte === 0x2d || (byte >= 0x30 && byte <= 0x39)) { const number = scanNumber(offset); next = number.end; integer = number.integer; kind = "number"; }
    else if (byte === 0x74) { next = scanLiteral(offset, "true"); kind = "boolean"; }
    else if (byte === 0x66) { next = scanLiteral(offset, "false"); kind = "boolean"; }
    else if (byte === 0x6e) { next = scanLiteral(offset, "null"); kind = "null"; }
    else return -1;
    for (const listener of listeners) listener.scalar(kind, offset, next, integer, stack.length);
    afterValue();
    return next;
  };
  while (true) {
    while (i < end && WHITESPACE[bytes[i]]) i += 1;
    if (i >= nextCheck) { check(); nextCheck = i + CANCELLATION_STRIDE; }
    if (i >= end) {
      if (expect === EXPECT.END) return;
      if (stack.length === 0) fail("json.empty", i, i, "unexpected end of input; expected a JSON value");
      fail("json.unexpected-end", i, i, `unexpected end of input; ${expectation(expect, stack[stack.length - 1])}`);
    }
    const byte = bytes[i];
    const frame = stack[stack.length - 1];
    switch (expect) {
      case EXPECT.VALUE:
      case EXPECT.VALUE_OR_CLOSE: {
        if (byte === 0x5d && frame && !frame.isObject) {
          if (expect === EXPECT.VALUE) fail("json.trailing-comma", i, i + 1, "trailing comma before \"]\" is not allowed");
          close(byte, i); i += 1; break;
        }
        if (byte === 0x7d && frame && frame.isObject && expect === EXPECT.VALUE) fail("json.unexpected-token", i, i + 1, "unexpected \"}\"; expected a value after \":\"");
        if (frame && !frame.isObject) item(frame);
        const next = value(byte, i);
        if (next < 0) fail("json.unexpected-token", i, i + 1, `unexpected character ${describeAt(bytes, i)}; ${expectation(expect, frame)}`);
        i = next; break;
      }
      case EXPECT.KEY_OR_CLOSE:
      case EXPECT.KEY: {
        if (byte === 0x7d) {
          if (expect === EXPECT.KEY) fail("json.trailing-comma", i, i + 1, "trailing comma before \"}\" is not allowed");
          close(byte, i); i += 1; break;
        }
        if (byte !== 0x22) fail("json.unexpected-token", i, i + 1, `unexpected character ${describeAt(bytes, i)}; ${expectation(expect, frame)}`);
        item(frame);
        const next = scanString(i);
        for (const listener of listeners) listener.key(i, next, stack.length);
        expect = EXPECT.COLON; i = next; break;
      }
      case EXPECT.COLON:
        if (byte !== 0x3a) fail("json.unexpected-token", i, i + 1, `unexpected character ${describeAt(bytes, i)}; ${expectation(expect, frame)}`);
        expect = EXPECT.VALUE; i += 1; break;
      case EXPECT.COMMA_OR_CLOSE:
        if (byte === 0x2c) { expect = frame.isObject ? EXPECT.KEY : EXPECT.VALUE; i += 1; break; }
        if (byte === (frame.isObject ? 0x7d : 0x5d)) { close(byte, i); i += 1; break; }
        fail("json.unexpected-token", i, i + 1, `unexpected character ${describeAt(bytes, i)}; ${expectation(expect, frame)}`);
        break;
      default:
        fail("json.trailing-content", i, end, `unexpected content after the top-level value; ${describeAt(bytes, i)} was found where end of input was expected`);
    }
  }
}

/** Emits format/minify output through a byte sink; used once to count and once to write. */
class Layout {
  constructor(pretty, sink) { this.pretty = pretty; this.sink = sink; }
  indent(depth) { this.sink.byte(0x0a); this.sink.repeat(0x20, depth * INDENT_WIDTH); }
  open(byte) { this.sink.byte(byte); }
  item(index, depth) {
    if (this.pretty) { if (index > 0) this.sink.byte(0x2c); this.indent(depth); }
    else if (index > 0) this.sink.byte(0x2c);
  }
  key(start, end) { this.sink.range(start, end); this.sink.byte(0x3a); if (this.pretty) this.sink.byte(0x20); }
  scalar(_kind, start, end) { this.sink.range(start, end); }
  close(byte, depth, count) { if (this.pretty && count > 0) this.indent(depth - 1); this.sink.byte(byte); }
}
class CountingSink {
  constructor() { this.length = 0; }
  byte() { this.length += 1; }
  repeat(_byte, count) { this.length += count; }
  range(start, end) { this.length += end - start; }
}
class BufferSink {
  constructor(source, size) { this.source = source; this.out = new Uint8Array(size); this.position = 0; }
  byte(byte) { this.out[this.position++] = byte; }
  repeat(byte, count) { this.out.fill(byte, this.position, this.position + count); this.position += count; }
  range(start, end) {
    const length = end - start;
    if (length > 16) { this.out.set(this.source.subarray(start, end), this.position); this.position += length; return; }
    for (let i = start; i < end; i += 1) this.out[this.position++] = this.source[i];
  }
}

/** Collects statistics and non-fatal diagnostics during the validating pass. */
class Collector {
  constructor(bytes) {
    this.bytes = bytes;
    this.keys = [];
    this.topLevel = null;
    this.maxDepth = 0;
    this.counts = { objects: 0, arrays: 0, members: 0, elements: 0, strings: 0, numbers: 0, booleans: 0, nulls: 0 };
    this.numbers = { integers: 0, unsafeIntegers: 0, withFractionOrExponent: 0 };
    this.diagnostics = [];
    this.suppressed = 0;
    this.perCode = new Map();
    this.duplicateKeys = 0;
  }
  report(diagnostic) {
    const seen = (this.perCode.get(diagnostic.code) ?? 0) + 1;
    this.perCode.set(diagnostic.code, seen);
    if (seen > MAX_DIAGNOSTICS_PER_CODE) { this.suppressed += 1; return; }
    this.diagnostics.push(diagnostic);
  }
  open(byte, depth) {
    const isObject = byte === 0x7b;
    if (depth === 1) this.topLevel = isObject ? "object" : "array";
    if (depth > this.maxDepth) this.maxDepth = depth;
    if (isObject) this.counts.objects += 1; else this.counts.arrays += 1;
    this.keys.push(isObject ? new Map() : null);
  }
  item(_index, _depth, isObject) { if (isObject) this.counts.members += 1; else this.counts.elements += 1; }
  key(start, end) {
    const names = this.keys[this.keys.length - 1];
    const name = decodeStringLexeme(this.bytes, start, end);
    const first = names.get(name);
    if (first === undefined) { names.set(name, [start, end]); return; }
    this.duplicateKeys += 1;
    this.report({ code: "json.duplicate-key", severity: "warning", message: `duplicate member name ${JSON.stringify(name)}; format and minify keep both, JSON.parse consumers keep the last value`, offset: start, end, line: null, column: null, related: [{ message: "first occurrence", offset: first[0], end: first[1], line: null, column: null }] });
  }
  scalar(kind, start, end, integer, depth) {
    if (depth === 0) this.topLevel = kind;
    if (kind === "string") this.counts.strings += 1;
    else if (kind === "boolean") this.counts.booleans += 1;
    else if (kind === "null") this.counts.nulls += 1;
    else {
      this.counts.numbers += 1;
      if (!integer) { this.numbers.withFractionOrExponent += 1; return; }
      this.numbers.integers += 1;
      if (!isUnsafeIntegerLexeme(this.bytes, start, end)) return;
      this.numbers.unsafeIntegers += 1;
      this.report({ code: "json.unsafe-integer", severity: "info", message: "integer is outside the IEEE 754 safe range; it is preserved verbatim here but JavaScript Number consumers would round it", offset: start, end, line: null, column: null });
    }
  }
  close() { this.keys.pop(); }
}

/** Fills line/column for every span in one sweep. Offsets are bytes; columns count code points and skip the BOM. */
export function resolvePositions(bytes, contentStart, diagnostics) {
  const spans = [];
  for (const diagnostic of diagnostics) { if (diagnostic.offset !== null) spans.push(diagnostic); for (const related of diagnostic.related ?? []) spans.push(related); }
  spans.sort((a, b) => a.offset - b.offset);
  let line = 1;
  let column = 1;
  let i = contentStart;
  for (const span of spans) {
    if (span.offset < contentStart) { span.line = 1; span.column = 1; continue; }
    while (i < span.offset) {
      const byte = bytes[i];
      i += 1;
      if (byte === 0x0a) { line += 1; column = 1; }
      else if (byte === 0x0d) { if (i < span.offset && bytes[i] === 0x0a) i += 1; line += 1; column = 1; }
      else if ((byte & 0xc0) !== 0x80) column += 1;
    }
    span.line = line; span.column = column;
  }
  return diagnostics;
}

function baseSummary(operation, bytes, contentStart, context) {
  return {
    valid: false, complete: true, operation, encoding: "utf-8", bom: contentStart > 0,
    inputBytes: bytes.byteLength, contentBytes: bytes.byteLength - contentStart,
    topLevel: null, maxDepth: null, counts: null, numbers: null, duplicateKeys: null,
    formattedBytes: null, minifiedBytes: null, outputBytes: null,
    diagnostics: [], suppressedDiagnostics: 0,
    limits: { maxDepth: MAX_DEPTH, maxInputBytes: context.limits.maxInputBytes, maxOutputBytes: outputCap(context), maxDiagnosticsPerCode: MAX_DIAGNOSTICS_PER_CODE },
    policy: { grammar: "RFC 8259", strings: "lexeme-preserving", numbers: "lexeme-preserving", duplicateKeys: "preserve-and-report", bom: "strip-and-report", indent: `${INDENT_WIDTH} spaces` },
  };
}

/** One artifact per port: the SDK sink caps a single write at maxChunkBytes. */
function outputCap(context) { return Math.min(context.limits.maxOutputBytes, context.limits.maxChunkBytes); }

/** Validating pass. Returns a summary whose `valid` flag decides whether an artifact can be produced. */
export function analyze(bytes, operation, context) {
  const check = cancellationCheck(context);
  const contentStart = bytes.byteLength >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2] ? 3 : 0;
  const summary = baseSummary(operation, bytes, contentStart, context);
  const informational = [];
  if (contentStart > 0) informational.push({ code: "json.bom", severity: "info", message: "input starts with a UTF-8 byte order mark; it is not part of the JSON value and is not copied to the output", offset: 0, end: 3, line: null, column: null });
  const finish = (error, collector) => {
    const diagnostics = [...informational, ...(collector?.diagnostics ?? [])];
    if (error) diagnostics.push(error);
    diagnostics.sort((a, b) => (a.offset ?? -1) - (b.offset ?? -1));
    resolvePositions(bytes, contentStart, diagnostics);
    summary.diagnostics = diagnostics;
    summary.suppressedDiagnostics = collector?.suppressed ?? 0;
    if (error) return summary;
    summary.valid = true;
    summary.topLevel = collector.topLevel; summary.maxDepth = collector.maxDepth;
    summary.counts = collector.counts; summary.numbers = collector.numbers; summary.duplicateKeys = collector.duplicateKeys;
    return summary;
  };
  if (bytes.byteLength >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)))
    return finish({ code: "json.unsupported-encoding", severity: "error", message: "input starts with a UTF-16 byte order mark; only UTF-8 is supported", offset: 0, end: 2, line: null, column: null });
  const invalid = findInvalidUtf8(bytes, contentStart, bytes.byteLength, check);
  if (invalid >= 0) return finish({ code: "json.invalid-utf8", severity: "error", message: `invalid UTF-8 sequence starting with byte 0x${bytes[invalid].toString(16).toUpperCase().padStart(2, "0")}`, offset: invalid, end: invalid + 1, line: null, column: null });
  const collector = new Collector(bytes);
  const pretty = new CountingSink();
  const compact = new CountingSink();
  try { scanDocument(bytes, contentStart, bytes.byteLength, [collector, new Layout(true, pretty), new Layout(false, compact)], check); }
  catch (error) { if (error instanceof JsonError) return finish(error.diagnostic, collector); throw error; }
  summary.formattedBytes = pretty.length;
  summary.minifiedBytes = compact.length;
  return finish(null, collector);
}

/** Emitting pass into an exact-size buffer; the source is never modified. */
export function render(bytes, contentStart, pretty, size, check) {
  const sink = new BufferSink(bytes, size);
  scanDocument(bytes, contentStart, bytes.byteLength, [new Layout(pretty, sink)], check);
  if (sink.position !== size) throw new Error(`internal error: rendered ${sink.position} bytes but expected ${size}`);
  return sink.out;
}

export async function execute(request, context) {
  const operation = request?.operationId ?? "format";
  if (!OPERATIONS.includes(operation)) throw new Error(`unsupported operation ${operation}`);
  cancellationCheck(context)();
  const bytes = await readInput(context);
  const summary = analyze(bytes, operation, context);
  if (operation === "inspect") { await context.writeValue("output", summary); return summary; }
  if (!summary.valid) throw new JsonError(summary.diagnostics.find((item) => item.severity === "error"));
  const pretty = operation === "format";
  const size = pretty ? summary.formattedBytes : summary.minifiedBytes;
  const cap = outputCap(context);
  if (size > cap) throw new JsonError({ code: "json.output-limit", severity: "error", message: `${operation} output would be ${size} bytes, above the ${cap} byte output limit; the SDK sink accepts one chunk per artifact so the result is rejected rather than truncated`, offset: null, end: null, line: null, column: null });
  const output = render(bytes, summary.bom ? 3 : 0, pretty, size, cancellationCheck(context));
  summary.outputBytes = size;
  await context.writeValue("output", summary);
  await context.write("output", output);
  return summary;
}
