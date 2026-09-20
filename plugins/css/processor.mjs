import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";

/**
 * Reference CSS processor for `format.css`.
 *
 * A single-pass byte-level tokenizer follows CSS Syntax Level 3 §4 (comments,
 * strings, `url(` unquoted tokens, numbers/dimensions/percentages, hashes,
 * at-keywords, functions, the structural punctuation, and delimiters).
 * Nothing is ever routed through a real CSS parser or `CSSStyleSheet`. A
 * lightweight structural pass then groups the flat token stream into a tree
 * of rules/at-rules/declarations by brace and semicolon boundaries alone
 * (no selector or property grammar is validated), which is what lets it
 * tolerate incomplete or invalid CSS. Strings, `url()` contents and comments
 * are always copied byte-for-byte from the source.
 *
 * Only an empty document is a hard error; every other malformed construct
 * (an unclosed block, an unclosed comment, a declaration with no colon) is
 * tolerated, formatted by best effort, and reported as a `warning`
 * diagnostic.
 */

export const OPERATIONS = Object.freeze(["beautify", "minify"]);
export const READ_CHUNK_BYTES = 64 * 1024;
export const TOKEN_STRIDE = 4096;

const LBRACE = 0x7b, RBRACE = 0x7d, LPAREN = 0x28, RPAREN = 0x29, LBRACKET = 0x5b, RBRACKET = 0x5d;
const SEMI = 0x3b, COMMA = 0x2c, COLON = 0x3a;
const SLASH = 0x2f, STAR = 0x2a, AT = 0x40, HASH = 0x23;
const DQ = 0x22, SQ = 0x27, BACKSLASH = 0x5c;
const SPACE = 0x20, TAB = 0x09, LF = 0x0a, CR = 0x0d, FF = 0x0c;
const PLUS = 0x2b, MINUS = 0x2d, DOT = 0x2e, PERCENT = 0x25, EXCL = 0x21, UNDERSCORE = 0x5f;

function isWsByte(b) { return b === SPACE || b === TAB || b === LF || b === CR || b === FF; }
function isDigit(b) { return b >= 0x30 && b <= 0x39; }
function isHexDigit(b) { return isDigit(b) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66); }
function isLetter(b) { return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a); }
function isNameStartByte(b) { return isLetter(b) || b === UNDERSCORE || b >= 0x80; }
function isNameCharByte(b) { return isNameStartByte(b) || isDigit(b) || b === MINUS; }

/** Thrown for the document-level failures, unsupported operations and invalid options. */
export class CssError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CssError";
    this.code = code;
    this.diagnostic = { code, severity: "error", message, offset: null, end: null, line: null, column: null };
  }
}

function invalidOption(message, data) {
  return new CssError("css.invalid-option", message + (data ? ` (${JSON.stringify(data)})` : ""));
}

const INDENT_CHOICES = Object.freeze({ sp2: "  ", sp4: "    ", tab: "\t" });
const PRESERVE_COMMENTS_IDS = ["preserve-comments", "preserveComments"];
const BLANK_LINE_IDS = ["blank-line-between-rules", "blankLineBetweenRules"];
const KNOWN_OPTIONS = new Set(["indent", ...PRESERVE_COMMENTS_IDS, ...BLANK_LINE_IDS]);

