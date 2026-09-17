import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";
import { C1_REMAP, LEGACY_MAX_LENGTH, NAME_MAX_LENGTH, NAMED_REFERENCES, PREFERRED_NAMES } from "./html-entities.mjs";

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
const CHECK_MASK = 4095;

/**
 * Every rejection carries a stable diagnostic code, the authoritative UTF-8
 * byte offset of the offending sequence, and derived line/column display
 * hints. The v2 SDK has no diagnostic emitter, so the same facts are folded
 * into the message; hosts that gain one can map the fields directly.
 */
export class EscapeError extends Error {
  constructor(code, detail, position = null, hint = null) {
    const where = position ? ` at byte offset ${position.byteOffset} (line ${position.line}, column ${position.column})` : "";
    super(`${detail}${where}${hint ? `; ${hint}` : ""}`);
    this.name = "EscapeError";
    this.code = code;
    this.byteOffset = position?.byteOffset ?? null;
    this.line = position?.line ?? null;
    this.column = position?.column ?? null;
    this.hint = hint;
  }
}

function check(context) {
  if (context.cancellation.isCancelled()) throw new ProcessorCancelled();
}

const isDigit = (code) => code >= 0x30 && code <= 0x39;
const isHex = (code) => isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
const isAlnum = (code) => isDigit(code) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
const isJsonWhitespace = (code) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
const hex2 = (value) => value.toString(16).padStart(2, "0");
const hex4 = (value) => value.toString(16).padStart(4, "0");
const upperHex4 = (value) => value.toString(16).toUpperCase().padStart(4, "0");
const excerpt = (text, index) => [...text.slice(index, index + 12)].slice(0, 8).join("");

/** Byte offset plus 1-based line and code-point column of a UTF-16 index. */
function position(text, index) {
  const prefix = text.slice(0, index);
  let line = 1;
  let lineStart = 0;
  for (let cursor = 0; cursor < prefix.length; cursor += 1) {
    if (prefix.charCodeAt(cursor) === 0x0a) { line += 1; lineStart = cursor + 1; }
  }
  return { byteOffset: encoder.encode(prefix).byteLength, line, column: [...prefix.slice(lineStart)].length + 1 };
}

/** Same shape as `position` computed over raw bytes, for input that never decoded. */
function bytePosition(bytes, byteOffset) {
  let line = 1;
  let column = 1;
  for (let cursor = 0; cursor < byteOffset; cursor += 1) {
    const byte = bytes[cursor];
    if (byte === 0x0a) { line += 1; column = 1; }
    else if ((byte & 0xc0) !== 0x80) column += 1;
  }
  return { byteOffset, line, column };
}

