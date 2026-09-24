import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";
import { JsonError, decodeStringLexeme, findInvalidUtf8, resolvePositions, scanDocument } from "../json/processor.mjs";

/**
 * `convert.yaml`: a hand-written, dependency-free parser for a YAML 1.2 core
 * subset (see README) and a matching JSON -> YAML emitter. No construct
 * outside the documented subset is silently accepted: every rejection names
 * the construct and carries a byte/line/column position, in the same shape
 * `plugins/json` uses for its diagnostics.
 *
 * `convert.json-yaml` parses its JSON input with `plugins/json`'s own
 * `scanDocument` tokenizer so both packages share one JSON grammar and one
 * definition of "exact number".
 */

export const OPERATIONS = Object.freeze(["convert.yaml-json", "convert.json-yaml"]);
export const CANCELLATION_STRIDE_LINES = 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_SAFE = 9007199254740991n;
const MIN_SAFE = -9007199254740991n;

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

export class YamlError extends Error {
  constructor(diagnostic) {
    const where = diagnostic.offset === null || diagnostic.offset === undefined ? "" : ` at line ${diagnostic.line}, column ${diagnostic.column} (byte ${diagnostic.offset})`;
    super(`${diagnostic.code}: ${diagnostic.message}${where}`);
    this.name = "YamlError";
    this.code = diagnostic.code;
    this.diagnostic = diagnostic;
  }
}