/**
 * `indent` accepts `sp2`/`sp4`/`tab` (the manifest's enum choice ids; the
 * contract schema's `ChoiceIdentifier` requires an enum choice id to start
 * with a letter, so the packet's "2, 4, tab" values are spelled
 * `sp2`/`sp4`/`tab` here and in the manifest, matching `plugins/xml/`).
 * Booleans accept both the kebab-case id and its camelCase alias, and the
 * two must agree when both are supplied.
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
    blankLineBetweenRules: readBoolPair(BLANK_LINE_IDS, true),
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
// Tokenizer (CSS Syntax Level 3 §4)
// ---------------------------------------------------------------------------

function isValidEscapeStart(bytes, end, i) { return bytes[i] === BACKSLASH && i + 1 < end && bytes[i + 1] !== LF; }

function consumeEscape(bytes, end, i) {
  let j = i + 1;
  if (j < end && isHexDigit(bytes[j])) {
    let count = 0;
    while (j < end && count < 6 && isHexDigit(bytes[j])) { j += 1; count += 1; }
    if (j < end && isWsByte(bytes[j])) j += 1;
    return j;
  }
  if (j >= end) return j;
  const lead = bytes[j];
  const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return Math.min(j + width, end);
}

function isIdentStartAt(bytes, end, i) {
  if (i >= end) return false;
  const b = bytes[i];
  if (isNameStartByte(b)) return true;
  if (b === BACKSLASH) return isValidEscapeStart(bytes, end, i);
  if (b === MINUS) {
    if (i + 1 < end && (isNameStartByte(bytes[i + 1]) || bytes[i + 1] === MINUS)) return true;
    if (i + 1 < end && isValidEscapeStart(bytes, end, i + 1)) return true;
    return false;
  }
  return false;
}

function consumeName(bytes, end, i) {
  let j = i;
  while (j < end) {
    const b = bytes[j];
    if (isNameCharByte(b)) { j += 1; continue; }
    if (b === BACKSLASH && isValidEscapeStart(bytes, end, j)) { j = consumeEscape(bytes, end, j); continue; }
    break;
  }
  return j;
}

function isNumberStartAt(bytes, end, i) {
  let j = i;
  if (j < end && (bytes[j] === PLUS || bytes[j] === MINUS)) j += 1;
  if (j < end && isDigit(bytes[j])) return true;
  if (j < end && bytes[j] === DOT && j + 1 < end && isDigit(bytes[j + 1])) return true;
  return false;
}

function consumeNumber(bytes, end, i) {
  let j = i;
  if (j < end && (bytes[j] === PLUS || bytes[j] === MINUS)) j += 1;
  while (j < end && isDigit(bytes[j])) j += 1;
  if (j < end && bytes[j] === DOT && j + 1 < end && isDigit(bytes[j + 1])) { j += 2; while (j < end && isDigit(bytes[j])) j += 1; }
  if (j < end && (bytes[j] === 0x65 || bytes[j] === 0x45)) {
    let k = j + 1;
    if (k < end && (bytes[k] === PLUS || bytes[k] === MINUS)) k += 1;
    if (k < end && isDigit(bytes[k])) { j = k; while (j < end && isDigit(bytes[j])) j += 1; }
  }
  return j;
}

function isUrlKeyword(bytes, s, e) {
  if (e - s !== 3) return false;
  const w = String.fromCharCode(bytes[s], bytes[s + 1], bytes[s + 2]).toLowerCase();
  return w === "url";
}

/** Scans `url(` from the paren onward. Unquoted content is one atomic token; quoted content is left for normal function/string tokenizing. */
function scanUrl(bytes, end, parenIndex) {
  let j = parenIndex + 1;
  while (j < end && isWsByte(bytes[j])) j += 1;
  if (j < end && (bytes[j] === DQ || bytes[j] === SQ)) return { isFunction: true };
  while (j < end) {
    const c = bytes[j];
    if (c === RPAREN) return { isFunction: false, end: j + 1 };
    if (c === BACKSLASH && j + 1 < end) { j = consumeEscape(bytes, end, j); continue; }
    j += 1;
  }
  return { isFunction: false, end: j };
}

function mkDiag(code, offset, spanEnd, message) { return { code, severity: "warning", message, offset, end: spanEnd, line: null, column: null }; }

