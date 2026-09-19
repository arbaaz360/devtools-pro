import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";

/**
 * Literal Unicode find and replace over one UTF-8 text input.
 *
 * The query is never compiled into a regular expression: search is a plain
 * code-unit comparison, case-insensitive search compares per-code-point
 * simple case foldings, and the replacement is inserted verbatim. Match
 * offsets refer to the source document as UTF-16 code units (editor offsets)
 * and UTF-8 bytes (contract offsets). Every limit below is a package
 * constant; byte limits come from the injected SDK context.
 */

export const OPERATION_ID = "text.find-replace";
export const MODES = Object.freeze(["find", "replace", "replaceAll"]);
export const limits = Object.freeze({
  /** Largest source or result text, in UTF-16 code units. */
  maxTextLength: 1024 * 1024,
  /** Largest query or replacement, in UTF-16 code units. */
  maxQueryLength: 1024 * 1024,
  /** Match offsets listed in the report. Counts stay exact past this bound. */
  maxMatches: 10_000,
  /** Cooperative cancellation is polled at least once per this many steps. */
  checkEvery: 4096,
});

const encoder = new TextEncoder();
// ignoreBOM keeps a leading U+FEFF as text so source bytes round-trip exactly.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const WORD_CHARACTER = /^[\p{L}\p{N}\p{M}_]$/u; // constant; never built from user input

/** A structured processor diagnostic. The SDK has no diagnostic emitter, so fatal ones are thrown. */
export class FindReplaceError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "FindReplaceError";
    this.code = code;
    this.diagnostic = diagnostic(code, "error", message, data);
  }
}

function diagnostic(code, severity, message, data) {
  return data === undefined ? { code, severity, message } : { code, severity, message, data };
}

function check(context) {
  if (context.cancellation.isCancelled()) throw new ProcessorCancelled();
}

// ---------------------------------------------------------------------------
// Options

function invalid(message, data) {
  return new FindReplaceError("find.invalid-option", message, data);
}

function stringOption(options, id, maxLength) {
  const value = options[id];
  if (value === undefined) return "";
  if (typeof value !== "string") throw invalid(`${id} must be a string`, { option: id, received: typeof value });
  if (value.length > maxLength) throw invalid(`${id} is limited to ${maxLength} UTF-16 code units`, { option: id, length: value.length, limit: maxLength });
  if (!value.isWellFormed()) throw invalid(`${id} must be well-formed Unicode text without lone surrogates`, { option: id });
  return value;
}

/** Manifest ids are kebab-case identifiers; the camelCase spelling used by the shell is accepted as an alias. */
function booleanOption(options, ids, fallback) {
  const supplied = ids.filter((id) => options[id] !== undefined);
  if (supplied.length === 0) return fallback;
  for (const id of supplied) if (typeof options[id] !== "boolean") throw invalid(`${id} must be a boolean`, { option: id, received: typeof options[id] });
  if (supplied.length > 1 && options[supplied[0]] !== options[supplied[1]]) throw invalid(`${supplied[0]} and ${supplied[1]} disagree`, { options: supplied });
  return options[supplied[0]];
}

const CASE_SENSITIVE = ["case-sensitive", "caseSensitive"];
const WHOLE_WORD = ["whole-word", "wholeWord"];
const KNOWN_OPTIONS = new Set(["query", "replacement", "mode", ...CASE_SENSITIVE, ...WHOLE_WORD]);

export function normalizeOptions(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid("options must be an object", { received: Array.isArray(raw) ? "array" : typeof raw });
  for (const key of Object.keys(raw)) if (!KNOWN_OPTIONS.has(key)) throw invalid(`unknown option ${key}`, { option: key, known: [...KNOWN_OPTIONS] });
  const mode = raw.mode === undefined ? "find" : raw.mode;
  if (!MODES.includes(mode)) throw invalid(`mode must be one of ${MODES.join(", ")}`, { option: "mode", received: mode });
  return {
    query: stringOption(raw, "query", limits.maxQueryLength),
    replacement: stringOption(raw, "replacement", limits.maxQueryLength),
    mode,
    caseSensitive: booleanOption(raw, CASE_SENSITIVE, true),
    wholeWord: booleanOption(raw, WHOLE_WORD, false),
  };
}