/** Offset of the first malformed UTF-8 sequence, or -1 when the bytes are valid. */
function firstInvalidUtf8(bytes) {
  for (let index = 0; index < bytes.length;) {
    const lead = bytes[index];
    if (lead < 0x80) { index += 1; continue; }
    let trailing;
    let minimum;
    if (lead >= 0xc2 && lead <= 0xdf) { trailing = 1; minimum = 0x80; }
    else if (lead >= 0xe0 && lead <= 0xef) { trailing = 2; minimum = 0x800; }
    else if (lead >= 0xf0 && lead <= 0xf4) { trailing = 3; minimum = 0x10000; }
    else return index;
    if (index + trailing >= bytes.length) return index;
    let codePoint = lead & (trailing === 1 ? 0x1f : trailing === 2 ? 0x0f : 0x07);
    for (let offset = 1; offset <= trailing; offset += 1) {
      const byte = bytes[index + offset];
      if ((byte & 0xc0) !== 0x80) return index;
      codePoint = (codePoint << 6) | (byte & 0x3f);
    }
    if (codePoint < minimum || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return index;
    index += trailing + 1;
  }
  return -1;
}

/**
 * Read the named `input` document through the bounded chunk reader. The SDK
 * enforces `maxInputBytes`; cancellation is checked between chunks. The bytes
 * are copied into processor memory, so the host's source is never touched.
 */
async function readInput(context) {
  const chunks = [];
  let length = 0;
  for await (const chunk of context.readChunks("input", 64 * 1024)) {
    check(context);
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return { text: fatalDecoder.decode(bytes), inputBytes: length }; }
  catch {
    const at = firstInvalidUtf8(bytes);
    throw new EscapeError("input.invalid-utf8", `input is not valid UTF-8 (byte 0x${hex2(bytes[at])})`, bytePosition(bytes, at), "the input document must be UTF-8 text");
  }
}

// ---------------------------------------------------------------------------
// HTML character references (WHATWG HTML, text context)
// ---------------------------------------------------------------------------

const HTML_UNSAFE = new Set([0x26, 0x3c, 0x3e, 0x22, 0x27]);

function htmlEscape(text, options, context) {
  let output = "";
  let sequences = 0;
  let seen = 0;
  for (const character of text) {
    if ((seen++ & CHECK_MASK) === 0) check(context);
    const codePoint = character.codePointAt(0);
    let escape;
    // HTML cannot express U+0000 as a reference, and browsers read &#128;-&#159;
    // as windows-1252 characters, so NUL and the C1 block stay literal.
    if (codePoint === 0 || (codePoint >= 0x80 && codePoint <= 0x9f)) escape = false;
    else if (options["encode-everything"]) escape = true;
    else if (codePoint < 0x20) escape = codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d;
    else if (codePoint < 0x7f) escape = !options["allow-unsafe-symbols"] && HTML_UNSAFE.has(codePoint);
    else escape = true; // DEL and every code point from U+00A0 upwards
    if (!escape) { output += character; continue; }
    sequences += 1;
    const name = options["prefer-named"] ? PREFERRED_NAMES.get(codePoint) : undefined;
    if (name !== undefined) output += `&${name};`;
    else output += options.numeric === "hex" ? `&#x${codePoint.toString(16).toUpperCase()};` : `&#${codePoint};`;
  }
  return { output, sequences };
}

const isNoncharacter = (value) => (value >= 0xfdd0 && value <= 0xfdef) || (value & 0xfffe) === 0xfffe;
const isControl = (value) => (value < 0x20 && value !== 0x09 && value !== 0x0a && value !== 0x0c) || (value >= 0x7f && value <= 0x9f);

function htmlUnescape(text, options, context) {
  const strict = options.strict;
  let output = "";
  let sequences = 0;
  let preserved = 0;
  let replaced = 0;
  let remapped = 0;
  let seen = 0;
  const missingSemicolon = (amp, reference) => new EscapeError("html.reference-missing-semicolon", `character reference "${reference}" is missing its terminating semicolon`, position(text, amp), `write "${reference};" or turn off strict mode`);
  for (let index = 0; index < text.length;) {
    if ((seen++ & CHECK_MASK) === 0) check(context);
    const amp = text.indexOf("&", index);
    if (amp < 0) { output += text.slice(index); break; }
    output += text.slice(index, amp);
    index = amp + 1;
    const next = text.charCodeAt(index);
    if (next === 0x23) {
      // Numeric character reference.
      let cursor = index + 1;
      const hex = text[cursor] === "x" || text[cursor] === "X";
      if (hex) cursor += 1;
      const digitsStart = cursor;
      while (cursor < text.length && (hex ? isHex(text.charCodeAt(cursor)) : isDigit(text.charCodeAt(cursor)))) cursor += 1;
      const digits = text.slice(digitsStart, cursor);
      if (digits.length === 0) {
        if (strict) throw new EscapeError("html.numeric-reference-empty", `numeric character reference "${text.slice(amp, cursor)}" has no digits`, position(text, amp), "write &#DDD; or &#xHHHH;, or turn off strict mode to keep it as text");
        output += text.slice(amp, cursor);
        index = cursor;
        preserved += 1;
        continue;
      }
      if (text[cursor] === ";") cursor += 1;
      else if (strict) throw missingSemicolon(amp, text.slice(amp, cursor));
      const reference = text.slice(amp, cursor);
      const value = digits.length > 8 ? Infinity : Number.parseInt(digits, hex ? 16 : 10);
      sequences += 1;
      index = cursor;
      if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
        if (strict) {
          const code = value === 0 ? "html.numeric-reference-null" : value > 0x10ffff ? "html.numeric-reference-out-of-range" : "html.numeric-reference-surrogate";
          const why = value === 0 ? "refers to U+0000, which HTML does not allow" : value > 0x10ffff ? "is above U+10FFFF" : `refers to surrogate U+${upperHex4(value)}, which is not a character`;
          throw new EscapeError(code, `numeric character reference "${reference}" ${why}`, position(text, amp), "browsers substitute U+FFFD; turn off strict mode to do the same");
        }
        output += "\ufffd";
        replaced += 1;
        continue;
      }
      const remap = C1_REMAP.get(value);
      if (remap !== undefined) {
        if (strict) throw new EscapeError("html.numeric-reference-control", `numeric character reference "${reference}" is the C1 control U+${upperHex4(value)}`, position(text, amp), `browsers read it as U+${upperHex4(remap)} (${String.fromCodePoint(remap)}) via windows-1252; turn off strict mode to apply that remapping`);
        output += String.fromCodePoint(remap);
        remapped += 1;
        continue;
      }
      if (strict && isNoncharacter(value)) throw new EscapeError("html.numeric-reference-noncharacter", `numeric character reference "${reference}" is the noncharacter U+${upperHex4(value)}`, position(text, amp), "turn off strict mode to decode it anyway");
      if (strict && isControl(value)) throw new EscapeError("html.numeric-reference-control", `numeric character reference "${reference}" is the control character U+${upperHex4(value)}`, position(text, amp), "only tab, line feed and form feed may be referenced in strict mode; turn it off to decode anyway");
      output += String.fromCodePoint(value);
      continue;
    }
    if (isAlnum(next)) {
      // Named character reference: the longest table entry wins, exactly as the
      // WHATWG tokenizer consumes it. Legacy names match without a semicolon.
      let runEnd = index;
      while (runEnd < text.length && isAlnum(text.charCodeAt(runEnd))) runEnd += 1;
      const terminated = text[runEnd] === ";";
      const full = terminated && runEnd - index < NAME_MAX_LENGTH ? NAMED_REFERENCES.get(`${text.slice(index, runEnd)};`) : undefined;
      if (full !== undefined) {
        output += full;
        index = runEnd + 1;
        sequences += 1;
        continue;
      }
      let legacy;
      let legacyEnd = index;
      for (let length = Math.min(LEGACY_MAX_LENGTH, runEnd - index); length > 0; length -= 1) {
        const candidate = NAMED_REFERENCES.get(text.slice(index, index + length));
        if (candidate !== undefined) { legacy = candidate; legacyEnd = index + length; break; }
      }
      if (legacy !== undefined) {
        if (strict) throw missingSemicolon(amp, text.slice(amp, legacyEnd));
        output += legacy;
        index = legacyEnd;
        sequences += 1;
        continue;
      }
      if (terminated) {
        if (strict) throw new EscapeError("html.unknown-named-reference", `"${text.slice(amp, runEnd + 1)}" is not a named character reference`, position(text, amp), "names are case-sensitive; turn off strict mode to keep it as text");
        output += text.slice(amp, runEnd + 1);
        index = runEnd + 1;
        preserved += 1;
        continue;
      }
    }
    // A bare ampersand is ordinary text in every mode.
    output += "&";
  }
  return { output, sequences, preserved, replaced, remapped };
}

