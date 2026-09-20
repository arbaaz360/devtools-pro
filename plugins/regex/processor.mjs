import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";

/**
 * ECMAScript regular expression tester over one UTF-8 text input.
 *
 * The pattern is compiled with `new RegExp(pattern, flags)`: this is the
 * ECMAScript flavour, never ICU. Match offsets are UTF-16 code-unit offsets
 * into the decoded input, matching `String#index`/`String#length` and the
 * annotation contract the shell renders. Every limit below is a package
 * constant; byte limits for the input come from the injected SDK context.
 */

export const OPERATION_ID = "text.regex";
export const MODES = Object.freeze(["match", "replace"]);
export const limits = Object.freeze({
  /** Largest pattern, in UTF-8 bytes. */
  maxPatternBytes: 4 * 1024,
  /** Largest source text, in UTF-16 code units (mirrors the manifest's 4 MiB input limit). */
  maxTextLength: 4 * 1024 * 1024,
  /** Match entries listed in the report. `count` stays exact past this bound. */
  maxMatches: 10_000,
  /** Annotation entries listed in the report, across matches and groups together. */
  maxAnnotations: 20_000,
  /** Cooperative cancellation is polled at least once per this many matches. */
  checkEvery: 256,
});

const encoder = new TextEncoder();
// ignoreBOM keeps a leading U+FEFF as text so source bytes round-trip exactly.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A structured processor diagnostic. The SDK has no diagnostic emitter, so fatal ones are thrown. */
export class RegexError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "RegexError";
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
  return new RegexError("regex.invalid-option", message, data);
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

const GLOBAL = ["global"];
const IGNORE_CASE = ["ignore-case", "ignoreCase"];
const MULTILINE = ["multiline"];
const DOT_ALL = ["dot-all", "dotAll"];
const UNICODE = ["unicode"];
const STICKY = ["sticky"];
const KNOWN_OPTIONS = new Set(["pattern", "mode", "replacement", ...GLOBAL, ...IGNORE_CASE, ...MULTILINE, ...DOT_ALL, ...UNICODE, ...STICKY]);