function fail(code, offset, end, message, related) {
  throw new YamlError({ code, severity: "error", message, offset, end, line: null, column: null, related });
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

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export class OptionError extends Error {
  constructor(message, data) { super(message); this.name = "OptionError"; this.code = "yaml.invalid-option"; this.diagnostic = { code: "yaml.invalid-option", severity: "error", message, offset: null, end: null, line: null, column: null, data }; }
}

// EnumChoice ids in the contract schema must start with a letter, so the indent option's choice
// ids are `space2`/`space4`/`minified` rather than the bare numbers a caller might expect.
const YAML_JSON_INDENTS = { space2: 2, space4: 4, minified: 0 };
const JSON_YAML_INDENTS = { space2: 2, space4: 4 };

export function normalizeYamlJsonOptions(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new OptionError("options must be an object", { received: Array.isArray(raw) ? "array" : typeof raw });
  const known = new Set(["indent", "sort-keys"]);
  for (const key of Object.keys(raw)) if (!known.has(key)) throw new OptionError(`unknown option ${key}`, { option: key, known: [...known] });
  const indentRaw = raw.indent === undefined ? "space2" : raw.indent;
  if (!Object.hasOwn(YAML_JSON_INDENTS, indentRaw)) throw new OptionError("indent must be one of space2, space4, minified", { option: "indent", received: indentRaw });
  const sortKeys = raw["sort-keys"] === undefined ? false : raw["sort-keys"];
  if (typeof sortKeys !== "boolean") throw new OptionError("sort-keys must be a boolean", { option: "sort-keys", received: typeof sortKeys });
  return { indent: YAML_JSON_INDENTS[indentRaw], sortKeys };
}

export function normalizeJsonYamlOptions(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new OptionError("options must be an object", { received: Array.isArray(raw) ? "array" : typeof raw });
  const known = new Set(["indent"]);
  for (const key of Object.keys(raw)) if (!known.has(key)) throw new OptionError(`unknown option ${key}`, { option: key, known: [...known] });
  const indentRaw = raw.indent === undefined ? "space2" : raw.indent;
  if (!Object.hasOwn(JSON_YAML_INDENTS, indentRaw)) throw new OptionError("indent must be one of space2, space4", { option: "indent", received: indentRaw });
  return { indent: JSON_YAML_INDENTS[indentRaw] };
}

// ---------------------------------------------------------------------------
// Byte/text helpers
// ---------------------------------------------------------------------------

class TextBuilder {
  constructor() { this.parts = []; }
  text(bytes, start, end) { if (end > start) this.parts.push(utf8.decode(bytes.subarray(start, end))); }
  raw(str) { if (str) this.parts.push(str); }
  build() { return this.parts.join(""); }
}

function isSpaceOrTab(byte) { return byte === 0x20 || byte === 0x09; }

/** Consumes one or more line breaks (and surrounding blank-line whitespace) starting at `i`; folds per YAML 1.2. */
function consumeLineBreaks(bytes, i) {
  let newlines = 0;
  let j = i;
  while (j < bytes.length) {
    if (bytes[j] === 0x0d && bytes[j + 1] === 0x0a) { newlines += 1; j += 2; }
    else if (bytes[j] === 0x0a) { newlines += 1; j += 1; }
    else if (isSpaceOrTab(bytes[j])) { j += 1; }
    else break;
  }
  return { text: newlines <= 1 ? " " : "\n".repeat(newlines - 1), next: j };
}

// ---------------------------------------------------------------------------
// Line index
// ---------------------------------------------------------------------------

/** One entry per physical line of the document. Indentation is measured in leading spaces only; a leading tab is flagged. */
function splitLines(bytes) {
  const lines = [];
  let start = 0;
  for (let i = 0; i <= bytes.length; i += 1) {
    if (i === bytes.length || bytes[i] === 0x0a) {
      let end = i;
      const hasEol = i < bytes.length;
      if (end > start && bytes[end - 1] === 0x0d) end -= 1;
      let indent = 0;
      let contentStart = start;
      let hasTab = false;
      while (contentStart < end && isSpaceOrTab(bytes[contentStart])) {
        if (bytes[contentStart] === 0x09) hasTab = true;
        else indent += 1;
        contentStart += 1;
      }
      const isComment = contentStart < end && bytes[contentStart] === 0x23;
      const isBlank = contentStart === end || isComment;
      lines.push({ start, end, indent, contentStart, hasTab: hasTab && !isBlank, isBlank, hasEol, lineNumber: lines.length + 1 });
      start = i + 1;
      if (!hasEol) break;
    }
  }
  return lines;
}

/** Byte offset of a `#` that starts a comment (preceded by start-of-content or whitespace), or `end` if none. */
function findCommentCutoff(bytes, start, end) {
  let i = start;
  let prevSpace = true;
  while (i < end) {
    const byte = bytes[i];
    if (byte === 0x23 && prevSpace) return i;
    prevSpace = isSpaceOrTab(byte);
    i += 1;
  }
  return end;
}

function trimTrailing(bytes, start, end) {
  let e = end;
  while (e > start && isSpaceOrTab(bytes[e - 1])) e -= 1;
  return e;
}

// ---------------------------------------------------------------------------
// Scalar typing (YAML 1.2 core schema); quoted scalars never reach this.
// ---------------------------------------------------------------------------

const RE_INT_DEC = /^[-+]?[0-9]+$/;
// The core schema's hex and octal forms take no sign: `-0x1F` is a string (YAML 1.2.2 §10.3.2).
const RE_INT_HEX = /^0x[0-9a-fA-F]+$/;
const RE_INT_OCT = /^0o[0-7]+$/;
// Three spellings each, as the core schema lists them; `.iNf` is a string.
const RE_INF = /^[-+]?(?:\.inf|\.Inf|\.INF)$/;
const RE_NAN = /^(?:\.nan|\.NaN|\.NAN)$/;
const RE_FLOAT = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;

function makeInt(text) {
  let body = text;
  let negative = false;
  let radix = 10;
  if (body[0] === "-") { negative = true; body = body.slice(1); } else if (body[0] === "+") body = body.slice(1);
  if (body.startsWith("0x")) { radix = 16; body = body.slice(2); } else if (body.startsWith("0o")) { radix = 8; body = body.slice(2); }
  let big = radix === 10 ? BigInt(body) : BigInt(`${radix === 16 ? "0x" : "0o"}${body}`);
  if (negative) big = -big;
  const unsafe = big > MAX_SAFE || big < MIN_SAFE;
  return { t: "int", decimal: big.toString(10), unsafe };
}

/** Strips leading zeros from a digit string, keeping at least one digit (JSON forbids a leading zero before more digits). */
function stripLeadingZeros(digits) {
  let i = 0;
  while (i < digits.length - 1 && digits[i] === "0") i += 1;
  return digits.slice(i);
}

function normalizeFloat(text) {
  let sign = "";
  let body = text;
  if (body[0] === "+") body = body.slice(1);
  else if (body[0] === "-") { sign = "-"; body = body.slice(1); }
  const [mantissa, exp] = body.split(/[eE]/);
  let [intPart, fracPart] = mantissa.split(".");
  const hasDot = mantissa.includes(".");
  if (!intPart) intPart = "0";
  if (hasDot && !fracPart) fracPart = "0";
  intPart = stripLeadingZeros(intPart);
  let out = intPart + (hasDot ? `.${fracPart}` : "");
  if (exp !== undefined) out += `e${exp === "" ? "0" : exp}`;
  return sign + out;
}

/** Classifies a plain (unquoted) scalar's text per the YAML 1.2 core schema. */
export function classifyPlainScalar(text) {
  if (text === "" || /^(?:null|Null|NULL|~)$/.test(text)) return { t: "null" };
  if (/^(?:true|True|TRUE)$/.test(text)) return { t: "bool", v: true };
  if (/^(?:false|False|FALSE)$/.test(text)) return { t: "bool", v: false };
  if (RE_INT_DEC.test(text) || RE_INT_HEX.test(text) || RE_INT_OCT.test(text)) return makeInt(text);
  if (RE_INF.test(text)) return { t: "floatSpecial", kind: text.startsWith("-") ? "-inf" : "inf" };
  if (RE_NAN.test(text)) return { t: "floatSpecial", kind: "nan" };
  if (RE_FLOAT.test(text) && /[.eE]/.test(text)) return { t: "float", text: normalizeFloat(text) };
  return { t: "str", v: text };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const LEAD_ERRORS = {
  0x26: ["yaml.anchor-unsupported", "anchors (&) are not supported"],
  0x2a: ["yaml.alias-unsupported", "aliases (*) are not supported"],
  0x21: ["yaml.tag-unsupported", "tags (!) are not supported"],
  0x25: ["yaml.directive-unsupported", "directives (%) are not supported"],
  0x3f: ["yaml.complex-key-unsupported", "complex keys (?) are not supported"],
};

class Parser {
  constructor(bytes, check) {
    this.bytes = bytes;
    this.lines = splitLines(bytes);
    this.li = 0;
    this.check = check;
    this.diagnostics = [];
    this.keys = 0;
    this.items = 0;
    this.stride = 0;
  }

  tick() { this.stride += 1; if ((this.stride & (CANCELLATION_STRIDE_LINES - 1)) === 0) this.check(); }

  /** Advances past blank/comment lines. */
  skipBlank() { while (this.li < this.lines.length && this.lines[this.li].isBlank) { this.tick(); this.li += 1; } }

  current() { return this.li < this.lines.length ? this.lines[this.li] : null; }

  rejectLead(line, offset) {
    const byte = this.bytes[offset];
    const entry = LEAD_ERRORS[byte];
    if (entry) fail(entry[0], offset, offset + 1, entry[1]);
  }

  /** True when a top-level, unquoted `:` (mapping-key indicator) exists on this line at/after `offset`. Returns its position or -1. */
  findKeyColon(line, offset) {
    const bytes = this.bytes;
    let i = offset;
    if (bytes[i] === 0x22 || bytes[i] === 0x27) {
      const quote = bytes[i] === 0x22 ? 0x22 : 0x27;
      let j = i + 1;
      while (j < line.end) {
        if (bytes[j] === quote) {
          if (quote === 0x27 && bytes[j + 1] === 0x27) { j += 2; continue; }
          j += 1;
          break;
        }
        if (bytes[j] === 0x5c && quote === 0x22) { j += 2; continue; }
        j += 1;
      }
      if (j > line.end || bytes[j - 1] !== quote) return -1;
      while (j < line.end && isSpaceOrTab(bytes[j])) j += 1;
      if (j < line.end && bytes[j] === 0x3a && (j + 1 === line.end || isSpaceOrTab(bytes[j + 1]))) return j;
      return -1;
    }
    while (i < line.end) {
      const byte = bytes[i];
      if (byte === 0x23 && (i === offset || isSpaceOrTab(bytes[i - 1]))) return -1;
      if (byte === 0x3a && (i + 1 === line.end || isSpaceOrTab(bytes[i + 1]))) return i;
      i += 1;
    }
    return -1;
  }

  /** Parses exactly one key at (line, offset); returns { key, keyStart, keyEnd, colon }. */
  readKey(line, offset, colon) {
    const bytes = this.bytes;
    if (bytes[offset] === 0x22) { const q = this.parseDoubleQuoted(offset); return { key: q.value, keyStart: offset, keyEnd: q.end, colon }; }
    if (bytes[offset] === 0x27) { const q = this.parseSingleQuoted(offset); return { key: q.value, keyStart: offset, keyEnd: q.end, colon }; }
    const keyEnd = trimTrailing(bytes, offset, colon);
    return { key: utf8.decode(bytes.subarray(offset, keyEnd)), keyStart: offset, keyEnd: colon, colon };
  }

  /** Parses one full mapping entry starting at (lineIndex, offset); does not require the entry's line to be the parser's current line. */
  readEntry(lineIndex, offset) {
    const line = this.lines[lineIndex];
    this.li = lineIndex;
    this.rejectLead(line, offset);
    const colon = this.findKeyColon(line, offset);
    if (colon < 0) fail("yaml.unexpected-token", offset, line.end, "expected a mapping key (\"key:\") or a sequence item (\"- \")");
    const key = this.readKey(line, offset, colon);
    let valuePos = colon + 1;
    while (valuePos < line.end && isSpaceOrTab(this.bytes[valuePos])) valuePos += 1;
    const commentAt = findCommentCutoff(this.bytes, valuePos, line.end);
    const inlineEnd = trimTrailing(this.bytes, valuePos, commentAt);
    const keyCol = key.keyStart - line.start;
    let value;
    if (inlineEnd > valuePos) {
      value = this.parseInlineNode(lineIndex, valuePos, keyCol);
    } else {
      this.li = lineIndex + 1;
      value = this.parseMappingValueBody(keyCol);
    }
    return { key: key.key, keyStart: key.keyStart, keyEnd: key.keyEnd, value };
  }

  /** The (possibly absent) nested value of `key:` when nothing follows the colon on its line. */
  parseMappingValueBody(keyCol) {
    this.skipBlank();
    const next = this.current();
    if (!next) return { t: "null" };
    if (next.indent > keyCol) return this.parseNode(keyCol + 1);
    if (next.indent === keyCol && this.isSequenceMarker(next)) return this.parseSequence(keyCol);
    return { t: "null" };
  }

  isSequenceMarker(line) {
    const bytes = this.bytes;
    const at = line.contentStart;
    if (bytes[at] !== 0x2d) return false;
    return at + 1 === line.end || isSpaceOrTab(bytes[at + 1]);
  }

  isDocMarker(line) {
    const text = utf8.decode(this.bytes.subarray(line.contentStart, line.end)).trimEnd();
    return text === "---" || text.startsWith("--- ") || text === "..." ;
  }

  /** Parses a node whose column must be `>= minIndent`; returns `{ t: 'null' }` when none is present. */
  parseNode(minIndent) {
    this.skipBlank();
    const line = this.current();
    if (!line || line.indent < minIndent) return { t: "null" };
    if (this.isDocMarker(line)) return { t: "null" };
    if (line.hasTab) fail("yaml.tab-indentation", line.start, line.contentStart, "tabs cannot be used for indentation");
    const col = line.indent;
    this.rejectLead(line, line.contentStart);
    if (this.isSequenceMarker(line)) return this.parseSequence(col);
    const colon = this.findKeyColon(line, line.contentStart);
    if (colon >= 0) return this.parseMapping(col);
    return this.parseInlineNode(this.li, line.contentStart, col);
  }

  parseMapping(col) {
    const entries = [];
    const seen = new Map();
    this.mappingLoop(col, entries, seen);
    return { t: "map", entries };
  }

  /** Parses a mapping whose first key:value pair was already read inline (right after a sequence dash). */
  parseMappingSeeded(col, firstEntry) {
    const entries = [];
    const seen = new Map();
    this.addEntry(entries, seen, firstEntry);
    this.mappingLoop(col, entries, seen);
    return { t: "map", entries };
  }

  mappingLoop(col, entries, seen) {
    while (true) {
      this.skipBlank();
      const line = this.current();
      if (!line || line.indent < col || this.isDocMarker(line)) break;
      if (line.indent > col) fail("yaml.bad-indentation", line.start, line.contentStart, `inconsistent indentation; expected column ${col + 1}`);
      if (line.hasTab) fail("yaml.tab-indentation", line.start, line.contentStart, "tabs cannot be used for indentation");
      if (this.isSequenceMarker(line)) fail("yaml.bad-indentation", line.start, line.contentStart, "a sequence item cannot appear where a mapping key was expected");
      this.tick();
      const entry = this.readEntry(this.li, line.contentStart);
      this.addEntry(entries, seen, entry);
    }
  }

  addEntry(entries, seen, entry) {
    this.keys += 1;
    const prior = seen.get(entry.key);
    if (prior) fail("yaml.duplicate-key", entry.keyStart, entry.keyEnd, `duplicate mapping key ${JSON.stringify(entry.key)}`, [{ message: "first occurrence", offset: prior.keyStart, end: prior.keyEnd, line: null, column: null }]);
    seen.set(entry.key, entry);
    entries.push(entry);
  }

  parseSequence(col) {
    const items = [];
    while (true) {
      this.skipBlank();
      const line = this.current();
      if (!line || line.indent < col || this.isDocMarker(line)) break;
      if (line.indent > col) fail("yaml.bad-indentation", line.start, line.contentStart, `inconsistent indentation; expected column ${col + 1}`);
      // A same-column line that isn't a dash ends a sequence written compactly under its
      // parent mapping key (same column as the key); the caller re-examines this line.
      if (!this.isSequenceMarker(line)) break;
      if (line.hasTab) fail("yaml.tab-indentation", line.start, line.contentStart, "tabs cannot be used for indentation");
      this.tick();
      const dashAt = line.contentStart;
      this.rejectLead(line, dashAt);
      let pos = dashAt + 1;
      while (pos < line.end && isSpaceOrTab(this.bytes[pos])) pos += 1;
      const commentAt = findCommentCutoff(this.bytes, pos, line.end);
      const inlineEnd = trimTrailing(this.bytes, pos, commentAt);
      let value;
      if (inlineEnd > pos) {
        const itemCol = pos - line.start;
        const colon = this.findKeyColon(line, pos);
        if (this.isSequenceMarker({ contentStart: pos, end: line.end })) fail("yaml.unexpected-token", pos, line.end, "a sequence item cannot start inline after \"- \"");
        if (colon >= 0) { const first = this.readEntry(this.li, pos); value = this.parseMappingSeeded(itemCol, first); }
        else value = this.parseInlineNode(this.li, pos, itemCol);
      } else {
        this.li += 1;
        value = this.parseNode(col + 1);
      }
      this.items += 1;
      items.push(value);
    }
    return { t: "seq", items };
  }

  /** Parses one node (quoted, flow, block scalar, or plain-with-folding) starting mid-line at (lineIndex, offset). */
  parseInlineNode(lineIndex, offset, parentMinIndent) {
    this.li = lineIndex;
    const line = this.lines[lineIndex];
    const minIndent = parentMinIndent ?? line.indent;
    this.rejectLead(line, offset);
    const byte = this.bytes[offset];
    if (byte === 0x22) { const r = this.parseDoubleQuoted(offset); this.advanceTo(r.end); return { t: "str", v: r.value }; }
    if (byte === 0x27) { const r = this.parseSingleQuoted(offset); this.advanceTo(r.end); return { t: "str", v: r.value }; }
    if (byte === 0x7b) { const r = this.parseFlowMapping(offset); this.advanceTo(r.end); return r.value; }
    if (byte === 0x5b) { const r = this.parseFlowSequence(offset); this.advanceTo(r.end); return r.value; }
    if (byte === 0x7c || byte === 0x3e) return this.parseBlockScalar(lineIndex, offset, minIndent);
    return this.parsePlainScalar(lineIndex, offset, minIndent);
  }

  /** Points the line cursor at the first line not yet consumed by an absolute byte offset a sub-parser reached. */
  advanceTo(endOffset) {
    let lo = 0;
    let hi = this.lines.length - 1;
    let found = this.lines.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (endOffset <= this.lines[mid].end) { found = mid; hi = mid - 1; } else lo = mid + 1;
    }
    this.li = found + 1;
  }

  parsePlainScalar(lineIndex, offset, parentMinIndent) {
    const bytes = this.bytes;
    let line = this.lines[lineIndex];
    const commentAt = findCommentCutoff(bytes, offset, line.end);
    let contentEnd = trimTrailing(bytes, offset, commentAt);
    const builder = new TextBuilder();
    builder.text(bytes, offset, contentEnd);
    let li = lineIndex;
    while (true) {
      let blankRun = 0;
      let probe = li + 1;
      while (probe < this.lines.length && this.lines[probe].isBlank) { blankRun += 1; probe += 1; }
      if (probe >= this.lines.length) { li = probe - blankRun - 1; break; }
      const cand = this.lines[probe];
      if (cand.indent <= parentMinIndent || this.isDocMarker(cand) || this.isSequenceMarker(cand) || this.findKeyColon(cand, cand.contentStart) >= 0) { li = probe - blankRun - 1; break; }
      if (cand.hasTab) fail("yaml.tab-indentation", cand.start, cand.contentStart, "tabs cannot be used for indentation");
      this.tick();
      builder.raw(blankRun === 0 ? " " : "\n".repeat(blankRun));
      const candCommentAt = findCommentCutoff(bytes, cand.contentStart, cand.end);
      const candEnd = trimTrailing(bytes, cand.contentStart, candCommentAt);
      builder.text(bytes, cand.contentStart, candEnd);
      li = probe;
    }
    this.li = li + 1;
    const text = builder.build();
    const typed = classifyPlainScalar(text);
    if (typed.t === "int" && typed.unsafe) this.diagnostics.push({ code: "yaml.unsafe-integer", severity: "info", message: `integer ${typed.decimal} is outside the IEEE 754 safe range and is emitted as a JSON string`, offset, end: contentEnd, line: null, column: null });
    if (typed.t === "floatSpecial") this.diagnostics.push({ code: "yaml.float-special", severity: "info", message: `${typed.kind === "nan" ? ".nan" : typed.kind === "-inf" ? "-.inf" : ".inf"} has no JSON representation and is emitted as null`, offset, end: contentEnd, line: null, column: null });
    return typed;
  }

  // -- Quoted scalars (may span physical lines) ----------------------------

  parseSingleQuoted(openOffset) {
    const bytes = this.bytes;
    let i = openOffset + 1;
    const builder = new TextBuilder();
    let runStart = i;
    while (true) {
      if (i >= bytes.length) fail("yaml.unterminated-string", openOffset, bytes.length, "unterminated single-quoted scalar");
      const byte = bytes[i];
      if (byte === 0x27) {
        if (bytes[i + 1] === 0x27) { builder.text(bytes, runStart, i + 1); i += 2; runStart = i; continue; }
        builder.text(bytes, runStart, i);
        return { value: builder.build(), end: i + 1 };
      }
      if (byte === 0x0a || byte === 0x0d) {
        builder.text(bytes, runStart, i);
        const folded = consumeLineBreaks(bytes, i);
        builder.raw(folded.text);
        i = folded.next;
        runStart = i;
        continue;
      }
      i += 1;
    }
  }

  parseDoubleQuoted(openOffset) {
    const bytes = this.bytes;
    let i = openOffset + 1;
    const builder = new TextBuilder();
    let runStart = i;
    while (true) {
      if (i >= bytes.length) fail("yaml.unterminated-string", openOffset, bytes.length, "unterminated double-quoted scalar");
      const byte = bytes[i];
      if (byte === 0x22) { builder.text(bytes, runStart, i); return { value: builder.build(), end: i + 1 }; }
      if (byte === 0x0a || byte === 0x0d) { builder.text(bytes, runStart, i); const folded = consumeLineBreaks(bytes, i); builder.raw(folded.text); i = folded.next; runStart = i; continue; }
      if (byte !== 0x5c) { i += 1; continue; }
      builder.text(bytes, runStart, i);
      const escape = bytes[i + 1];
      if (escape === 0x0a || escape === 0x0d) { const folded = consumeLineBreaks(bytes, i + 1); i = folded.next; runStart = i; continue; }
      const hex = (start, len) => {
        const text = utf8.decode(bytes.subarray(start, start + len));
        if (!/^[0-9a-fA-F]+$/.test(text) || text.length !== len) fail("yaml.invalid-escape", i, start + len, `invalid \\${String.fromCharCode(escape)} escape; expected ${len} hexadecimal digits`);
        return parseInt(text, 16);
      };
      switch (escape) {
        case 0x22: builder.raw("\""); i += 2; break;
        case 0x5c: builder.raw("\\"); i += 2; break;
        case 0x2f: builder.raw("/"); i += 2; break;
        case 0x62: builder.raw("\b"); i += 2; break;
        case 0x66: builder.raw("\f"); i += 2; break;
        case 0x6e: builder.raw("\n"); i += 2; break;
        case 0x72: builder.raw("\r"); i += 2; break;
        case 0x74: builder.raw("\t"); i += 2; break;
        case 0x30: builder.raw("\0"); i += 2; break;
        case 0x78: builder.raw(String.fromCharCode(hex(i + 2, 2))); i += 4; break;
        case 0x75: builder.raw(String.fromCharCode(hex(i + 2, 4))); i += 6; break;
        case 0x55: builder.raw(String.fromCodePoint(hex(i + 2, 8))); i += 10; break;
        default: fail("yaml.invalid-escape", i, i + 2, `invalid escape sequence \\${escape >= 0x20 && escape < 0x7f ? String.fromCharCode(escape) : `U+${escape.toString(16)}`}`);
      }
      runStart = i;
    }
  }

  // -- Flow collections -----------------------------------------------------

  skipFlowWs(pos) {
    const bytes = this.bytes;
    let i = pos;
    while (true) {
      while (i < bytes.length && (isSpaceOrTab(bytes[i]) || bytes[i] === 0x0a || bytes[i] === 0x0d)) i += 1;
      if (bytes[i] === 0x23 && (i === 0 || isSpaceOrTab(bytes[i - 1]) || bytes[i - 1] === 0x0a)) { while (i < bytes.length && bytes[i] !== 0x0a) i += 1; continue; }
      break;
    }
    return i;
  }

  parseFlowScalar(pos) {
    const bytes = this.bytes;
    const builder = new TextBuilder();
    let runStart = pos;
    let i = pos;
    while (i < bytes.length) {
      const byte = bytes[i];
      if (byte === 0x2c || byte === 0x5d || byte === 0x7d || byte === 0x5b || byte === 0x7b) break;
      if (byte === 0x3a && (i + 1 >= bytes.length || isSpaceOrTab(bytes[i + 1]) || bytes[i + 1] === 0x0a || bytes[i + 1] === 0x0d || bytes[i + 1] === 0x2c || bytes[i + 1] === 0x5d || bytes[i + 1] === 0x7d)) break;
      if (byte === 0x23 && isSpaceOrTab(bytes[i - 1])) break;
      if (byte === 0x0a || byte === 0x0d) { builder.text(bytes, runStart, i); const folded = consumeLineBreaks(bytes, i); builder.raw(folded.text); i = folded.next; runStart = i; continue; }
      i += 1;
    }
    builder.text(bytes, runStart, i);
    const text = builder.build().trimEnd();
    return { text, end: i };
  }

  parseFlowNode(pos) {
    const bytes = this.bytes;
    const start = this.skipFlowWs(pos);
    const byte = bytes[start];
    const entry = LEAD_ERRORS[byte];
    if (entry) fail(entry[0], start, start + 1, entry[1]);
    if (byte === 0x7b) return this.parseFlowMapping(start);
    if (byte === 0x5b) return this.parseFlowSequence(start);
    if (byte === 0x22) { const q = this.parseDoubleQuoted(start); return { value: { t: "str", v: q.value }, end: q.end }; }
    if (byte === 0x27) { const q = this.parseSingleQuoted(start); return { value: { t: "str", v: q.value }, end: q.end }; }
    const scalar = this.parseFlowScalar(start);
    const typed = classifyPlainScalar(scalar.text);
    return { value: typed, end: scalar.end };
  }

  parseFlowSequence(openOffset) {
    const bytes = this.bytes;
    let pos = openOffset + 1;
    const items = [];
    pos = this.skipFlowWs(pos);
    if (bytes[pos] === 0x5d) return { value: { t: "seq", items }, end: pos + 1 };
    while (true) {
      this.tick();
      const node = this.parseFlowNode(pos);
      items.push(node.value);
      this.items += 1;
      pos = this.skipFlowWs(node.end);
      if (bytes[pos] === 0x2c) {
        pos = this.skipFlowWs(pos + 1);
        if (bytes[pos] === 0x5d) fail("yaml.trailing-comma", pos - 1, pos, "trailing comma before \"]\" is not allowed");
        continue;
      }
      if (bytes[pos] === 0x5d) return { value: { t: "seq", items }, end: pos + 1 };
      fail("yaml.unexpected-token", pos, pos + 1, "expected \",\" or \"]\" in a flow sequence");
    }
  }

  parseFlowMapping(openOffset) {
    const bytes = this.bytes;
    let pos = openOffset + 1;
    const entries = [];
    const seen = new Map();
    pos = this.skipFlowWs(pos);
    if (bytes[pos] === 0x7d) return { value: { t: "map", entries }, end: pos + 1 };
    while (true) {
      this.tick();
      const keyStart = pos;
      const entry = LEAD_ERRORS[bytes[pos]];
      if (entry) fail(entry[0], pos, pos + 1, entry[1]);
      let keyText;
      let keyEnd;
      if (bytes[pos] === 0x22) { const q = this.parseDoubleQuoted(pos); keyText = q.value; keyEnd = q.end; }
      else if (bytes[pos] === 0x27) { const q = this.parseSingleQuoted(pos); keyText = q.value; keyEnd = q.end; }
      else { const s = this.parseFlowScalar(pos); keyText = s.text; keyEnd = s.end; }
      let after = this.skipFlowWs(keyEnd);
      let value = { t: "null" };
      if (bytes[after] === 0x3a) {
        const peek = this.skipFlowWs(after + 1);
        if (bytes[peek] !== 0x2c && bytes[peek] !== 0x7d) { const node = this.parseFlowNode(after + 1); value = node.value; after = this.skipFlowWs(node.end); }
        else after = peek;
      }
      this.keys += 1;
      const prior = seen.get(keyText);
      if (prior) fail("yaml.duplicate-key", keyStart, keyEnd, `duplicate mapping key ${JSON.stringify(keyText)}`, [{ message: "first occurrence", offset: prior.keyStart, end: prior.keyEnd, line: null, column: null }]);
      const record = { key: keyText, value, keyStart, keyEnd };
      seen.set(keyText, record);
      entries.push(record);
      pos = after;
      if (bytes[pos] === 0x2c) {
        pos = this.skipFlowWs(pos + 1);
        if (bytes[pos] === 0x7d) fail("yaml.trailing-comma", pos - 1, pos, "trailing comma before \"}\" is not allowed");
        continue;
      }
      if (bytes[pos] === 0x7d) return { value: { t: "map", entries }, end: pos + 1 };
      fail("yaml.unexpected-token", pos, pos + 1, "expected \",\" or \"}\" in a flow mapping");
    }
  }

  // -- Block scalars ---------------------------------------------------------

  parseBlockScalar(lineIndex, offset, parentMinIndent) {
    const bytes = this.bytes;
    const line = this.lines[lineIndex];
    const style = bytes[offset] === 0x7c ? "literal" : "folded";
    let pos = offset + 1;
    let chomp = "clip";
    let explicitIndent = null;
    for (let k = 0; k < 2 && pos < line.end; k += 1) {
      const byte = bytes[pos];
      if ((byte === 0x2d || byte === 0x2b) && explicitIndent === null && chomp === "clip") { chomp = byte === 0x2d ? "strip" : "keep"; pos += 1; }
      else if (byte >= 0x31 && byte <= 0x39 && explicitIndent === null) { explicitIndent = byte - 0x30; pos += 1; }
      else break;
    }
    const commentAt = findCommentCutoff(bytes, pos, line.end);
    const rest = trimTrailing(bytes, pos, commentAt);
    if (rest > pos) fail("yaml.unexpected-token", pos, line.end, "unexpected content after a block scalar indicator");
    const parentIndent = parentMinIndent ?? line.indent;
    const collected = [];
    let li = lineIndex + 1;
    let bodyIndentCol = explicitIndent !== null ? parentIndent + explicitIndent : null;
    let lastLineHadEol = true;
    while (li < this.lines.length) {
      const l = this.lines[li];
      const blank = l.contentStart === l.end;
      if (!blank) {
        const indentSpaces = l.indent;
        if (l.hasTab && indentSpaces < (bodyIndentCol ?? indentSpaces + 1)) fail("yaml.tab-indentation", l.start, l.contentStart, "tabs cannot be used for indentation");
        if (bodyIndentCol === null) {
          if (indentSpaces <= parentIndent) break;
          bodyIndentCol = indentSpaces;
        }
        if (indentSpaces < bodyIndentCol) break;
      } else if (bodyIndentCol === null && l.end === l.start) {
        // fully empty line: part of the scalar regardless of column.
      }
      this.tick();
      const from = blank ? l.end : l.start + bodyIndentCol;
      collected.push(utf8.decode(bytes.subarray(Math.min(from, l.end), l.end)));
      lastLineHadEol = l.hasEol;
      li += 1;
    }
    if (bodyIndentCol === null) bodyIndentCol = parentIndent + 1;
    let lastReal = -1;
    for (let k = collected.length - 1; k >= 0; k -= 1) if (collected[k] !== "") { lastReal = k; break; }
    const joinLiteral = (arr) => arr.join("\n");
    const joinFolded = (arr) => {
      let out = "";
      for (let idx = 0; idx < arr.length; idx += 1) {
        if (idx === 0) { out = arr[0]; continue; }
        const prevEmpty = arr[idx - 1] === "";
        const curEmpty = arr[idx] === "";
        const prevIndented = /^[ \t]/.test(arr[idx - 1]);
        const curIndented = /^[ \t]/.test(arr[idx]);
        out += (prevEmpty || curEmpty || prevIndented || curIndented) ? `\n${arr[idx]}` : ` ${arr[idx]}`;
      }
      return out;
    };
    const join = style === "literal" ? joinLiteral : joinFolded;
    let text;
    if (chomp === "strip") text = lastReal < 0 ? "" : join(collected.slice(0, lastReal + 1));
    else if (chomp === "keep") text = collected.length === 0 ? "" : join(collected) + (lastLineHadEol ? "\n" : "");
    else text = lastReal < 0 ? "" : join(collected.slice(0, lastReal + 1)) + "\n";
    this.li = li;
    return { t: "str", v: text };
  }
}

/** Parses one YAML document from `bytes`; throws `YamlError` on any rejected construct. */
export function parseYamlDocument(bytes, check) {
  const invalid = findInvalidUtf8(bytes, 0, bytes.length, check);
  if (invalid >= 0) fail("yaml.invalid-utf8", invalid, invalid + 1, `invalid UTF-8 sequence starting with byte 0x${bytes[invalid].toString(16).toUpperCase().padStart(2, "0")}`);
  const parser = new Parser(bytes, check);
  parser.skipBlank();
  let inlineStart = null;
  const first = parser.current();
  if (first && !first.isBlank) {
    const text = utf8.decode(bytes.subarray(first.contentStart, first.end));
    if (text === "---" || text.startsWith("--- ")) {
      const after = first.contentStart + 3;
      let pos = after;
      while (pos < first.end && isSpaceOrTab(bytes[pos])) pos += 1;
      const commentAt = findCommentCutoff(bytes, pos, first.end);
      const rest = trimTrailing(bytes, pos, commentAt);
      if (rest > pos) inlineStart = { line: parser.li, offset: pos };
      else parser.li += 1;
    }
  }
  const value = inlineStart ? parser.parseInlineNode(inlineStart.line, inlineStart.offset, 0) : parser.parseNode(0);
  parser.skipBlank();
  const after = parser.current();
  if (after) {
    const text = utf8.decode(bytes.subarray(after.contentStart, after.end)).trimEnd();
    if (text === "...") { parser.li += 1; parser.skipBlank(); }
  }
  const trailing = parser.current();
  if (trailing) fail("yaml.multiple-documents", trailing.start, trailing.end, "input contains more than one YAML document; only a single document is supported");
  return { value, keys: parser.keys, items: parser.items, maxDepth: computeMaxDepth(value), diagnostics: parser.diagnostics };
}

function computeMaxDepth(value, depth = 0) {
  if (!value || (value.t !== "map" && value.t !== "seq")) return depth;
  let max = depth + 1;
  if (value.t === "map") for (const entry of value.entries) max = Math.max(max, computeMaxDepth(entry.value, depth + 1));
  else for (const item of value.items) max = Math.max(max, computeMaxDepth(item, depth + 1));
  return max;
}

// ---------------------------------------------------------------------------
// JSON emission (convert.yaml-json)
// ---------------------------------------------------------------------------

function jsonQuote(str) {
  let out = "\"";
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (ch === "\"") out += "\\\"";
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

function jsonEmit(value, indentWidth, sortKeys, depth, out) {
  const pretty = indentWidth > 0;
  const pad = (d) => (pretty ? "\n" + " ".repeat(d * indentWidth) : "");
  switch (value.t) {
    case "null": out.push("null"); return;
    case "bool": out.push(value.v ? "true" : "false"); return;
    case "int": out.push(value.unsafe ? jsonQuote(value.decimal) : value.decimal); return;
    case "float": out.push(value.text); return;
    case "floatSpecial": out.push("null"); return;
    case "str": out.push(jsonQuote(value.v)); return;
    case "seq": {
      if (value.items.length === 0) { out.push("[]"); return; }
      out.push("[");
      value.items.forEach((item, index) => {
        if (index > 0) out.push(",");
        out.push(pad(depth + 1));
        jsonEmit(item, indentWidth, sortKeys, depth + 1, out);
      });
      out.push(pad(depth), "]");
      return;
    }
    case "map": {
      if (value.entries.length === 0) { out.push("{}"); return; }
      const entries = sortKeys ? [...value.entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) : value.entries;
      out.push("{");
      entries.forEach((entry, index) => {
        if (index > 0) out.push(",");
        out.push(pad(depth + 1), jsonQuote(entry.key), pretty ? ": " : ":");
        jsonEmit(entry.value, indentWidth, sortKeys, depth + 1, out);
      });
      out.push(pad(depth), "}");
      return;
    }
    default: throw new Error(`internal error: unknown value type ${value.t}`);
  }
}

// ---------------------------------------------------------------------------
// JSON parsing (convert.json-yaml) built on plugins/json's scanDocument
// ---------------------------------------------------------------------------

class JsonTreeBuilder {
  constructor(bytes) { this.bytes = bytes; this.stack = []; this.root = undefined; this.keys = 0; this.items = 0; }
  place(value) {
    if (this.stack.length === 0) { this.root = value; return; }
    const frame = this.stack[this.stack.length - 1];
    if (frame.isObject) { frame.entries.push({ key: frame.pendingKey, value }); frame.pendingKey = null; }
    else { frame.items.push(value); this.items += 1; }
  }
  open(byte) { const isObject = byte === 0x7b; const frame = isObject ? { isObject, entries: [], pendingKey: null } : { isObject, items: [] }; this.stack.push(frame); }
  close() { const frame = this.stack.pop(); const value = frame.isObject ? { t: "map", entries: frame.entries } : { t: "seq", items: frame.items }; this.place(value); }
  item() {}
  key(start, end) { this.stack[this.stack.length - 1].pendingKey = decodeStringLexeme(this.bytes, start, end); this.keys += 1; }
  scalar(kind, start, end, integer) {
    if (kind === "string") { this.place({ t: "str", v: decodeStringLexeme(this.bytes, start, end) }); return; }
    if (kind === "boolean") { this.place({ t: "bool", v: this.bytes[start] === 0x74 }); return; }
    if (kind === "null") { this.place({ t: "null" }); return; }
    const text = utf8.decode(this.bytes.subarray(start, end));
    this.place({ t: "number", text, integer });
  }
}

function parseJsonDocument(bytes, check) {
  const invalid = findInvalidUtf8(bytes, 0, bytes.length, check);
  if (invalid >= 0) fail("yaml.invalid-utf8", invalid, invalid + 1, `invalid UTF-8 sequence starting with byte 0x${bytes[invalid].toString(16).toUpperCase().padStart(2, "0")}`);
  const builder = new JsonTreeBuilder(bytes);
  try {
    scanDocument(bytes, 0, bytes.length, [builder], check);
  } catch (error) {
    if (error instanceof JsonError) { resolvePositions(bytes, 0, [error.diagnostic]); throw error; }
    throw error;
  }
  if (builder.root === undefined) builder.root = { t: "null" };
  return { value: builder.root, keys: builder.keys, items: builder.items, maxDepth: computeMaxDepth(builder.root) };
}

// ---------------------------------------------------------------------------
// YAML emission (convert.json-yaml)
// ---------------------------------------------------------------------------

const RESERVED_PLAIN = new Set(["", "~", "null", "Null", "NULL", "true", "True", "TRUE", "false", "False", "FALSE", "---", "..."]);

function looksTyped(text) {
  const typed = classifyPlainScalar(text);
  return typed.t !== "str";
}

function needsQuoting(text) {
  if (text === "") return true;
  if (RESERVED_PLAIN.has(text)) return true;
  if (looksTyped(text)) return true;
  if (/^\s|\s$/.test(text)) return true;
  if (/[\n\r]/.test(text)) return false; // handled by the caller via a block scalar
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(text)) return true;
  if (/: (?:$|)/.test(text) || / #/.test(text) || text.includes(": ") || text.endsWith(":")) return true;
  return false;
}

function yamlQuote(text) {
  let out = "\"";
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === "\"") out += "\\\"";
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code === 0) out += "\\0";
    else if (code < 0x20) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

/** Chooses a literal block scalar (with the chomping indicator that reproduces the exact trailing newline count) for a multi-line string. */
function blockScalarLines(text) {
  let trailingNewlines = 0;
  let i = text.length;
  while (i > 0 && text[i - 1] === "\n") { trailingNewlines += 1; i -= 1; }
  const core = text.slice(0, i);
  if (trailingNewlines === 0) return { chomp: "-", lines: text.split("\n") };
  if (trailingNewlines === 1) return { chomp: "", lines: core.split("\n") };
  return { chomp: "+", lines: core.split("\n").concat(Array(trailingNewlines - 1).fill("")) };
}

function scalarText(value) {
  if (value.t === "int") return value.unsafe ? yamlQuote(value.decimal) : value.decimal;
  if (value.t === "float") return value.text;
  if (value.t === "bool") return value.v ? "true" : "false";
  if (value.t === "null") return "null";
  throw new Error("internal error: not a scalar");
}

function emitYamlScalarString(str, indentCol, indentWidth, out) {
  if (/\n/.test(str)) {
    const { chomp, lines } = blockScalarLines(str);
    const needsExplicit = lines.length === 0 || lines[0] === "" || /^[ \t]/.test(lines[0]);
    const bodyIndent = indentCol + indentWidth;
    out.push(`|${chomp}${needsExplicit ? indentWidth : ""}`);
    for (const line of lines) out.push("\n", " ".repeat(bodyIndent), line);
    return;
  }
  out.push(needsQuoting(str) ? yamlQuote(str) : str);
}

function yamlEmitScalar(value, indentCol, indentWidth, out) {
  if (value.t === "str") { emitYamlScalarString(value.v, indentCol, indentWidth, out); return; }
  if (value.t === "number") { out.push(value.text); return; }
  out.push(scalarText(value));
}

function isScalar(value) { return value.t !== "map" && value.t !== "seq"; }

function yamlEmitNode(value, indentCol, indentWidth, out) {
  if (value.t === "map") { yamlEmitMapping(value.entries, indentCol, indentWidth, out); return; }
  if (value.t === "seq") { yamlEmitSequence(value.items, indentCol, indentWidth, out); return; }
  yamlEmitScalar(value, indentCol, indentWidth, out);
}

function yamlEmitMapping(entries, indentCol, indentWidth, out) {
  if (entries.length === 0) { out.push("{}"); return; }
  entries.forEach((entry, index) => {
    if (index > 0) out.push("\n", " ".repeat(indentCol));
    const keyText = needsQuoting(entry.key) ? yamlQuote(entry.key) : entry.key;
    out.push(keyText, ":");
    const value = entry.value;
    if (isScalar(value) && !(value.t === "str" && /\n/.test(value.v))) { out.push(" "); yamlEmitScalar(value, indentCol, indentWidth, out); }
    else if (value.t === "map" && value.entries.length === 0) out.push(" {}");
    else if (value.t === "seq" && value.items.length === 0) out.push(" []");
    else if (value.t === "str") { out.push(" "); emitYamlScalarString(value.v, indentCol, indentWidth, out); }
    else if (value.t === "seq") { out.push("\n", " ".repeat(indentCol)); yamlEmitSequence(value.items, indentCol, indentWidth, out); }
    else { out.push("\n", " ".repeat(indentCol + indentWidth)); yamlEmitMapping(value.entries, indentCol + indentWidth, indentWidth, out); }
  });
}

function yamlEmitSequence(items, indentCol, indentWidth, out) {
  if (items.length === 0) { out.push("[]"); return; }
  items.forEach((item, index) => {
    if (index > 0) out.push("\n", " ".repeat(indentCol));
    out.push("-");
    if (isScalar(item) && !(item.t === "str" && /\n/.test(item.v))) { out.push(" "); yamlEmitScalar(item, indentCol + 2, indentWidth, out); }
    else if (item.t === "map" && item.entries.length === 0) out.push(" {}");
    else if (item.t === "seq" && item.items.length === 0) out.push(" []");
    else if (item.t === "str") { out.push(" "); emitYamlScalarString(item.v, indentCol + 2, indentWidth, out); }
    else if (item.t === "map") { out.push(" "); yamlEmitMappingInline(item.entries, indentCol + 2, indentWidth, out); }
    else { out.push("\n", " ".repeat(indentCol + 2)); yamlEmitSequence(item.items, indentCol + 2, indentWidth, out); }
  });
}

/** Emits a mapping whose first key:value pair continues the current line (used right after a sequence dash). */
function yamlEmitMappingInline(entries, indentCol, indentWidth, out) {
  if (entries.length === 0) { out.push("{}"); return; }
  entries.forEach((entry, index) => {
    if (index > 0) out.push("\n", " ".repeat(indentCol));
    const keyText = needsQuoting(entry.key) ? yamlQuote(entry.key) : entry.key;
    out.push(keyText, ":");
    const value = entry.value;
    if (isScalar(value) && !(value.t === "str" && /\n/.test(value.v))) { out.push(" "); yamlEmitScalar(value, indentCol, indentWidth, out); }
    else if (value.t === "map" && value.entries.length === 0) out.push(" {}");
    else if (value.t === "seq" && value.items.length === 0) out.push(" []");
    else if (value.t === "str") { out.push(" "); emitYamlScalarString(value.v, indentCol, indentWidth, out); }
    else if (value.t === "seq") { out.push("\n", " ".repeat(indentCol)); yamlEmitSequence(value.items, indentCol, indentWidth, out); }
    else { out.push("\n", " ".repeat(indentCol + indentWidth)); yamlEmitMapping(value.entries, indentCol + indentWidth, indentWidth, out); }
  });
}

function yamlRoot(value, indentWidth) {
  const out = [];
  if (value.t === "map") { if (value.entries.length === 0) out.push("{}"); else yamlEmitMapping(value.entries, 0, indentWidth, out); }
  else if (value.t === "seq") { if (value.items.length === 0) out.push("[]"); else yamlEmitSequence(value.items, 0, indentWidth, out); }
  else if (value.t === "number") out.push(value.text);
  else if (value.t === "str") { if (/\n/.test(value.v)) emitYamlScalarString(value.v, 0, indentWidth, out); else out.push(needsQuoting(value.v) ? yamlQuote(value.v) : value.v); }
  else out.push(scalarText(value));
  return `${out.join("")}\n`;
}

// ---------------------------------------------------------------------------
// execute()
// ---------------------------------------------------------------------------

function countScalarDiagnostics(value, seen = { count: 0 }) {
  if (value.t === "map") for (const e of value.entries) countScalarDiagnostics(e.value, seen);
  else if (value.t === "seq") for (const it of value.items) countScalarDiagnostics(it, seen);
  return seen;
}

async function runYamlToJson(context, options) {
  const check = cancellationCheck(context);
  const bytes = await readInput(context);
  let parsed;
  try {
    parsed = parseYamlDocument(bytes, check);
  } catch (error) {
    if (error instanceof YamlError) resolvePositions(bytes, 0, [error.diagnostic]);
    throw error;
  }
  const out = [];
  jsonEmit(parsed.value, options.indent, options.sortKeys, 0, out);
  const text = out.join("");
  const outputBytes = encoder.encode(options.indent > 0 ? `${text}\n` : text);
  const cap = Math.min(context.limits.maxOutputBytes, context.limits.maxChunkBytes);
  if (outputBytes.byteLength > cap) fail("yaml.output-limit", null, null, `output would be ${outputBytes.byteLength} bytes, above the ${cap} byte output limit`);
  const properties = { operation: "convert.yaml-json", documents: 1, keys: parsed.keys, items: parsed.items, maxDepth: parsed.maxDepth, diagnostics: parsed.diagnostics.length, diagnosticsDetail: resolvePositions(bytes, 0, parsed.diagnostics), bytes: outputBytes.byteLength };
  await context.writeValue("output", properties);
  await context.write("output", outputBytes);
  return properties;
}

async function runJsonToYaml(context, options) {
  const check = cancellationCheck(context);
  const bytes = await readInput(context);
  const parsed = parseJsonDocument(bytes, check);
  const text = yamlRoot(parsed.value, options.indent);
  const outputBytes = encoder.encode(text);
  const cap = Math.min(context.limits.maxOutputBytes, context.limits.maxChunkBytes);
  if (outputBytes.byteLength > cap) fail("yaml.output-limit", null, null, `output would be ${outputBytes.byteLength} bytes, above the ${cap} byte output limit`);
  const properties = { operation: "convert.json-yaml", documents: 1, keys: parsed.keys, items: parsed.items, maxDepth: parsed.maxDepth, diagnostics: 0, bytes: outputBytes.byteLength };
  await context.writeValue("output", properties);
  await context.write("output", outputBytes);
  return properties;
}

export async function execute(request, context) {
  const operation = request?.operationId ?? "convert.yaml-json";
  if (!OPERATIONS.includes(operation)) throw new Error(`unsupported operation ${operation}`);
  cancellationCheck(context)();
  if (operation === "convert.yaml-json") return runYamlToJson(context, normalizeYamlJsonOptions(request?.options));
  return runJsonToYaml(context, normalizeJsonYamlOptions(request?.options));
}