/** Single pass over the immutable source producing a flat token stream. */
export function tokenize(bytes, check) {
  const end = bytes.length;
  const tokens = [];
  const diagnostics = [];
  let i = 0;
  let stride = 0;
  while (i < end) {
    if ((stride++ & (TOKEN_STRIDE - 1)) === 0) check();
    const b = bytes[i];
    if (isWsByte(b)) { let j = i + 1; while (j < end && isWsByte(bytes[j])) j += 1; tokens.push({ type: "ws", s: i, e: j }); i = j; continue; }
    if (b === SLASH && i + 1 < end && bytes[i + 1] === STAR) {
      let j = i + 2; let closed = false;
      while (j < end) { if (bytes[j] === STAR && j + 1 < end && bytes[j + 1] === SLASH) { j += 2; closed = true; break; } j += 1; }
      if (!closed) { diagnostics.push(mkDiag("css.unclosed-comment", i, end, "unterminated comment runs to end of input")); j = end; }
      tokens.push({ type: "comment", s: i, e: j });
      i = j; continue;
    }
    if (b === DQ || b === SQ) {
      const quote = b; let j = i + 1; let closed = false;
      while (j < end) {
        const c = bytes[j];
        if (c === quote) { j += 1; closed = true; break; }
        if (c === LF) break;
        if (c === BACKSLASH) {
          if (j + 1 < end && bytes[j + 1] === LF) { j += 2; continue; }
          if (j + 1 < end) { j = consumeEscape(bytes, end, j); continue; }
          j += 1; continue;
        }
        j += 1;
      }
      if (!closed) diagnostics.push(mkDiag("css.unterminated-string", i, j, "unterminated string closes at end of line"));
      tokens.push({ type: "string", s: i, e: j });
      i = j; continue;
    }
    if (b === HASH) {
      if (i + 1 < end && (isNameCharByte(bytes[i + 1]) || isValidEscapeStart(bytes, end, i + 1))) {
        const j = consumeName(bytes, end, i + 1);
        tokens.push({ type: "hash", s: i, e: j }); i = j; continue;
      }
      tokens.push({ type: "delim", s: i, e: i + 1 }); i += 1; continue;
    }
    if (b === AT) {
      if (isIdentStartAt(bytes, end, i + 1)) { const j = consumeName(bytes, end, i + 1); tokens.push({ type: "at-keyword", s: i, e: j }); i = j; continue; }
      tokens.push({ type: "delim", s: i, e: i + 1 }); i += 1; continue;
    }
    if (isNumberStartAt(bytes, end, i)) {
      const numEnd = consumeNumber(bytes, end, i);
      if (numEnd < end && bytes[numEnd] === PERCENT) { tokens.push({ type: "percentage", s: i, e: numEnd + 1 }); i = numEnd + 1; continue; }
      if (isIdentStartAt(bytes, end, numEnd)) { const unitEnd = consumeName(bytes, end, numEnd); tokens.push({ type: "dimension", s: i, e: unitEnd }); i = unitEnd; continue; }
      tokens.push({ type: "number", s: i, e: numEnd }); i = numEnd; continue;
    }
    if (isIdentStartAt(bytes, end, i)) {
      const j = consumeName(bytes, end, i);
      if (j < end && bytes[j] === LPAREN && isUrlKeyword(bytes, i, j)) {
        const url = scanUrl(bytes, end, j);
        if (!url.isFunction) { tokens.push({ type: "url", s: i, e: url.end }); i = url.end; continue; }
      }
      tokens.push({ type: "ident", s: i, e: j }); i = j; continue;
    }
    switch (b) {
      case LBRACE: tokens.push({ type: "lbrace", s: i, e: i + 1 }); i += 1; continue;
      case RBRACE: tokens.push({ type: "rbrace", s: i, e: i + 1 }); i += 1; continue;
      case LPAREN: tokens.push({ type: "lparen", s: i, e: i + 1 }); i += 1; continue;
      case RPAREN: tokens.push({ type: "rparen", s: i, e: i + 1 }); i += 1; continue;
      case LBRACKET: tokens.push({ type: "lbracket", s: i, e: i + 1 }); i += 1; continue;
      case RBRACKET: tokens.push({ type: "rbracket", s: i, e: i + 1 }); i += 1; continue;
      case SEMI: tokens.push({ type: "semi", s: i, e: i + 1 }); i += 1; continue;
      case COMMA: tokens.push({ type: "comma", s: i, e: i + 1 }); i += 1; continue;
      case COLON: tokens.push({ type: "colon", s: i, e: i + 1 }); i += 1; continue;
      default: tokens.push({ type: "delim", s: i, e: i + 1 }); i += 1; continue;
    }
  }
  return { tokens, diagnostics };
}

