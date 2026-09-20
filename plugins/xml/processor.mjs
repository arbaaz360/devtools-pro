import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";

/**
 * Reference XML processor for `format.xml`.
 *
 * A single-pass, byte-level tokenizer walks the immutable source once,
 * building a small in-memory tree (elements, text, comments, CDATA,
 * processing instructions, DOCTYPE) while recording tolerant diagnostics.
 * Nothing is ever routed through a DOM parser or `DOMParser`. Attribute
 * values, comments, CDATA bodies and PI bodies are always copied
 * byte-for-byte from the source; only insignificant structure (tag
 * spacing, indentation, whitespace-only text between elements) is
 * synthesised.
 *
 * Only two conditions fail the operation outright: an empty document, and
 * a document with no `<` byte anywhere in it. Every other malformed
 * construct (unclosed elements, mismatched end tags, unquoted attributes,
 * stray `<`/`&`, trailing content after the root) is tolerated: formatting
 * continues by best effort and the problem is reported as a `warning`
 * diagnostic instead.
 */

export const OPERATIONS = Object.freeze(["beautify", "minify"]);
export const READ_CHUNK_BYTES = 64 * 1024;
export const TOKEN_STRIDE = 4096;
export const TEXT_SCAN_STRIDE = 64 * 1024;

const LT = 0x3c, GT = 0x3e, SLASH = 0x2f, EXCL = 0x21, QMARK = 0x3f, EQ = 0x3d;
const DQ = 0x22, SQ = 0x27, AMP = 0x26, HASH = 0x23, SEMI = 0x3b;
const LB = 0x5b, RB = 0x5d, COLON = 0x3a, US = 0x5f, DASH = 0x2d, DOT = 0x2e;
const SPACE = 0x20, TAB = 0x09, LF = 0x0a, CR = 0x0d, X_LOWER = 0x78, X_UPPER = 0x58;

function isWs(b) { return b === SPACE || b === TAB || b === LF || b === CR; }
function isNameStart(b) { return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === COLON || b === US || b >= 0x80; }
function isNameChar(b) { return isNameStart(b) || (b >= 0x30 && b <= 0x39) || b === DASH || b === DOT; }
function isDigit(b) { return b >= 0x30 && b <= 0x39; }
function isHexDigit(b) { return isDigit(b) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66); }

const lossyDecoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

/** Thrown only for the two document-level failures, unsupported operations and invalid options. */
export class XmlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "XmlError";
    this.code = code;
    this.diagnostic = { code, severity: "error", message, offset: null, end: null, line: null, column: null };
  }
}

function invalidOption(message, data) {
  return new XmlError("xml.invalid-option", message + (data ? ` (${JSON.stringify(data)})` : ""));
}

const INDENT_CHOICES = Object.freeze({ sp2: "  ", sp4: "    ", tab: "\t" });
const PRESERVE_COMMENTS_IDS = ["preserve-comments", "preserveComments"];
const COLLAPSE_EMPTY_IDS = ["collapse-empty", "collapseEmpty"];
const KNOWN_OPTIONS = new Set(["indent", ...PRESERVE_COMMENTS_IDS, ...COLLAPSE_EMPTY_IDS]);

/**
 * `indent` accepts `sp2`/`sp4`/`tab` (the manifest's enum choice ids; the
 * contract schema requires choice identifiers to start with a letter, so
 * the packet's "2, 4, tab" values are spelled `sp2`/`sp4`/`tab` here and in
 * the manifest). Booleans accept both the kebab-case id and its camelCase
 * alias, and the two must agree when both are supplied.
 */