// ---------------------------------------------------------------------------
// JSON string literals (RFC 8259 section 7)
// ---------------------------------------------------------------------------

const JSON_SHORT = new Map([[0x08, "\\b"], [0x0c, "\\f"], [0x0a, "\\n"], [0x0d, "\\r"], [0x09, "\\t"]]);
const JSON_SIMPLE = new Map([[0x22, "\""], [0x5c, "\\"], [0x2f, "/"], [0x62, "\b"], [0x66, "\f"], [0x6e, "\n"], [0x72, "\r"], [0x74, "\t"]]);

function jsonEscape(text, options, context) {
  let body = "";
  let sequences = 0;
  for (let index = 0; index < text.length; index += 1) {
    if ((index & CHECK_MASK) === 0) check(context);
    const code = text.charCodeAt(index);
    let escaped;
    if (code === 0x22) escaped = "\\\"";
    else if (code === 0x5c) escaped = "\\\\";
    else if (code < 0x20) escaped = JSON_SHORT.get(code) ?? `\\u${hex4(code)}`;
    else if (code > 0x7e && options["ascii-only"]) escaped = `\\u${hex4(code)}`;
    else { body += text[index]; continue; }
    body += escaped;
    sequences += 1;
  }
  return { output: options.quotes === "omit" ? body : `"${body}"`, sequences };
}