// ---------------------------------------------------------------------------
// Structural pass: group the flat token stream into rules/declarations
// ---------------------------------------------------------------------------

/** A comment is standalone (its own beautified line) iff nothing but whitespace shares its source line on either side. */
function isStandaloneComment(bytes, s, e) {
  let a = s - 1;
  while (a >= 0 && (bytes[a] === SPACE || bytes[a] === TAB)) a -= 1;
  const beforeOk = a < 0 || bytes[a] === LF || bytes[a] === CR || bytes[a] === FF;
  let b = e;
  while (b < bytes.length && (bytes[b] === SPACE || bytes[b] === TAB)) b += 1;
  const afterOk = b >= bytes.length || bytes[b] === LF || bytes[b] === CR;
  return beforeOk && afterOk;
}

function isCustomPropertyIdent(bytes, tok) { return tok.e - tok.s >= 2 && bytes[tok.s] === MINUS && bytes[tok.s + 1] === MINUS; }

function trimWs(tokens, s, e) {
  let a = s, b = e;
  while (a < b && tokens[a].type === "ws") a += 1;
  while (b > a && tokens[b - 1].type === "ws") b -= 1;
  return { s: a, e: b };
}

function makeStatementItem(tokens, s, e, diagnostics) {
  if (tokens[s].type === "at-keyword") return { kind: "at-statement", s, e };
  let depth = 0;
  let colonIdx = -1;
  for (let k = s; k < e; k += 1) {
    const t = tokens[k];
    if (t.type === "lparen" || t.type === "lbracket") depth += 1;
    else if (t.type === "rparen" || t.type === "rbracket") { if (depth > 0) depth -= 1; }
    else if (t.type === "colon" && depth === 0) { colonIdx = k; break; }
  }
  if (colonIdx === -1) {
    diagnostics.push(mkDiag("css.declaration-no-colon", tokens[s].s, tokens[e - 1].e, "declaration has no colon; emitted as-is"));
    return { kind: "decl", hasColon: false, s, e };
  }
  return { kind: "decl", hasColon: true, propS: s, propE: colonIdx, valueS: colonIdx + 1, valueE: e };
}

/**
 * Recursive-descent structural pass. `isTop` distinguishes the document
 * level (a stray `}` is skipped, since nothing opened a block for it) from a
 * nested block (a `}` closes it; reaching end of input instead means it was
 * never closed, and the caller reports `css.unclosed-block`).
 */