// ---------------------------------------------------------------------------
// Input

async function readText(context) {
  const chunks = [];
  let length = 0;
  for await (const chunk of context.readChunks("input", 65536)) {
    check(context);
    length += chunk.byteLength;
    if (length > context.limits.maxInputBytes) throw new FindReplaceError("find.input-limit", `input exceeds ${context.limits.maxInputBytes} bytes`, { bytes: length, limit: context.limits.maxInputBytes });
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let text;
  try { text = decoder.decode(bytes); } catch { throw new FindReplaceError("find.invalid-utf8", "input is not valid UTF-8 text", { bytes: length }); }
  if (text.length > limits.maxTextLength) throw new FindReplaceError("find.input-limit", `input exceeds ${limits.maxTextLength} UTF-16 code units`, { length: text.length, limit: limits.maxTextLength });
  return { text, inputBytes: length };
}

// ---------------------------------------------------------------------------
// Case folding

const foldCache = new Map();

/**
 * CaseFolding.txt status-S entries whose uppercase is not one code point, so
 * the upper-then-lower derivation in foldCodePoint cannot reach them: the
 * precomposed ΐ and ΰ and the ligature pair ﬅ/ﬆ.
 */
const FOLD_EXCEPTIONS = new Map([[0x1fd3, 0x0390], [0x1fe3, 0x03b0], [0xfb05, 0xfb06]]);

/**
 * Simple case folding of one code point, equivalent to ECMAScript's u-mode
 * Canonicalize (CaseFolding.txt statuses C and S). Upper-then-lower maps the
 * one-to-many and symbol variants (ς→σ, µ→μ, ſ→s, ẞ→ß, K→k) onto their
 * class; anything whose mapping is not one code point folds to itself.
 * Dotless ı has only a Turkic mapping and therefore stays distinct from i.
 * FOLD_EXCEPTIONS covers the three pairs this derivation cannot see.
 */
export function foldCodePoint(codePoint) {
  if (codePoint < 0x80) return codePoint >= 0x41 && codePoint <= 0x5a ? codePoint + 0x20 : codePoint;
  if (codePoint === 0x131) return codePoint;
  const exception = FOLD_EXCEPTIONS.get(codePoint);
  if (exception !== undefined) return exception;
  const cached = foldCache.get(codePoint);
  if (cached !== undefined) return cached;
  const single = (value) => value.length > 0 && value.length <= 2 && String.fromCodePoint(value.codePointAt(0)) === value;
  const character = String.fromCodePoint(codePoint);
  let folded = codePoint;
  const upper = character.toUpperCase();
  if (single(upper)) {
    const lower = upper.toLowerCase();
    if (single(lower)) folded = lower.codePointAt(0);
    else folded = fallbackLower(character, codePoint);
  } else folded = fallbackLower(character, codePoint);
  foldCache.set(codePoint, folded);
  return folded;
}

function fallbackLower(character, codePoint) {
  const lower = character.toLowerCase();
  return lower.length > 0 && lower.length <= 2 && String.fromCodePoint(lower.codePointAt(0)) === lower ? lower.codePointAt(0) : codePoint;
}

/**
 * Accumulates text without holding one string per piece: pieces are joined
 * every `checkEvery` pushes, so folding a one MiB document or replacing a
 * one-character query keeps a few hundred chunks rather than a million slices.
 */
class TextBuilder {
  constructor() { this.chunks = []; this.parts = []; }
  push(piece) {
    this.parts.push(piece);
    if (this.parts.length >= limits.checkEvery) { this.chunks.push(this.parts.join("")); this.parts.length = 0; }
  }
  toString() { if (this.parts.length) { this.chunks.push(this.parts.join("")); this.parts.length = 0; } return this.chunks.join(""); }
}

/**
 * Fold a whole string. `map[i]` is the source UTF-16 offset of folded offset
 * `i`; folded and source lengths can differ when a code point folds across
 * the BMP boundary, so offsets are always translated back through it.
 */
function foldText(text, context) {
  const builder = new TextBuilder();
  const map = new Int32Array(text.length * 2 + 1);
  let folded = 0;
  let steps = 0;
  for (let index = 0; index < text.length;) {
    if ((steps++ & (limits.checkEvery - 1)) === 0) check(context);
    const codePoint = text.codePointAt(index);
    const width = codePoint > 0xffff ? 2 : 1;
    const target = foldCodePoint(codePoint);
    const targetWidth = target > 0xffff ? 2 : 1;
    builder.push(String.fromCodePoint(target));
    for (let unit = 0; unit < targetWidth; unit++) map[folded + unit] = index;
    folded += targetWidth;
    index += width;
  }
  map[folded] = text.length;
  return { text: builder.toString(), map: map.subarray(0, folded + 1) };
}

// ---------------------------------------------------------------------------
// Search

function isWordCharacterAt(text, index) {
  if (index < 0 || index >= text.length) return false;
  const unit = text.charCodeAt(index);
  const start = unit >= 0xdc00 && unit <= 0xdfff ? index - 1 : index;
  return WORD_CHARACTER.test(String.fromCodePoint(text.codePointAt(start)));
}

function isWholeWord(text, start, end) {
  return !isWordCharacterAt(text, start - 1) && !isWordCharacterAt(text, end);
}

/**
 * Enumerate literal, non-overlapping occurrences from left to right. After an
 * accepted match the scan resumes at its end; after a candidate rejected by the
 * whole-word test it resumes at the next offset where a word can begin, so no
 * bounded occurrence is skipped. `visit` receives source offsets. Cancellation
 * is polled every `checkEvery` candidates.
 *
 * The whole needle goes to `indexOf`, which uses the engine's substring search
 * and stays linear for a long query over repetitive text; locating the first
 * code unit and confirming with `startsWith` cost O(query) per candidate.
 */
function scan(source, haystack, needle, map, wholeWord, context, visit) {
  let candidates = 0;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    if ((candidates++ & (limits.checkEvery - 1)) === 0) check(context);
    const start = map ? map[at] : at;
    const end = map ? map[at + needle.length] : at + needle.length;
    if (wholeWord && !isWholeWord(source, start, end)) { from = nextWordStart(source, haystack, map, at + 1); continue; }
    visit(start, end);
    from = at + needle.length;
  }
}