export function normalizeOptions(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid("options must be an object", { received: Array.isArray(raw) ? "array" : typeof raw });
  for (const key of Object.keys(raw)) if (!KNOWN_OPTIONS.has(key)) throw invalid(`unknown option ${key}`, { option: key, known: [...KNOWN_OPTIONS] });
  const mode = raw.mode === undefined ? "match" : raw.mode;
  if (!MODES.includes(mode)) throw invalid(`mode must be one of ${MODES.join(", ")}`, { option: "mode", received: mode });
  const pattern = stringOption(raw, "pattern", Number.MAX_SAFE_INTEGER);
  const patternBytes = encoder.encode(pattern).byteLength;
  if (patternBytes > limits.maxPatternBytes) throw invalid(`pattern is limited to ${limits.maxPatternBytes} bytes`, { option: "pattern", bytes: patternBytes, limit: limits.maxPatternBytes });
  return {
    pattern,
    mode,
    replacement: stringOption(raw, "replacement", 1024 * 1024),
    global: booleanOption(raw, GLOBAL, true),
    ignoreCase: booleanOption(raw, IGNORE_CASE, false),
    multiline: booleanOption(raw, MULTILINE, false),
    dotAll: booleanOption(raw, DOT_ALL, false),
    unicode: booleanOption(raw, UNICODE, false),
    sticky: booleanOption(raw, STICKY, false),
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
    if (length > context.limits.maxInputBytes) throw new RegexError("regex.input-limit", `input exceeds ${context.limits.maxInputBytes} bytes`, { bytes: length, limit: context.limits.maxInputBytes });
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let text;
  try { text = decoder.decode(bytes); } catch { throw new RegexError("regex.invalid-utf8", "input is not valid UTF-8 text", { bytes: length }); }
  if (text.length > limits.maxTextLength) throw new RegexError("regex.input-limit", `input exceeds ${limits.maxTextLength} UTF-16 code units`, { length: text.length, limit: limits.maxTextLength });
  return { text, inputBytes: length };
}

// ---------------------------------------------------------------------------
// Pattern compilation and group numbering

export function buildFlags(options) {
  let flags = "";
  if (options.global) flags += "g";
  if (options.ignoreCase) flags += "i";
  if (options.multiline) flags += "m";
  if (options.dotAll) flags += "s";
  if (options.unicode) flags += "u";
  if (options.sticky) flags += "y";
  return flags;
}

/** `new RegExp` is always compiled with an added `d` flag so group spans are available via `match.indices`. */
function compilePattern(pattern, flags) {
  try {
    return new RegExp(pattern, `${flags}d`);
  } catch (error) {
    if (error instanceof SyntaxError) throw new RegexError("regex.invalid-pattern", error.message, { pattern, flags });
    throw error;
  }
}

/**
 * Number and name every capturing group left to right, the same order the
 * engine assigns `$1`, `$2`, ... Non-capturing groups `(?:`, lookaround
 * `(?=` `(?!` `(?<=` `(?<!`, escapes, and bracketed character classes are
 * skipped without consuming a group number. Returns a 1-indexed array;
 * `names[0]` is unused and `names.length - 1` is the group count.
 */
export function parseGroupNames(pattern) {
  const names = [null];
  let index = 0;
  let inClass = false;
  while (index < pattern.length) {
    const character = pattern[index];
    if (character === "\\") { index += 2; continue; }
    if (inClass) {
      if (character === "]") inClass = false;
      index += 1;
      continue;
    }
    if (character === "[") { inClass = true; index += 1; continue; }
    if (character === "(") {
      if (pattern[index + 1] === "?") {
        const third = pattern[index + 2];
        if (third === ":" || third === "=" || third === "!") { index += 3; continue; }
        if (third === "<") {
          const fourth = pattern[index + 3];
          if (fourth === "=" || fourth === "!") { index += 4; continue; }
          const close = pattern.indexOf(">", index + 3);
          names.push(pattern.slice(index + 3, close));
          index = close + 1;
          continue;
        }
        index += 2;
        continue;
      }
      names.push(null);
      index += 1;
      continue;
    }
    index += 1;
  }
  return names;
}

// ---------------------------------------------------------------------------
// Match mode

function recordMatch(match, groupNames, groupCount) {
  const start = match.index;
  const text = match[0];
  const end = start + text.length;
  const groups = [];
  const named = {};
  for (let number = 1; number <= groupCount; number += 1) {
    const span = match.indices[number];
    const name = groupNames[number];
    const entry = span === undefined
      ? { number, name, index: null, end: null, text: null }
      : { number, name, index: span[0], end: span[1], text: match[number] };
    groups.push(entry);
    if (name !== null) named[name] = entry;
  }
  return { index: start, end, text, groups, named };
}

function pushAnnotations(annotations, match, label) {
  if (annotations.length < limits.maxAnnotations) annotations.push({ start: match.index, end: match.end, kind: "match", label });
  for (const group of match.groups) {
    if (group.index === null) continue;
    if (annotations.length >= limits.maxAnnotations) break;
    annotations.push({ start: group.index, end: group.end, kind: "group", label: group.name ?? String(group.number) });
  }
}

function runMatch(text, regex, groupNames, groupCount, options, context) {
  const matches = [];
  const annotations = [];
  let count = 0;

  const consider = (raw) => {
    if ((count & (limits.checkEvery - 1)) === 0) check(context);
    if (count < limits.maxMatches) {
      const match = recordMatch(raw, groupNames, groupCount);
      matches.push(match);
      pushAnnotations(annotations, match, `#${count + 1}`);
    }
    count += 1;
  };

  if (options.global) {
    for (const raw of text.matchAll(regex)) consider(raw);
  } else {
    check(context);
    const raw = regex.exec(text);
    if (raw) consider(raw);
  }

  return { matches, annotations, count, truncated: count > matches.length };
}

function formatMatchText(matches) {
  if (matches.length === 0) return "";
  const lines = [];
  matches.forEach((match, position) => {
    lines.push(`#${position + 1} [${match.index}-${match.end}] ${match.text}`);
    for (const group of match.groups) lines.push(`  ${group.name ?? group.number}: ${group.text ?? ""}`);
  });
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Replace mode

function runReplace(text, regex, options, context) {
  let replacements = 0;
  if (options.global) {
    for (const _raw of text.matchAll(regex)) {
      if ((replacements & (limits.checkEvery - 1)) === 0) check(context);
      replacements += 1;
    }
  } else {
    check(context);
    if (regex.exec(text)) replacements = 1;
  }
  // `exec` above may have advanced a sticky regex's `lastIndex`; `replace` must start fresh.
  regex.lastIndex = 0;
  check(context);
  const replacedText = text.replace(regex, options.replacement);
  return { replacedText, replacements };
}

// ---------------------------------------------------------------------------
// Output

async function emit(context, report) {
  check(context);
  const bytes = encoder.encode(`${JSON.stringify(report)}\n`);
  const limit = Math.min(context.limits.maxOutputBytes, context.limits.maxChunkBytes);
  if (bytes.byteLength > limit) throw new RegexError("regex.output-limit", `report would be ${bytes.byteLength} bytes, above the ${limit} byte output limit`, { bytes: bytes.byteLength, limit });
  await context.writeValue("output", report);
  await context.write("output", bytes);
  return report;
}

function baseFields(options, flags, inputBytes, inputLength) {
  return {
    operation: OPERATION_ID,
    mode: options.mode,
    pattern: options.pattern,
    replacement: options.replacement,
    global: options.global,
    ignoreCase: options.ignoreCase,
    multiline: options.multiline,
    dotAll: options.dotAll,
    unicode: options.unicode,
    sticky: options.sticky,
    flavor: "ecmascript",
    flags,
    inputBytes,
    inputLength,
  };
}

// ---------------------------------------------------------------------------
// Entry point

export async function execute(request, context) {
  check(context);
  if (request?.operationId !== undefined && request.operationId !== OPERATION_ID) {
    throw new RegexError("regex.unsupported-operation", `unsupported operation ${request.operationId}`, { operationId: request.operationId, supported: [OPERATION_ID] });
  }
  const options = normalizeOptions(request?.options);
  const { text, inputBytes } = await readText(context);
  const flags = buildFlags(options);
  const base = baseFields(options, flags, inputBytes, text.length);

  if (options.pattern.length === 0) {
    const emptyText = options.mode === "replace" ? text : "";
    return emit(context, {
      ...base,
      count: 0,
      truncated: false,
      matches: [],
      annotations: [],
      replacements: 0,
      outputBytes: encoder.encode(emptyText).byteLength,
      outputLength: emptyText.length,
      text: emptyText,
      complete: true,
    });
  }

  const regex = compilePattern(options.pattern, flags);
  const groupNames = parseGroupNames(options.pattern);
  const groupCount = groupNames.length - 1;

  if (options.mode === "match") {
    const { matches, annotations, count, truncated } = runMatch(text, regex, groupNames, groupCount, options, context);
    const rendered = formatMatchText(matches);
    return emit(context, {
      ...base,
      count,
      truncated,
      matches,
      annotations,
      replacements: 0,
      outputBytes: encoder.encode(rendered).byteLength,
      outputLength: rendered.length,
      text: rendered,
      complete: true,
    });
  }

  const { replacedText, replacements } = runReplace(text, regex, options, context);
  return emit(context, {
    ...base,
    count: replacements,
    truncated: false,
    matches: [],
    annotations: [],
    replacements,
    outputBytes: encoder.encode(replacedText).byteLength,
    outputLength: replacedText.length,
    text: replacedText,
    complete: true,
  });
}