function parseBlock(tokens, start, end, diagnostics, check, isTop) {
  const items = [];
  let i = start;
  let chunkStart = start;
  let chunkHasContent = false;
  let chunkIsCustomProperty = false;
  let depth = 0;

  const flush = (chunkEnd) => {
    if (!chunkHasContent) { chunkStart = chunkEnd; return; }
    const trimmed = trimWs(tokens, chunkStart, chunkEnd);
    items.push(makeStatementItem(tokens, trimmed.s, trimmed.e, diagnostics));
    chunkHasContent = false;
    chunkIsCustomProperty = false;
  };

  while (i < end) {
    if ((i & 1023) === 0) check();
    const tok = tokens[i];
    if (tok.type === "ws") { i += 1; continue; }
    if (tok.type === "comment") {
      if (depth === 0 && !chunkHasContent) {
        items.push({ kind: "comment", s: tok.s, e: tok.e, standalone: isStandaloneComment(tokens.bytes, tok.s, tok.e) });
        i += 1; chunkStart = i; continue;
      }
      chunkHasContent = true; i += 1; continue;
    }
    if (!chunkHasContent && tok.type === "ident") chunkIsCustomProperty = isCustomPropertyIdent(tokens.bytes, tok);
    // A custom property's value is an opaque token sequence per the CSS Custom Properties spec: a
    // brace-matched block inside it (`--x: { a: b }`) is never treated as a nested rule, and a `;`
    // inside such a block does not terminate the declaration (matches this file's "byte-for-byte"
    // requirement for complex custom-property values).
    if (chunkIsCustomProperty && tok.type === "lbrace") { depth += 1; chunkHasContent = true; i += 1; continue; }
    if (chunkIsCustomProperty && tok.type === "rbrace" && depth > 0) { depth -= 1; chunkHasContent = true; i += 1; continue; }
    if (tok.type === "lparen" || tok.type === "lbracket") { depth += 1; chunkHasContent = true; i += 1; continue; }
    if (tok.type === "rparen" || tok.type === "rbracket") { if (depth > 0) depth -= 1; chunkHasContent = true; i += 1; continue; }
    if (depth > 0) { chunkHasContent = true; i += 1; continue; }
    if (tok.type === "semi") { flush(i); i += 1; chunkStart = i; continue; }
    if (tok.type === "lbrace") {
      const prelude = trimWs(tokens, chunkStart, i);
      const sub = parseBlock(tokens, i + 1, end, diagnostics, check, false);
      if (!sub.closed) diagnostics.push(mkDiag("css.unclosed-block", tok.s, tok.e, "unclosed block is closed at end of input"));
      items.push({ kind: "rule", preludeS: prelude.s, preludeE: prelude.e, children: sub.items });
      i = sub.nextIdx; chunkStart = i; chunkHasContent = false; continue;
    }
    if (tok.type === "rbrace") {
      if (isTop) { flush(i); i += 1; chunkStart = i; continue; }
      flush(i);
      return { items, closed: true, nextIdx: i + 1 };
    }
    chunkHasContent = true; i += 1;
  }
  flush(end);
  return { items, closed: false, nextIdx: end };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
class Pieces {
  constructor() { this.parts = []; this.length = 0; }
  raw(bytes, s, e) { if (e > s) { this.parts.push(bytes.subarray(s, e)); this.length += e - s; } }
  lit(str) { if (str.length === 0) return; const b = encoder.encode(str); this.parts.push(b); this.length += b.length; }
  build() { const out = new Uint8Array(this.length); let pos = 0; for (const part of this.parts) { out.set(part, pos); pos += part.length; } return out; }
}

function isLicenseComment(bytes, token) { return token.e - token.s >= 3 && bytes[token.s + 2] === EXCL; }
function keepComment(bytes, options, mode, token) {
  if (!options.preserveComments) return false;
  if (mode === "minify") return isLicenseComment(bytes, token);
  return true;
}

function splitTopLevelCommas(tokens, s, e) {
  const parts = [];
  let depth = 0;
  let segStart = s;
  for (let k = s; k < e; k += 1) {
    const t = tokens[k];
    if (t.type === "lparen" || t.type === "lbracket") depth += 1;
    else if (t.type === "rparen" || t.type === "rbracket") { if (depth > 0) depth -= 1; }
    else if (t.type === "comma" && depth === 0) { parts.push(trimWs(tokens, segStart, k)); segStart = k + 1; }
  }
  parts.push(trimWs(tokens, segStart, e));
  return parts;
}

function isImportantIdent(bytes, token) {
  if (token.e - token.s !== 9) return false;
  return String.fromCharCode(...bytes.subarray(token.s, token.e)).toLowerCase() === "important";
}

/** Renders an arbitrary token span (a value, a selector, an at-rule prelude): whitespace runs collapse to one
 * space (beautify) or are removed except where two tokens would merge (minify); `!important` is normalised to
 * a single leading space with no internal space. With `tightenCommas` (declaration values only, per the
 * packet's "Values are never reformatted beyond ... removing spaces around `,` inside function arguments"), a
 * `,` inside a paren-nested function call loses its surrounding space; selectors keep their own `:is()`/
 * `:not()` internal comma spacing as ordinary collapsible whitespace, since the packet's tightening rule is
 * scoped to values, not selectors. */
function renderSpan(bytes, tokens, s, e, options, mode, pieces, tightenCommas = false) {
  let parenDepth = 0;
  let prevTok = null;
  let pendingGap = false;
  let forceNoGap = false;
  for (let idx = s; idx < e; idx += 1) {
    const tok = tokens[idx];
    if (tok.type === "ws") { pendingGap = true; continue; }
    if (tok.type === "comment") {
      if (keepComment(bytes, options, mode, tok)) {
        if (mode === "beautify" && prevTok !== null && !forceNoGap) pieces.lit(" ");
        pieces.raw(bytes, tok.s, tok.e);
        prevTok = tok; pendingGap = false; forceNoGap = false;
      } else { pendingGap = true; }
      continue;
    }
    if (mode === "beautify" && tok.type === "delim" && bytes[tok.s] === EXCL && tok.e - tok.s === 1) {
      let j = idx + 1;
      while (j < e && (tokens[j].type === "ws" || (tokens[j].type === "comment" && !keepComment(bytes, options, mode, tokens[j])))) j += 1;
      if (j < e && tokens[j].type === "ident" && isImportantIdent(bytes, tokens[j])) {
        if (prevTok !== null) pieces.lit(" ");
        pieces.lit("!");
        pieces.raw(bytes, tokens[j].s, tokens[j].e);
        prevTok = tokens[j]; pendingGap = false; forceNoGap = false;
        idx = j;
        continue;
      }
    }
    if (tok.type === "lparen") parenDepth += 1;
    if (tok.type === "rparen") { if (parenDepth > 0) parenDepth -= 1; }
    if (tightenCommas && tok.type === "comma" && parenDepth > 0) {
      pieces.lit(",");
      prevTok = tok; pendingGap = false; forceNoGap = true;
      continue;
    }
    if (!forceNoGap && pendingGap && prevTok !== null) {
      if (mode === "beautify") pieces.lit(" ");
      else if (needsGapForMinify(bytes, prevTok, tok)) pieces.lit(" ");
    }
    pieces.raw(bytes, tok.s, tok.e);
    prevTok = tok; pendingGap = false; forceNoGap = false;
  }
}

function isBarePlusMinus(bytes, tok) { return tok.type === "delim" && tok.e - tok.s === 1 && (bytes[tok.s] === PLUS || bytes[tok.s] === MINUS); }

/**
 * Whether an existing gap between two adjacent tokens must be kept (as exactly one space) when minifying,
 * because dropping it would change how the result re-tokenizes. Only consulted when a gap already existed in
 * the source; minify never inserts a gap that wasn't there. The general rule is a name-char/name-char
 * adjacency check (covers ident/dimension/number/hash/at-keyword, since strings/urls/comments/punctuation
 * never end or start on a name character); three extra cases aren't caught by that alone: a bare `+`/`-` next
 * to *anything* on either side (calc() requires whitespace on both sides of the operator regardless of the
 * operand's shape — a number, a parenthesised sub-expression, a function call — and dropping it would also
 * let a trailing `-`/`+` re-absorb into a following signed number), an ident or at-keyword directly before
 * `(` (would read as a function-token / lose its required separation, the `and (` case in a media feature),
 * and an at-keyword followed by anything at all (an at-rule's prelude always stays separated from its
 * keyword, e.g. `@import` before a string).
 */
function needsGapForMinify(bytes, prevTok, nextTok) {
  const prevLast = bytes[prevTok.e - 1];
  const nextFirst = bytes[nextTok.s];
  if (isNameCharByte(prevLast) && isNameCharByte(nextFirst)) return true;
  if (isBarePlusMinus(bytes, prevTok) || isBarePlusMinus(bytes, nextTok)) return true;
  if ((prevTok.type === "ident" || prevTok.type === "at-keyword") && nextTok.type === "lparen") return true;
  if (prevTok.type === "at-keyword") return true;
  return false;
}

function writeIndent(pieces, options, depth) { if (depth > 0) pieces.lit(options.indentUnit.repeat(depth)); }

function appendTrailingComment(pieces, bytes, options, mode, comment) {
  if (!comment || !keepComment(bytes, options, mode, comment)) return;
  if (mode === "beautify") pieces.lit(" ");
  pieces.raw(bytes, comment.s, comment.e);
}

function renderSelectorList(bytes, tokens, s, e, options, mode, pieces) {
  const parts = splitTopLevelCommas(tokens, s, e);
  for (let k = 0; k < parts.length; k += 1) {
    if (k > 0) pieces.lit(mode === "beautify" ? ", " : ",");
    renderSpan(bytes, tokens, parts[k].s, parts[k].e, options, mode, pieces);
  }
}

/** A custom property's value is copied verbatim (no whitespace collapsing, in either mode): per the CSS
 * Custom Properties spec its whitespace can be significant to whatever later consumes it via `var()`, and
 * the packet requires `--x: { a: b }`-style values emitted byte-for-byte. */
function renderCustomPropertyValue(bytes, tokens, valueS, valueE, pieces) {
  const trimmed = trimWs(tokens, valueS, valueE);
  if (trimmed.e > trimmed.s) pieces.raw(bytes, tokens[trimmed.s].s, tokens[trimmed.e - 1].e);
}

function renderDecl(bytes, tokens, item, depth, options, mode, pieces, trailingComment, dropSemicolon) {
  if (mode === "beautify") writeIndent(pieces, options, depth);
  if (item.hasColon) {
    renderSpan(bytes, tokens, item.propS, item.propE, options, mode, pieces);
    pieces.lit(":");
    if (mode === "beautify") pieces.lit(" ");
    if (isCustomPropertyIdent(bytes, tokens[item.propS])) renderCustomPropertyValue(bytes, tokens, item.valueS, item.valueE, pieces);
    else renderSpan(bytes, tokens, item.valueS, item.valueE, options, mode, pieces, true);
  } else {
    renderSpan(bytes, tokens, item.s, item.e, options, mode, pieces);
  }
  if (!dropSemicolon) pieces.lit(";");
  appendTrailingComment(pieces, bytes, options, mode, trailingComment);
  if (mode === "beautify") pieces.lit("\n");
}

function renderAtStatement(bytes, tokens, item, depth, options, mode, pieces, trailingComment, dropSemicolon) {
  if (mode === "beautify") writeIndent(pieces, options, depth);
  renderSpan(bytes, tokens, item.s, item.e, options, mode, pieces);
  if (!dropSemicolon) pieces.lit(";");
  appendTrailingComment(pieces, bytes, options, mode, trailingComment);
  if (mode === "beautify") pieces.lit("\n");
}

function renderRule(bytes, tokens, item, depth, options, mode, pieces, trailingComment) {
  if (mode === "beautify") writeIndent(pieces, options, depth);
  const isAtRule = item.preludeE > item.preludeS && tokens[item.preludeS].type === "at-keyword";
  if (item.preludeE > item.preludeS) {
    if (isAtRule) renderSpan(bytes, tokens, item.preludeS, item.preludeE, options, mode, pieces);
    else renderSelectorList(bytes, tokens, item.preludeS, item.preludeE, options, mode, pieces);
  }
  if (mode === "beautify") pieces.lit(" ");
  pieces.lit("{");
  let startIdx = 0;
  if (item.children.length > 0 && item.children[0].kind === "comment" && !item.children[0].standalone) {
    appendTrailingComment(pieces, bytes, options, mode, item.children[0]);
    startIdx = 1;
  }
  if (mode === "beautify") pieces.lit("\n");
  renderItems(bytes, tokens, item.children, startIdx, depth + 1, options, mode, pieces, false);
  if (mode === "beautify") writeIndent(pieces, options, depth);
  pieces.lit("}");
  appendTrailingComment(pieces, bytes, options, mode, trailingComment);
  if (mode === "beautify") pieces.lit("\n");
}

function renderItems(bytes, tokens, items, startIdx, depth, options, mode, pieces, isTop) {
  // The last `;` in a block is only safe to drop from the item that is the block's last STATEMENT (a
  // comment never needs a preceding `;`, so it doesn't count); a decl/at-statement followed by a nested
  // rule at the same level still needs its own `;` to separate the two.
  let lastStatementIdx = -1;
  for (let k = startIdx; k < items.length; k += 1) if (items[k].kind !== "comment") lastStatementIdx = k;
  const lastDeclLikeIdx = lastStatementIdx >= 0 && items[lastStatementIdx].kind !== "rule" ? lastStatementIdx : -1;

  let anyRuleEmitted = false;
  let i = startIdx;
  while (i < items.length) {
    const item = items[i];
    if (item.kind === "comment") {
      if (keepComment(bytes, options, mode, item)) {
        if (mode === "beautify") { writeIndent(pieces, options, depth); pieces.raw(bytes, item.s, item.e); pieces.lit("\n"); }
        else pieces.raw(bytes, item.s, item.e);
      }
      i += 1; continue;
    }
    let trailingComment = null;
    let consumed = 1;
    if (i + 1 < items.length && items[i + 1].kind === "comment" && !items[i + 1].standalone) { trailingComment = items[i + 1]; consumed = 2; }

    if (mode === "beautify" && isTop && options.blankLineBetweenRules && item.kind === "rule" && anyRuleEmitted) pieces.lit("\n");

    if (item.kind === "decl") renderDecl(bytes, tokens, item, depth, options, mode, pieces, trailingComment, mode === "minify" && i === lastDeclLikeIdx);
    else if (item.kind === "at-statement") renderAtStatement(bytes, tokens, item, depth, options, mode, pieces, trailingComment, mode === "minify" && i === lastDeclLikeIdx);
    else if (item.kind === "rule") { renderRule(bytes, tokens, item, depth, options, mode, pieces, trailingComment); anyRuleEmitted = true; }

    i += consumed;
  }
}

// ---------------------------------------------------------------------------
// Diagnostics positions, properties, entry point
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

function countItems(items, counts) {
  for (const item of items) {
    if (item.kind === "comment") counts.comments += 1;
    else if (item.kind === "decl") counts.declarations += 1;
    else if (item.kind === "at-statement") counts.atRules += 1;
    else if (item.kind === "rule") {
      if (item.__isAt) counts.atRules += 1; else counts.rules += 1;
      countItems(item.children, counts);
    }
  }
}

function outputCap(context) { return Math.min(context.limits.maxOutputBytes, context.limits.maxChunkBytes); }

export async function execute(request, context) {
  const operation = request?.operationId;
  if (!OPERATIONS.includes(operation)) throw new CssError("css.unsupported-operation", `unsupported operation ${operation}`);
  const check = cancellationCheck(context);
  check();
  const options = normalizeOptions(request?.options);
  const bytes = await readInput(context);
  if (bytes.byteLength === 0) throw new CssError("css.empty", "document is empty");

  const { tokens, diagnostics } = tokenize(bytes, check);
  tokens.bytes = bytes;
  const top = parseBlock(tokens, 0, tokens.length, diagnostics, check, true);
  markAtRules(top.items, tokens);
  resolvePositions(bytes, diagnostics);
  diagnostics.sort((a, b) => a.offset - b.offset);

  const counts = { rules: 0, declarations: 0, atRules: 0, comments: 0 };
  countItems(top.items, counts);

  const pieces = new Pieces();
  renderItems(bytes, tokens, top.items, 0, 0, options, operation, pieces, true);
  const cap = outputCap(context);
  if (pieces.length > cap) throw new CssError("css.output-limit", `${operation} output would be ${pieces.length} bytes, above the ${cap} byte output limit`);
  const output = pieces.build();

  const report = {
    operation,
    inputBytes: bytes.byteLength,
    outputBytes: output.byteLength,
    bytes: output.byteLength,
    rules: counts.rules,
    declarations: counts.declarations,
    atRules: counts.atRules,
    comments: counts.comments,
    diagnostics: diagnostics.length,
    diagnosticsDetail: diagnostics,
    limits: { maxInputBytes: context.limits.maxInputBytes, maxOutputBytes: cap },
  };
  await context.writeValue("output", report);
  await context.write("output", output);
  return report;
}

/** Marks every rule item's `__isAt` flag (needed by `countItems`); a separate pass keeps `parseBlock` grammar-agnostic. */
function markAtRules(items, tokens) {
  for (const item of items) {
    if (item.kind !== "rule") continue;
    item.__isAt = item.preludeE > item.preludeS && tokens[item.preludeS].type === "at-keyword";
    markAtRules(item.children, tokens);
  }
}