export function normalizeOptions(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalidOption("options must be an object", { received: Array.isArray(raw) ? "array" : typeof raw });
  for (const key of Object.keys(raw)) if (!KNOWN_OPTIONS.has(key)) throw invalidOption(`unknown option ${key}`, { option: key, known: [...KNOWN_OPTIONS] });

  const indent = raw.indent === undefined ? "sp2" : raw.indent;
  if (typeof indent !== "string" || !(indent in INDENT_CHOICES)) throw invalidOption(`indent must be one of ${Object.keys(INDENT_CHOICES).join(", ")}`, { option: "indent", received: indent });

  const readBoolPair = (ids, defaultValue) => {
    const supplied = ids.filter((id) => raw[id] !== undefined);
    if (supplied.length === 0) return defaultValue;
    for (const id of supplied) if (typeof raw[id] !== "boolean") throw invalidOption(`${id} must be a boolean`, { option: id, received: typeof raw[id] });
    if (supplied.length > 1 && raw[supplied[0]] !== raw[supplied[1]]) throw invalidOption(`${supplied[0]} and ${supplied[1]} disagree`, { options: supplied });
    return raw[supplied[0]];
  };

  return {
    indent,
    indentUnit: INDENT_CHOICES[indent],
    preserveComments: readBoolPair(PRESERVE_COMMENTS_IDS, true),
    collapseEmpty: readBoolPair(COLLAPSE_EMPTY_IDS, true),
  };
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
// Byte-range helpers
// ---------------------------------------------------------------------------

function rangeStr(bytes, range) { return lossyDecoder.decode(bytes.subarray(range.s, range.e)); }
function namesEqual(bytes, a, b) {
  const length = a.e - a.s;
  if (length !== b.e - b.s) return false;
  for (let k = 0; k < length; k += 1) if (bytes[a.s + k] !== bytes[b.s + k]) return false;
  return true;
}
function startsWithAscii(bytes, at, literal) {
  if (at + literal.length > bytes.length) return false;
  for (let k = 0; k < literal.length; k += 1) if (bytes[at + k] !== literal.charCodeAt(k)) return false;
  return true;
}
function findSeqEnd(bytes, from, seq, end) {
  const m = seq.length;
  for (let k = from; k <= end - m; k += 1) {
    let ok = true;
    for (let t = 0; t < m; t += 1) if (bytes[k + t] !== seq[t]) { ok = false; break; }
    if (ok) return k + m;
  }
  return end;
}
const COMMENT_END = [DASH, DASH, GT];
const CDATA_END = [RB, RB, GT];
const PI_END = [QMARK, GT];

/** Returns the index just past a valid `&name;`/`&#123;`/`&#x1F;` reference starting at `i`, or -1. */
function validReferenceEnd(bytes, i, end) {
  let j = i + 1;
  if (j < end && bytes[j] === HASH) {
    j += 1;
    let isHex = false;
    if (j < end && (bytes[j] === X_LOWER || bytes[j] === X_UPPER)) { isHex = true; j += 1; }
    const start = j;
    while (j < end && (isHex ? isHexDigit(bytes[j]) : isDigit(bytes[j]))) j += 1;
    if (j === start) return -1;
    return j < end && bytes[j] === SEMI ? j + 1 : -1;
  }
  if (!(j < end && isNameStart(bytes[j]))) return -1;
  j += 1;
  while (j < end && isNameChar(bytes[j])) j += 1;
  return j < end && bytes[j] === SEMI ? j + 1 : -1;
}

function isRecognizedConstructAt(bytes, i, end) {
  if (bytes[i] !== LT || i + 1 >= end) return null;
  const next = bytes[i + 1];
  if (next === SLASH) return "end";
  if (next === QMARK) return "pi";
  if (next === EXCL) {
    if (startsWithAscii(bytes, i, "<!--")) return "comment";
    if (startsWithAscii(bytes, i, "<![CDATA[")) return "cdata";
    if (startsWithAscii(bytes, i, "<!DOCTYPE")) return "doctype";
    return null;
  }
  if (isNameStart(next)) return "start";
  return null;
}

// ---------------------------------------------------------------------------
// Start tag / end tag / doctype token scanning
// ---------------------------------------------------------------------------

/** Scans `<name attr="value" ...>` or `<name .../>`, tolerating unquoted values and running to end of input. */
function parseStartTag(bytes, i, end) {
  const tagStart = i;
  let j = i + 1;
  const nameStart = j;
  j += 1; while (j < end && isNameChar(bytes[j])) j += 1;
  const nameEnd = j;
  const attrs = [];
  let selfClosing = false;
  let truncated = false;
  while (true) {
    while (j < end && isWs(bytes[j])) j += 1;
    if (j >= end) { truncated = true; break; }
    if (bytes[j] === SLASH) {
      if (j + 1 < end && bytes[j + 1] === GT) { selfClosing = true; j += 2; break; }
      j += 1; continue;
    }
    if (bytes[j] === GT) { j += 1; break; }
    if (!isNameStart(bytes[j])) { j += 1; continue; }
    const attrNameStart = j; j += 1; while (j < end && isNameChar(bytes[j])) j += 1; const attrNameEnd = j;
    while (j < end && isWs(bytes[j])) j += 1;
    let value = null, quoted = false, quoteChar = 0;
    if (j < end && bytes[j] === EQ) {
      j += 1;
      while (j < end && isWs(bytes[j])) j += 1;
      if (j >= end) { truncated = true; value = { s: j, e: j }; attrs.push({ name: { s: attrNameStart, e: attrNameEnd }, value, quoted, quoteChar }); break; }
      if (bytes[j] === DQ || bytes[j] === SQ) {
        quoteChar = bytes[j]; quoted = true; j += 1;
        const valueStart = j;
        while (j < end && bytes[j] !== quoteChar) j += 1;
        value = { s: valueStart, e: j };
        if (j < end) j += 1; else truncated = true;
      } else {
        const valueStart = j;
        while (j < end && !isWs(bytes[j]) && bytes[j] !== GT && bytes[j] !== SLASH) j += 1;
        value = { s: valueStart, e: j };
      }
    }
    attrs.push({ name: { s: attrNameStart, e: attrNameEnd }, value, quoted, quoteChar });
    if (truncated) break;
  }
  return { tagStart, name: { s: nameStart, e: nameEnd }, attrs, selfClosing, truncated, end: j };
}

function parseEndTagTokens(bytes, i, end) {
  let j = i + 2;
  const nameStart = j;
  if (j < end && isNameStart(bytes[j])) { j += 1; while (j < end && isNameChar(bytes[j])) j += 1; }
  const nameEnd = j;
  while (j < end && bytes[j] !== GT) j += 1;
  const tagEnd = j < end ? j + 1 : end;
  return { nameStart, nameEnd, tagEnd };
}

/** Scans `<!DOCTYPE ...>`, matching an optional bracketed internal subset and skipping quoted literals inside it. */
function parseDoctype(bytes, i, end) {
  let j = i + 9;
  let depth = 0;
  let quote = 0;
  while (j < end) {
    const b = bytes[j];
    if (quote) { if (b === quote) quote = 0; j += 1; continue; }
    if (b === DQ || b === SQ) { quote = b; j += 1; continue; }
    if (b === LB) { depth += 1; j += 1; continue; }
    if (b === RB && depth > 0) { depth -= 1; j += 1; continue; }
    if (b === GT && depth === 0) { j += 1; break; }
    j += 1;
  }
  return { s: i, e: j };
}

// ---------------------------------------------------------------------------
// Single-pass scanner producing the node tree and diagnostics
// ---------------------------------------------------------------------------

/**
 * Node shapes: `{t:"element", name, attrs, children, contentStart,
 * contentEnd, spacePreserve, tagStart}`; `{t:"text"|"comment"|"cdata"|"pi"|
 * "doctype", s, e}` (raw source ranges, including delimiters for every kind
 * but text).
 */
function parseXml(bytes, check) {
  const end = bytes.length;
  const top = [];
  const stack = [];
  let root = null;
  let trailingFlagged = false;
  let tokenCount = 0;
  let maxDepth = 0;
  const diagnostics = [];
  const stats = { elements: 0, attributes: 0, comments: 0 };

  const bump = () => { tokenCount += 1; if ((tokenCount & (TOKEN_STRIDE - 1)) === 0) check(); };
  const addDiag = (code, offset, spanEnd, message) => diagnostics.push({ code, severity: "warning", message, offset, end: Math.min(spanEnd, end), line: null, column: null });
  const currentSpacePreserve = () => (stack.length ? stack[stack.length - 1].spacePreserve : false);
  const pushChild = (node) => stack[stack.length - 1].children.push(node);
  const appendAux = (node) => { if (stack.length > 0) pushChild(node); else top.push(node); };
  const enclosingName = () => (stack.length ? `<${rangeStr(bytes, stack[stack.length - 1].name)}>` : "the document");

  const flagTrailing = (offset) => {
    if (trailingFlagged) return;
    trailingFlagged = true;
    const name = root ? rangeStr(bytes, root.name) : null;
    addDiag("xml.trailing-content", offset, offset + 1, name ? `content after the root element "<${name}>" is ignored` : "content after the root element is ignored");
  };

  const computeSpacePreserve = (attrs, inherited) => {
    for (const attr of attrs) {
      if (attr.value && rangeStr(bytes, attr.name) === "xml:space") {
        const value = rangeStr(bytes, attr.value);
        if (value === "preserve") return true;
        if (value === "default") return false;
      }
    }
    return inherited;
  };

  const closeUnclosed = (frame, at) => {
    frame.contentEnd = at;
    addDiag("xml.unclosed-element", frame.tagStart, frame.name.e, `element "<${rangeStr(bytes, frame.name)}>" was not closed`);
  };

  function handleTextRun(s, e) {
    if (currentSpacePreserve()) { pushChild({ t: "text", s, e }); return; }
    let allWs = true;
    for (let k = s; k < e; k += 1) if (!isWs(bytes[k])) { allWs = false; break; }
    if (allWs) return;
    if (stack.length === 0) { if (root === null) return; flagTrailing(s); return; }
    pushChild({ t: "text", s, e });
  }

  function handleTextLikeAux(node) {
    if (stack.length === 0) { if (root === null) return; flagTrailing(node.s); return; }
    pushChild(node);
  }

  /** Extends a text run through embedded stray `<`/`&`, stopping at a recognized construct or EOF. */
  function scanTextRun(start) {
    let i = start;
    let sinceCheck = 0;
    while (i < end) {
      const b = bytes[i];
      if (b === LT) {
        if (isRecognizedConstructAt(bytes, i, end)) break;
        addDiag("xml.stray-lt", i, i + 1, `stray "<" in ${enclosingName()} is not well-formed and is kept as text`);
        i += 1;
      } else if (b === AMP) {
        const refEnd = validReferenceEnd(bytes, i, end);
        if (refEnd < 0) { addDiag("xml.stray-ampersand", i, i + 1, `stray "&" in ${enclosingName()} is not a valid reference and is kept as text`); i += 1; }
        else i = refEnd;
      } else i += 1;
      sinceCheck += 1;
      if (sinceCheck >= TEXT_SCAN_STRIDE) { sinceCheck = 0; check(); }
    }
    return i;
  }

  function handleEndTag(i) {
    const parsed = parseEndTagTokens(bytes, i, end);
    const hasName = parsed.nameEnd > parsed.nameStart;
    const nameRange = { s: parsed.nameStart, e: parsed.nameEnd };
    if (stack.length === 0) {
      if (root === null) { if (hasName) addDiag("xml.unmatched-end-tag", i, parsed.tagEnd, `end tag "</${rangeStr(bytes, nameRange)}>" does not match any open element`); return parsed.tagEnd; }
      flagTrailing(i);
      return parsed.tagEnd;
    }
    if (!hasName) { addDiag("xml.unmatched-end-tag", i, parsed.tagEnd, "end tag does not match any open element"); return parsed.tagEnd; }
    let matchIndex = -1;
    for (let idx = stack.length - 1; idx >= 0; idx -= 1) if (namesEqual(bytes, stack[idx].name, nameRange)) { matchIndex = idx; break; }
    if (matchIndex === -1) { addDiag("xml.unmatched-end-tag", i, parsed.tagEnd, `end tag "</${rangeStr(bytes, nameRange)}>" does not match any open element`); return parsed.tagEnd; }
    while (stack.length - 1 > matchIndex) closeUnclosed(stack.pop(), i);
    const matched = stack.pop();
    matched.contentEnd = i;
    return parsed.tagEnd;
  }

  function handleStartTag(i) {
    const st = parseStartTag(bytes, i, end);
    stats.elements += 1;
    stats.attributes += st.attrs.length;
    for (const attr of st.attrs) if (attr.value !== null && !attr.quoted) addDiag("xml.unquoted-attribute", attr.value.s, attr.value.e, `attribute "${rangeStr(bytes, attr.name)}" on "<${rangeStr(bytes, st.name)}>" is not quoted`);
    const spacePreserve = computeSpacePreserve(st.attrs, currentSpacePreserve());
    const node = { t: "element", name: st.name, attrs: st.attrs, children: [], contentStart: st.end, contentEnd: st.end, spacePreserve, tagStart: st.tagStart };
    const closedImmediately = st.selfClosing || st.truncated;
    if (st.truncated) addDiag("xml.unclosed-element", st.tagStart, st.name.e, `element "<${rangeStr(bytes, st.name)}>" was not closed`);
    if (stack.length > 0) pushChild(node);
    else if (root === null) { root = node; top.push(node); }
    else { flagTrailing(st.tagStart); return st.end; }
    const depth = stack.length + 1;
    if (depth > maxDepth) maxDepth = depth;
    if (!closedImmediately) stack.push(node);
    return st.end;
  }

  if (end === 0 || bytes.indexOf(LT) === -1) throw new XmlError("xml.no-element", end === 0 ? "document is empty" : "document has no \"<\" and can never contain an element");

  let i = 0;
  while (i < end && !trailingFlagged) {
    const runStart = i;
    const runEnd = scanTextRun(i);
    if (runEnd > runStart) { handleTextRun(runStart, runEnd); i = runEnd; if (trailingFlagged) break; }
    if (i >= end) break;
    const kind = isRecognizedConstructAt(bytes, i, end);
    bump();
    if (kind === "comment") { const e = findSeqEnd(bytes, i + 4, COMMENT_END, end); appendAux({ t: "comment", s: i, e }); stats.comments += 1; i = e; }
    else if (kind === "cdata") { const e = findSeqEnd(bytes, i + 9, CDATA_END, end); handleTextLikeAux({ t: "cdata", s: i, e }); i = e; }
    else if (kind === "doctype") { const r = parseDoctype(bytes, i, end); appendAux({ t: "doctype", s: i, e: r.e }); i = r.e; }
    else if (kind === "pi") { const e = findSeqEnd(bytes, i + 2, PI_END, end); appendAux({ t: "pi", s: i, e }); i = e; }
    else if (kind === "end") i = handleEndTag(i);
    else i = handleStartTag(i);
  }
  while (stack.length > 0) closeUnclosed(stack.pop(), end);

  return { top, root, diagnostics, stats: { ...stats, depth: maxDepth } };
}

// ---------------------------------------------------------------------------
// Line/column resolution (mirrors the JSON reference processor)
// ---------------------------------------------------------------------------

function resolvePositions(bytes, diagnostics) {
  const spans = [...diagnostics].sort((a, b) => a.offset - b.offset);
  let line = 1, column = 1, i = 0;
  for (const span of spans) {
    while (i < span.offset) {
      const byte = bytes[i]; i += 1;
      if (byte === LF) { line += 1; column = 1; }
      else if (byte === CR) { if (i < span.offset && bytes[i] === LF) i += 1; line += 1; column = 1; }
      else if ((byte & 0xc0) !== 0x80) column += 1;
    }
    span.line = line; span.column = column;
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

class Pieces {
  constructor() { this.parts = []; this.length = 0; }
  raw(bytes, s, e) { if (e > s) { this.parts.push(bytes.subarray(s, e)); this.length += e - s; } }
  lit(str) { if (str.length === 0) return; const bytes = encoder.encode(str); this.parts.push(bytes); this.length += bytes.length; }
  build() { const out = new Uint8Array(this.length); let pos = 0; for (const part of this.parts) { out.set(part, pos); pos += part.length; } return out; }
}

function trimRange(bytes, s, e) { let a = s, b = e; while (a < b && isWs(bytes[a])) a += 1; while (b > a && isWs(bytes[b - 1])) b -= 1; return [a, b]; }

function significantChildren(node, options) {
  if (options.preserveComments) return node.children;
  return node.children.filter((child) => child.t !== "comment");
}

function classify(sig) {
  if (sig.length === 0) return "empty";
  let hasElement = false, hasTextLike = false;
  for (const child of sig) {
    if (child.t === "element") hasElement = true;
    else if (child.t === "text" || child.t === "cdata") hasTextLike = true;
  }
  if (hasElement && hasTextLike) return "mixed";
  if (hasElement) return "structural";
  return "textish";
}

function renderElement(bytes, node, depth, pieces, options, mode) {
  pieces.lit("<"); pieces.raw(bytes, node.name.s, node.name.e);
  for (const attr of node.attrs) {
    pieces.lit(" "); pieces.raw(bytes, attr.name.s, attr.name.e);
    if (attr.value) {
      pieces.lit("=");
      if (attr.quoted) { pieces.lit(String.fromCharCode(attr.quoteChar)); pieces.raw(bytes, attr.value.s, attr.value.e); pieces.lit(String.fromCharCode(attr.quoteChar)); }
      else pieces.raw(bytes, attr.value.s, attr.value.e);
    }
  }
  if (node.spacePreserve) {
    pieces.lit(">");
    pieces.raw(bytes, node.contentStart, node.contentEnd);
    pieces.lit("</"); pieces.raw(bytes, node.name.s, node.name.e); pieces.lit(">");
    return;
  }
  const sig = significantChildren(node, options);
  const shape = classify(sig);
  if (shape === "empty") {
    if (options.collapseEmpty) pieces.lit("/>");
    else { pieces.lit("></"); pieces.raw(bytes, node.name.s, node.name.e); pieces.lit(">"); }
    return;
  }
  pieces.lit(">");
  if (shape === "mixed") {
    pieces.raw(bytes, node.contentStart, node.contentEnd);
  } else if (shape === "textish") {
    // Text nodes here are never whitespace-only (those are dropped while scanning), so trimming
    // is always safe; this is what keeps beautify -> minify -> beautify byte-identical.
    for (const child of sig) {
      if (child.t === "text") { const [a, b] = trimRange(bytes, child.s, child.e); pieces.raw(bytes, a, b); }
      else pieces.raw(bytes, child.s, child.e);
    }
  } else {
    const unit = options.indentUnit;
    for (const child of sig) {
      if (mode === "beautify") { pieces.lit("\n"); pieces.lit(unit.repeat(depth + 1)); }
      if (child.t === "element") renderElement(bytes, child, depth + 1, pieces, options, mode);
      else pieces.raw(bytes, child.s, child.e);
    }
    if (mode === "beautify") { pieces.lit("\n"); pieces.lit(unit.repeat(depth)); }
  }
  pieces.lit("</"); pieces.raw(bytes, node.name.s, node.name.e); pieces.lit(">");
}

function render(bytes, parsed, options, mode) {
  const pieces = new Pieces();
  let emitted = false;
  for (const node of parsed.top) {
    if (node.t === "comment" && !options.preserveComments) continue;
    if (emitted && mode === "beautify") pieces.lit("\n");
    emitted = true;
    if (node.t === "element") renderElement(bytes, node, 0, pieces, options, mode);
    else pieces.raw(bytes, node.s, node.e);
  }
  return pieces;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function outputCap(context) { return Math.min(context.limits.maxOutputBytes, context.limits.maxChunkBytes); }

export async function execute(request, context) {
  const operation = request?.operationId;
  if (!OPERATIONS.includes(operation)) throw new XmlError("xml.unsupported-operation", `unsupported operation ${operation}`);
  const check = cancellationCheck(context);
  check();
  const options = normalizeOptions(request?.options);
  const bytes = await readInput(context);
  const parsed = parseXml(bytes, check);
  resolvePositions(bytes, parsed.diagnostics);
  parsed.diagnostics.sort((a, b) => a.offset - b.offset);

  const pieces = render(bytes, parsed, options, operation);
  const cap = outputCap(context);
  if (pieces.length > cap) throw new XmlError("xml.output-limit", `${operation} output would be ${pieces.length} bytes, above the ${cap} byte output limit`);
  const output = pieces.build();

  const report = {
    operation,
    inputBytes: bytes.byteLength,
    outputBytes: output.byteLength,
    elements: parsed.stats.elements,
    attributes: parsed.stats.attributes,
    comments: parsed.stats.comments,
    depth: parsed.stats.depth,
    wellFormed: parsed.diagnostics.length === 0,
    diagnostics: parsed.diagnostics.length,
    diagnosticsDetail: parsed.diagnostics,
    bytes: output.byteLength,
    limits: { maxInputBytes: context.limits.maxInputBytes, maxOutputBytes: cap },
  };
  await context.writeValue("output", report);
  await context.write("output", output);
  return report;
}