function parseHex(text, start, count) {
  if (start + count > text.length) return -1;
  let value = 0;
  for (let cursor = start; cursor < start + count; cursor += 1) {
    const code = text.charCodeAt(cursor);
    if (!isHex(code)) return -1;
    value = value * 16 + Number.parseInt(text[cursor], 16);
  }
  return value;
}

function jsonExpectedString(text, index) {
  const at = position(text, index);
  if (index >= text.length) return new EscapeError("json.expected-string", "expected a JSON string literal but the input is empty or only whitespace", at, "wrap the text in double quotes, or set quotes to omit to unescape a bare string body");
  const found = text[index];
  if (found === "{" || found === "[") return new EscapeError("json.expected-string", `expected a JSON string literal, found "${found}" (the start of a JSON document)`, at, "this tool handles one string value; format whole documents with the JSON tool");
  return new EscapeError("json.expected-string", `expected a JSON string literal starting with a double quote, found "${excerpt(text, index)}"`, at, "wrap the text in double quotes, or set quotes to omit to unescape a bare string body");
}

function jsonInvalidEscape(text, at) {
  const kind = String.fromCodePoint(text.codePointAt(at + 1));
  const hints = {
    "'": "JSON does not escape single quotes; write ' directly",
    x: "JSON has no \\x escape; write \\u00HH",
    v: "write \\u000b",
    a: "write \\u0007",
    e: "write \\u001b",
    U: "JSON has no \\U escape; write a \\uXXXX surrogate pair",
    "\n": "JSON has no line continuations; write \\n",
    "\r": "JSON has no line continuations; write \\r\\n",
  };
  const hint = hints[kind] ?? (isDigit(kind.charCodeAt(0)) ? "JSON has no octal or \\0 escapes; write \\u0000 style escapes" : "valid escapes are \\\" \\\\ \\/ \\b \\f \\n \\r \\t and \\uXXXX");
  return new EscapeError("json.invalid-escape", `"\\${kind === "\n" ? "<LF>" : kind === "\r" ? "<CR>" : kind}" is not a JSON escape`, position(text, at), hint);
}

function jsonUnescape(text, options, context) {
  const quoted = options.quotes !== "omit";
  let index = 0;
  if (quoted) {
    while (index < text.length && isJsonWhitespace(text.charCodeAt(index))) index += 1;
    if (text[index] !== "\"") throw jsonExpectedString(text, index);
    index += 1;
  }
  const open = index - 1;
  let output = "";
  let sequences = 0;
  let closed = !quoted;
  let seen = 0;
  while (index < text.length) {
    if ((seen++ & CHECK_MASK) === 0) check(context);
    const code = text.charCodeAt(index);
    if (code === 0x22) {
      if (quoted) { closed = true; index += 1; break; }
      throw new EscapeError("json.unescaped-quote", "a raw double quote is not allowed inside a JSON string body", position(text, index), "escape it as \\\" or set quotes to include");
    }
    if (code < 0x20) throw new EscapeError("json.unescaped-control", `raw control character U+${upperHex4(code)} must be escaped`, position(text, index), `write ${JSON_SHORT.get(code) ?? `\\u${hex4(code)}`}`);
    if (code !== 0x5c) { output += text[index]; index += 1; continue; }
    const at = index;
    if (at + 1 >= text.length) throw new EscapeError("json.incomplete-escape", "escape sequence is cut off at the end of the input", position(text, at), "write \\\\ for a literal backslash");
    const simple = JSON_SIMPLE.get(text.charCodeAt(at + 1));
    if (simple !== undefined) { output += simple; index = at + 2; sequences += 1; continue; }
    if (text[at + 1] !== "u") throw jsonInvalidEscape(text, at);
    const unit = parseHex(text, at + 2, 4);
    if (unit < 0) throw new EscapeError("json.invalid-unicode-escape", `\\u must be followed by exactly four hexadecimal digits, found "${excerpt(text, at)}"`, position(text, at));
    index = at + 6;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = text.startsWith("\\u", index) ? parseHex(text, index + 2, 4) : -1;
      if (low < 0xdc00 || low > 0xdfff) throw new EscapeError("json.lone-surrogate", `\\u${hex4(unit)} is a high surrogate without a following low surrogate escape`, position(text, at), "a character outside the BMP needs a \\uD800-\\uDBFF \\uDC00-\\uDFFF pair");
      output += String.fromCharCode(unit, low);
      index += 6;
      sequences += 2;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) throw new EscapeError("json.lone-surrogate", `\\u${hex4(unit)} is a low surrogate without a preceding high surrogate escape`, position(text, at), "a character outside the BMP needs a \\uD800-\\uDBFF \\uDC00-\\uDFFF pair");
    output += String.fromCharCode(unit);
    sequences += 1;
  }
  if (quoted) {
    if (!closed) throw new EscapeError("json.unterminated-string", "the JSON string literal is never closed", position(text, open), "add a closing double quote");
    let rest = index;
    while (rest < text.length && isJsonWhitespace(text.charCodeAt(rest))) rest += 1;
    if (rest < text.length) throw new EscapeError("json.trailing-content", `unexpected content after the closing quote: "${excerpt(text, rest)}"`, position(text, rest), "exactly one JSON string literal is accepted; format whole documents with the JSON tool");
  }
  return { output, sequences };
}