/**
 * First haystack offset at or after `from` where a whole word can begin: the
 * source code point before it is not a word character. A whole-word scan
 * resumes here after a rejected candidate, so each offset is examined at most
 * once and a query rejected everywhere still costs linear time.
 */
function nextWordStart(source, haystack, map, from) {
  let offset = from;
  while (offset < haystack.length && isWordCharacterAt(source, (map ? map[offset] : offset) - 1)) offset += 1;
  return offset;
}

function utf8Length(codePoint) {
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

/** Translate sorted UTF-16 offsets to UTF-8 byte offsets in one forward pass. */
function byteOffsets(text, matches, context) {
  let unit = 0;
  let byte = 0;
  let steps = 0;
  const advance = (target) => {
    while (unit < target) {
      if ((steps++ & (limits.checkEvery - 1)) === 0) check(context);
      const codePoint = text.codePointAt(unit);
      byte += utf8Length(codePoint);
      unit += codePoint > 0xffff ? 2 : 1;
    }
    return byte;
  };
  return matches.map((match) => {
    const startByte = advance(match.start);
    const endByte = advance(match.end);
    return { start: match.start, end: match.end, startByte, endByte };
  });
}

// ---------------------------------------------------------------------------
// Output

/** Pretty JSON with one match or diagnostic per line, so key order and layout are fixed. */
function serialize(report) {
  const lines = ["{"];
  const keys = Object.keys(report);
  keys.forEach((key, index) => {
    const value = report[key];
    const comma = index < keys.length - 1 ? "," : "";
    if (Array.isArray(value)) {
      if (value.length === 0) { lines.push(`  ${JSON.stringify(key)}: []${comma}`); return; }
      lines.push(`  ${JSON.stringify(key)}: [`);
      value.forEach((item, position) => lines.push(`    ${JSON.stringify(item)}${position < value.length - 1 ? "," : ""}`));
      lines.push(`  ]${comma}`);
      return;
    }
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}`);
  });
  lines.push("}");
  return lines.join("\n") + "\n";
}

async function emit(context, report) {
  check(context);
  const bytes = encoder.encode(serialize(report));
  // The SDK sink publishes one write per port, so the report is one chunk.
  const limit = Math.min(context.limits.maxOutputBytes, context.limits.maxChunkBytes);
  if (bytes.byteLength > limit) throw new FindReplaceError("find.output-limit", `report would be ${bytes.byteLength} bytes, above the ${limit} byte output limit`, { bytes: bytes.byteLength, limit });
  await context.writeValue("output", report);
  await context.write("output", bytes);
  return report;
}

// ---------------------------------------------------------------------------
// Entry point

export async function execute(request, context) {
  check(context);
  if (request?.operationId !== undefined && request.operationId !== OPERATION_ID) {
    throw new FindReplaceError("find.unsupported-operation", `unsupported operation ${request.operationId}`, { operationId: request.operationId, supported: [OPERATION_ID] });
  }
  const options = normalizeOptions(request?.options);
  const { text, inputBytes } = await readText(context);
  const diagnostics = [];

  let haystack = text;
  let needle = options.query;
  let map = null;
  if (!options.caseSensitive && options.query.length > 0) {
    const folded = foldText(text, context);
    haystack = folded.text;
    map = folded.map;
    needle = foldText(options.query, context).text;
  }

  // One left-to-right pass lists bounded offsets, counts every match exactly,
  // and splices replacements. Counting past the listing bound is bounded by
  // the input length, so the exact count costs nothing extra.
  const listed = [];
  const builder = new TextBuilder();
  const replaceLimit = options.mode === "find" ? 0 : options.mode === "replace" ? 1 : Infinity;
  let matchCount = 0;
  let replacementCount = 0;
  let cursor = 0;
  let outputLength = text.length;
  if (options.query.length === 0) diagnostics.push(diagnostic("find.empty-query", "info", "the query is empty, so nothing was matched"));
  else scan(text, haystack, needle, map, options.wholeWord, context, (start, end) => {
    matchCount += 1;
    if (listed.length < limits.maxMatches) listed.push({ start, end });
    if (replacementCount < replaceLimit) {
      builder.push(text.slice(cursor, start));
      builder.push(options.replacement);
      cursor = end;
      replacementCount += 1;
      outputLength += options.replacement.length - (end - start);
      if (outputLength > limits.maxTextLength) throw new FindReplaceError("find.output-limit", `result would exceed ${limits.maxTextLength} UTF-16 code units`, { length: outputLength, limit: limits.maxTextLength });
    }
  });
  builder.push(text.slice(cursor));
  const output = replacementCount === 0 ? text : builder.toString();

  const matchesTruncated = matchCount > listed.length;
  if (matchesTruncated) diagnostics.push(diagnostic("find.match-limit", "warning", `${matchCount} matches found; only the first ${limits.maxMatches} offsets are listed`, { matchCount, limit: limits.maxMatches }));

  return emit(context, {
    operation: OPERATION_ID,
    mode: options.mode,
    query: options.query,
    replacement: options.replacement,
    caseSensitive: options.caseSensitive,
    wholeWord: options.wholeWord,
    matchCount,
    replacementCount,
    matchLimit: limits.maxMatches,
    matchesTruncated,
    matches: byteOffsets(text, listed, context),
    inputBytes,
    inputLength: text.length,
    outputBytes: encoder.encode(output).byteLength,
    outputLength: output.length,
    text: output,
    diagnostics,
    complete: true,
  });
}