// ---------------------------------------------------------------------------
// Backslash escape sequences (this package's own grammar; see README)
// ---------------------------------------------------------------------------

const BACKSLASH_SHORT = new Map([[0x5c, "\\\\"], [0x0a, "\\n"], [0x0d, "\\r"], [0x09, "\\t"], [0x08, "\\b"], [0x0c, "\\f"], [0x0b, "\\v"]]);
const BACKSLASH_SIMPLE = new Map([["\\", "\\"], ["n", "\n"], ["r", "\r"], ["t", "\t"], ["b", "\b"], ["f", "\f"], ["v", "\v"], ["\"", "\""], ["'", "'"]]);
const BACKSLASH_GRAMMAR = "supported escapes are \\\\ \\n \\r \\t \\b \\f \\v \\0 \\\" \\' \\xHH \\uHHHH and \\u{H...}";

function backslashEscape(text, options, context) {
  let output = "";
  let sequences = 0;
  let seen = 0;
  const escapeDouble = options.quotes === "both" || options.quotes === "double";
  const escapeSingle = options.quotes === "both" || options.quotes === "single";
  for (let index = 0; index < text.length;) {
    if ((seen++ & CHECK_MASK) === 0) check(context);
    const codePoint = text.codePointAt(index);
    const width = codePoint > 0xffff ? 2 : 1;
    let escaped = null;
    if (BACKSLASH_SHORT.has(codePoint)) escaped = BACKSLASH_SHORT.get(codePoint);
    else if (codePoint === 0) escaped = isDigit(text.charCodeAt(index + 1)) ? "\\x00" : "\\0";
    else if (codePoint < 0x20 || codePoint === 0x7f) escaped = `\\x${hex2(codePoint)}`;
    else if (codePoint === 0x22) escaped = escapeDouble ? "\\\"" : null;
    else if (codePoint === 0x27) escaped = escapeSingle ? "\\'" : null;
    else if (codePoint < 0x80) escaped = null;
    else if (codePoint < 0xa0) escaped = `\\u${hex4(codePoint)}`; // C1 controls are always escaped
    else if (options["non-ascii"] === "keep") escaped = null;
    else if (codePoint > 0xffff) escaped = options["non-ascii"] === "utf16" ? `\\u${hex4(text.charCodeAt(index))}\\u${hex4(text.charCodeAt(index + 1))}` : `\\u{${codePoint.toString(16)}}`;
    else escaped = `\\u${hex4(codePoint)}`;
    if (escaped === null) output += text.slice(index, index + width);
    else { output += escaped; sequences += 1; }
    index += width;
  }
  return { output, sequences };
}

function backslashUnknownEscape(text, at) {
  const kind = String.fromCodePoint(text.codePointAt(at + 1));
  const hints = {
    a: "write \\x07 for the bell character",
    e: "write \\x1b for the escape character",
    "/": "the backslash grammar has no \\/; the JSON string tool accepts it",
    U: "write \\u{HHHHHH} instead of an eight-digit \\U escape",
    "\n": "line continuations are not supported; write \\n",
    "\r": "line continuations are not supported; write \\r\\n",
  };
  const hint = hints[kind] ?? (isDigit(kind.charCodeAt(0)) ? "octal escapes are not supported; write \\xHH" : BACKSLASH_GRAMMAR);
  return new EscapeError("backslash.unknown-escape", `"\\${kind === "\n" ? "<LF>" : kind === "\r" ? "<CR>" : kind}" is not a recognised escape`, position(text, at), hint);
}

function backslashUnescape(text, options, context) {
  let output = "";
  let sequences = 0;
  let seen = 0;
  const loneSurrogate = (at, reference, detail) => new EscapeError("backslash.lone-surrogate", `${reference} ${detail}`, position(text, at), "a character outside the BMP is \\u{HHHHH} or a \\uD800-\\uDBFF \\uDC00-\\uDFFF pair");
  for (let index = 0; index < text.length;) {
    if ((seen++ & CHECK_MASK) === 0) check(context);
    const at = text.indexOf("\\", index);
    if (at < 0) { output += text.slice(index); break; }
    output += text.slice(index, at);
    if (at + 1 >= text.length) throw new EscapeError("backslash.incomplete-escape", "a lone backslash ends the input", position(text, at), "write \\\\ for a literal backslash");
    const kind = text[at + 1];
    const simple = BACKSLASH_SIMPLE.get(kind);
    if (simple !== undefined) { output += simple; index = at + 2; sequences += 1; continue; }
    if (kind === "0") {
      if (isDigit(text.charCodeAt(at + 2))) throw new EscapeError("backslash.ambiguous-octal", `"\\0${text[at + 2]}" is ambiguous: \\0 followed by a digit is a legacy octal escape in some languages and NUL plus a digit in others`, position(text, at), "write \\x00 or \\u0000 before the digit");
      output += "\0";
      index = at + 2;
      sequences += 1;
      continue;
    }
    if (kind === "x") {
      const value = parseHex(text, at + 2, 2);
      if (value < 0) throw new EscapeError("backslash.invalid-hex-escape", `\\x must be followed by exactly two hexadecimal digits, found "${excerpt(text, at)}"`, position(text, at));
      if (value >= 0x80) throw new EscapeError("backslash.ambiguous-hex-escape", `\\x${hex2(value)} is ambiguous: it is a raw UTF-8 byte in some languages and the code point U+00${hex2(value).toUpperCase()} in others`, position(text, at), `write \\u00${hex2(value)} for the code point`);
      output += String.fromCharCode(value);
      index = at + 4;
      sequences += 1;
      continue;
    }
    if (kind === "u") {
      if (text[at + 2] === "{") {
        const close = text.indexOf("}", at + 3);
        if (close < 0) throw new EscapeError("backslash.unterminated-unicode-escape", "\\u{ is never closed with }", position(text, at));
        const digits = text.slice(at + 3, close);
        if (!/^[0-9A-Fa-f]{1,6}$/u.test(digits)) throw new EscapeError("backslash.invalid-unicode-escape", `\\u{...} needs one to six hexadecimal digits, found "${text.slice(at, close + 1)}"`, position(text, at));
        const codePoint = Number.parseInt(digits, 16);
        if (codePoint > 0x10ffff) throw new EscapeError("backslash.unicode-escape-out-of-range", `\\u{${digits}} is above U+10FFFF`, position(text, at));
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) throw loneSurrogate(at, `\\u{${digits}}`, "is a surrogate code point, not a character");
        output += String.fromCodePoint(codePoint);
        index = close + 1;
        sequences += 1;
        continue;
      }
      const unit = parseHex(text, at + 2, 4);
      if (unit < 0) throw new EscapeError("backslash.invalid-unicode-escape", `\\u must be followed by exactly four hexadecimal digits or a {...} group, found "${excerpt(text, at)}"`, position(text, at));
      index = at + 6;
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const low = text.startsWith("\\u", index) ? parseHex(text, index + 2, 4) : -1;
        if (low < 0xdc00 || low > 0xdfff) throw loneSurrogate(at, `\\u${hex4(unit)}`, "is a high surrogate without a following low surrogate escape");
        output += String.fromCharCode(unit, low);
        index += 6;
        sequences += 2;
        continue;
      }
      if (unit >= 0xdc00 && unit <= 0xdfff) throw loneSurrogate(at, `\\u${hex4(unit)}`, "is a low surrogate without a preceding high surrogate escape");
      output += String.fromCharCode(unit);
      sequences += 1;
      continue;
    }
    throw backslashUnknownEscape(text, at);
  }
  return { output, sequences };
}

// ---------------------------------------------------------------------------
// Options, dispatch and output
// ---------------------------------------------------------------------------

function enumOption(options, id, choices, fallback) {
  const value = options[id] ?? fallback;
  if (!choices.includes(value)) throw new EscapeError("option.invalid", `option ${id} must be one of ${choices.join(", ")}, got ${JSON.stringify(value)}`);
  return value;
}

function booleanOption(options, id, fallback) {
  const value = options[id] ?? fallback;
  if (typeof value !== "boolean") throw new EscapeError("option.invalid", `option ${id} must be true or false, got ${JSON.stringify(value)}`);
  return value;
}

const OPERATIONS = {
  "text.html": {
    normalize: (raw) => ({
      numeric: enumOption(raw, "numeric", ["decimal", "hex"], "decimal"),
      "prefer-named": booleanOption(raw, "prefer-named", true),
      "encode-everything": booleanOption(raw, "encode-everything", false),
      "allow-unsafe-symbols": booleanOption(raw, "allow-unsafe-symbols", false),
      strict: booleanOption(raw, "strict", true),
    }),
    escape: htmlEscape,
    unescape: htmlUnescape,
  },
  "text.json-string": {
    normalize: (raw) => ({
      quotes: enumOption(raw, "quotes", ["include", "omit"], "include"),
      "ascii-only": booleanOption(raw, "ascii-only", false),
    }),
    escape: jsonEscape,
    unescape: jsonUnescape,
  },
  "text.backslash": {
    normalize: (raw) => ({
      quotes: enumOption(raw, "quotes", ["both", "double", "single", "none"], "both"),
      "non-ascii": enumOption(raw, "non-ascii", ["keep", "unicode", "utf16"], "keep"),
    }),
    escape: backslashEscape,
    unescape: backslashUnescape,
  },
};

/**
 * The v2 sink stores one artifact per `write`, so an artifact is bounded by
 * `maxChunkBytes` as well as `maxOutputBytes`. The smaller bound is enforced
 * here with an explicit message instead of the generic SDK rejection.
 */
async function emit(context, summary, result) {
  const bytes = encoder.encode(result.output);
  const limit = Math.min(context.limits.maxOutputBytes, context.limits.maxChunkBytes);
  if (bytes.byteLength > limit) throw new EscapeError("limit.output", `output of ${bytes.byteLength} bytes exceeds the ${limit} byte output limit (maxOutputBytes ${context.limits.maxOutputBytes}, maxChunkBytes ${context.limits.maxChunkBytes})`, null, "the sink accepts one artifact chunk; shrink the input or raise both limits");
  const { output, ...counters } = result;
  const value = { ...summary, outputBytes: bytes.byteLength, ...counters, text: output, complete: true };
  await context.writeValue("output", value);
  await context.write("output", bytes);
  return value;
}

export async function execute(request, context) {
  const operationId = request?.operationId;
  const operation = OPERATIONS[operationId];
  if (!operation) throw new EscapeError("operation.unknown", `unsupported operation ${JSON.stringify(operationId)}`, null, `expected one of ${Object.keys(OPERATIONS).join(", ")}`);
  const raw = request?.options ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new EscapeError("option.invalid", "options must be an object");
  const mode = enumOption(raw, "mode", ["escape", "unescape"], "escape");
  const options = operation.normalize(raw);
  // Option ids are the manifest's kebab-case identifiers. A misspelt or
  // camel-cased key is rejected instead of silently falling back to a default.
  const unknown = Object.keys(raw).filter((key) => key !== "mode" && !(key in options));
  if (unknown.length > 0) throw new EscapeError("option.unknown", `unknown option ${unknown.map((key) => JSON.stringify(key)).join(", ")} for ${operationId}`, null, `declared options are mode, ${Object.keys(options).join(", ")}`);
  const { text, inputBytes } = await readInput(context);
  const result = (mode === "escape" ? operation.escape : operation.unescape)(text, options, context);
  return emit(context, { operationId, mode, options, inputBytes }, result);
}
