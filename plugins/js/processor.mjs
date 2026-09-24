import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";
import { js_beautify } from "../../packages/vendor/js-beautify/js-beautify.mjs";
import { parse as parseJs } from "../../packages/vendor/acorn/acorn.mjs";

export class JsError extends Error {
  constructor(code, message, data) {
    super(code + ": " + message);
    this.name = "JsError";
    this.code = code;
    this.diagnostic = { code, severity: "error", message, data };
  }
}

function invalid(message, data) {
  return new JsError("js.invalid-option", message, data);
}

const KNOWN_OPTIONS = new Set([
  "indent", "brace-style", "braceStyle", "preserve-newlines", "preserveNewlines",
  "max-preserve-newlines", "maxPreserveNewlines", "space-in-parens", "spaceInParens",
  "end-with-newline", "endWithNewline", "preserve-comments", "preserveComments"
]);

export function normalizeOptions(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid("options must be an object", { received: Array.isArray(raw) ? "array" : typeof raw });
  for (const key of Object.keys(raw)) {
    if (!KNOWN_OPTIONS.has(key)) throw invalid("unknown option " + key, { option: key, known: [...KNOWN_OPTIONS] });
  }

  const indent = raw.indent === undefined ? "space-2" : raw.indent;
  if (!["space-2", "space-4", "tab"].includes(indent)) throw invalid("indent must be space-2, space-4, tab", { option: "indent", received: indent });

  let braceStyle = "collapse";
  if (raw["brace-style"] !== undefined) braceStyle = raw["brace-style"];
  else if (raw["braceStyle"] !== undefined) braceStyle = raw["braceStyle"];
  if (!["collapse", "expand", "end-expand"].includes(braceStyle)) throw invalid("brace-style must be collapse, expand, end-expand", { option: "brace-style", received: braceStyle });

  let preserveNewlines = true;
  if (raw["preserve-newlines"] !== undefined) preserveNewlines = raw["preserve-newlines"];
  else if (raw["preserveNewlines"] !== undefined) preserveNewlines = raw["preserveNewlines"];
  if (typeof preserveNewlines !== "boolean") throw invalid("preserve-newlines must be boolean", { option: "preserve-newlines", received: typeof preserveNewlines });

  let maxPreserveNewlines = 2;
  if (raw["max-preserve-newlines"] !== undefined) maxPreserveNewlines = raw["max-preserve-newlines"];
  else if (raw["maxPreserveNewlines"] !== undefined) maxPreserveNewlines = raw["maxPreserveNewlines"];
  if (typeof maxPreserveNewlines !== "number" || !Number.isInteger(maxPreserveNewlines) || maxPreserveNewlines < 0 || maxPreserveNewlines > 10) throw invalid("max-preserve-newlines must be integer 0-10", { option: "max-preserve-newlines", received: maxPreserveNewlines });

  let spaceInParens = false;
  if (raw["space-in-parens"] !== undefined) spaceInParens = raw["space-in-parens"];
  else if (raw["spaceInParens"] !== undefined) spaceInParens = raw["spaceInParens"];
  if (typeof spaceInParens !== "boolean") throw invalid("space-in-parens must be boolean", { option: "space-in-parens", received: typeof spaceInParens });

  let endWithNewline = true;
  if (raw["end-with-newline"] !== undefined) endWithNewline = raw["end-with-newline"];
  else if (raw["endWithNewline"] !== undefined) endWithNewline = raw["endWithNewline"];
  if (typeof endWithNewline !== "boolean") throw invalid("end-with-newline must be boolean", { option: "end-with-newline", received: typeof endWithNewline });

  let preserveComments = "license";
  if (raw["preserve-comments"] !== undefined) preserveComments = raw["preserve-comments"];
  else if (raw["preserveComments"] !== undefined) preserveComments = raw["preserveComments"];
  if (!["none", "license"].includes(preserveComments)) throw invalid("preserve-comments must be none, license", { option: "preserve-comments", received: preserveComments });

  return { indent, braceStyle, preserveNewlines, maxPreserveNewlines, spaceInParens, endWithNewline, preserveComments };
}

export async function execute(request, context) {
  const op = request?.operationId ?? "beautify";
  const options = normalizeOptions(request?.options);
  if (op === "beautify") return await beautify(context, options);
  else if (op === "minify") return await minify(context, options);
  else throw new Error("unknown operation " + op);
}

async function readText(context) {
  let length = 0;
  const chunks = [];
  for await (const chunk of context.readChunks("input", 65536)) {
    if (context.cancellation.isCancelled()) throw new ProcessorCancelled();
    length += chunk.byteLength;
    if (length > context.limits.maxInputBytes) throw new JsError("js.input-limit", "input exceeds max bytes");
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

async function emit(context, text, result) {
  const outBytes = new TextEncoder().encode(text);
  if (outBytes.byteLength > context.limits.maxOutputBytes) throw new JsError("js.output-limit", "output exceeds max bytes");
  const value = { ...result, lines: text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0), bytes: outBytes.byteLength };
  await context.writeValue("output", value);
  await context.write("output", outBytes);
  return value;
}

// ---------------------------------------------------------------------------
// Reading JavaScript: acorn, not a hand-written tokenizer.
//
// Owner decision (2026-09-25, docs/DEVUTILS_REQUIREMENTS.md): three reviews found input
// classes a hand-written tokenizer got wrong without saying so (a regex after `)`, a
// template after `return`, Unicode names). Both operations now read the program with a
// real parser, and accept their own output only if it parses to the same syntax tree.
// ---------------------------------------------------------------------------

const ACORN = { ecmaVersion: "latest", allowHashBang: true };
// A CommonJS file may `return` at top level (Node wraps it in a function), and so may a
// function body pasted on its own; neither is valid in a module.
const GOAL = { script: { allowReturnOutsideFunction: true }, module: {} };

/**
 * The program as a script, else as a module. A script comes first: code valid both ways
 * means what it means as a script, the way a <script> tag or Node's CommonJS runs it; a
 * module is strict and reserves `await`. When neither parses, the error that got further
 * into the text is the one reported.
 */
function parseProgram(text) {
  let failure = null;
  for (const sourceType of ["script", "module"]) {
    const tokens = [];
    const comments = [];
    try {
      const ast = parseJs(text, { ...ACORN, ...GOAL[sourceType], sourceType, onToken: tokens, onComment: comments });
      return { ast, tokens: tokens.filter((token) => token.type.label !== "eof"), comments, sourceType };
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      if (!failure || (error.pos ?? 0) > (failure.pos ?? 0)) failure = error;
    }
  }
  return { failure };
}

function reparse(text, sourceType) {
  try { return parseJs(text, { ...ACORN, ...GOAL[sourceType], sourceType }); } catch { return null; }
}

/** Keys that say where a node is, not what it is. */
const POSITION_KEYS = new Set(["start", "end", "loc", "range"]);

/**
 * Whether two syntax trees are the same program: every node type, name, operator and
 * value alike, positions aside. A literal is compared by its value (and a regex by pattern
 * and flags), not its spelling; a template's raw text counts, since String.raw reads it.
 * Iterative, so a deeply nested program cannot overflow the stack.
 */
export function sameTree(left, right) {
  const stack = [[left, right]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (a === b) continue;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
      if (typeof a === "number" && typeof b === "number" && Object.is(a, b)) continue;
      return false;
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) stack.push([a[i], b[i]]);
      continue;
    }
    if (a.type !== b.type) return false;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (POSITION_KEYS.has(key)) continue;
      if (a.type === "Literal" && (key === "raw" || (key === "value" && (a.regex || a.bigint !== undefined)))) continue;
      stack.push([a[key], b[key]]);
    }
  }
  return true;
}

function hasLineBreak(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

const WORD_END = /[\p{ID_Continue}$]$/u;
const WORD_START = /^[\p{ID_Continue}$\\#]/u;

/** Whether two tokens printed touching would read as something else. */
function needsSpace(prevText, nextText, prev) {
  if (WORD_END.test(prevText) && WORD_START.test(nextText)) return true;            // let x, 1 in a, /a/g in b
  if (prev.type.label === "regexp" && WORD_START.test(nextText)) return true;       // /a/ in b: `in` would be flags
  const a = prevText[prevText.length - 1];
  const b = nextText[0];
  if ((a === "+" || a === "-") && b === a) return true;                              // a - -b, a+ ++b
  if (a === "/" && (b === "/" || b === "*")) return true;                            // a / /re/, /re/ / b
  if (a === "<" && nextText.startsWith("!--")) return true;                          // <!-- opens a comment in a script
  if (prev.type.label === "num" && b === ".") return true;                           // 1 .toString()
  return false;
}

/** Tokens after which a line break is part of the grammar (a restricted production). */
const RESTRICTED = new Set(["return", "throw", "break", "continue", "yield", "async", "let"]);
/** Tokens that can end an expression: only after one does a line break before `++`/`--` matter. */
const ENDS_EXPRESSION = new Set(["name", "num", "string", "regexp", "privateId", ")", "]", "}", "`", "this", "super", "true", "false", "null", "++/--"]);

function isLicense(comment, text) {
  const body = text.slice(comment.start, comment.end);
  return body.startsWith("/*!") || body.includes("@license") || body.includes("@preserve");
}

/**
 * Tokens joined with the least separation that reads as the same tokens. A line break in
 * the source survives after a restricted token or before `++`/`--`, or everywhere when
 * `keepLineBreaks` is set (the fallback when the compact form parses to another tree).
 */
function joinTokens(text, parsed, { keepLicense, keepLineBreaks, check }) {
  const license = keepLicense ? parsed.comments.filter((comment) => isLicense(comment, text)) : [];
  const hashbang = text.startsWith("#!") ? text.slice(0, text.search(/\r\n|[\n\r]|$/)) : "";
  const parts = hashbang ? [hashbang] : [];
  let prev = null;
  let prevText = "";
  let next = 0; // the next licence comment to place
  let cursor = hashbang.length;
  const tokens = parsed.tokens;
  for (let index = 0; index <= tokens.length; index += 1) {
    if (index % 4096 === 0) check();
    const token = tokens[index];
    const gapEnd = token ? token.start : text.length;
    const gap = text.slice(cursor, gapEnd);
    const kept = [];
    while (next < license.length && license[next].start < gapEnd) {
      if (license[next].start >= cursor) kept.push(text.slice(license[next].start, license[next].end));
      next += 1;
    }
    const lineBreak = hasLineBreak(gap);
    let separator = "";
    if (kept.length) {
      // A kept line comment ends with a line break, and a block comment keeps the gap's
      // kind: a line break the comment spanned may be one the grammar reads. A comment
      // is whitespace to the lexer, so it needs a space before it only after `/`, where
      // `/` + `/*` would read as a line comment.
      separator = lineBreak ? `${parts.length ? "\n" : ""}${kept.join("\n")}\n` : `${prev ? " " : ""}${kept.join(" ")}`;
    } else if (!token) {
      separator = "";
    } else if (prev && lineBreak && (keepLineBreaks || RESTRICTED.has(prevText) || (token.type.label === "++/--" && ENDS_EXPRESSION.has(prev.type.label)))) {
      separator = "\n";
    } else if (hashbang && !prev) {
      separator = "\n";
    } else if (gap === "") {
      // Tokens that touched in the source touch in the output. This is also what keeps a
      // template's own text whole: `a${` is two tokens with nothing between them.
      separator = "";
    } else if (prev && needsSpace(prevText, text.slice(token.start, token.end), prev)) {
      separator = " ";
    }
    if (!token) {
      if (kept.length) parts.push(separator.trimEnd() + (lineBreak ? "\n" : ""));
      break;
    }
    const tokenText = text.slice(token.start, token.end);
    parts.push(separator, tokenText);
    prev = token;
    prevText = tokenText;
    cursor = token.end;
  }
  return parts.join("");
}

function counts(parsed) {
  let strings = 0, templates = 0, regexes = 0;
  for (const token of parsed.tokens) {
    if (token.type.label === "string") strings += 1;
    else if (token.type.label === "regexp") regexes += 1;
    else if (token.type.label === "`") templates += 1;
  }
  return { comments: parsed.comments.length, strings, templates: templates / 2, regexes };
}

function syntaxError(failure) {
  const where = failure.loc ? ` at line ${failure.loc.line}, column ${failure.loc.column + 1}` : "";
  return new JsError("js.syntax-error", `${failure.message.replace(/ \(\d+:\d+\)$/, "")}${where}; the input is not JavaScript this tool can read, so it cannot show the output means the same`, {
    line: failure.loc?.line ?? null, column: failure.loc ? failure.loc.column + 1 : null, offset: failure.pos ?? null,
  });
}

async function minify(context, options) {
  const text = await readText(context);
  if (text === "") return emit(context, "", { comments: 0, strings: 0, templates: 0, regexes: 0, diagnostics: 0, verified: true });
  const parsed = parseProgram(text);
  if (!parsed.ast) throw syntaxError(parsed.failure);
  const check = () => { if (context.cancellation.isCancelled()) throw new ProcessorCancelled(); };
  const keepLicense = options.preserveComments === "license";
  // The compact form first; where it would parse as another program, the source's own line
  // breaks; and if even that differs, a refusal rather than a changed program.
  for (const keepLineBreaks of [false, true]) {
    const out = joinTokens(text, parsed, { keepLicense, keepLineBreaks, check });
    const tree = reparse(out, parsed.sourceType);
    if (tree && sameTree(parsed.ast, tree)) return emit(context, out, { ...counts(parsed), diagnostics: 0, verified: true });
  }
  throw new JsError("js.minify.changes-meaning", "Minify could not produce a program that parses the same as the input; nothing was written", null);
}

async function beautify(context, options) {
  const text = await readText(context);
  if (text === "") return emit(context, "", { comments: 0, strings: 0, templates: 0, regexes: 0, diagnostics: 0, verified: true });
  const beautifyOptions = {
    indent_size: options.indent === "tab" ? 1 : (options.indent === "space-4" ? 4 : 2),
    indent_with_tabs: options.indent === "tab",
    brace_style: options.braceStyle,
    preserve_newlines: options.preserveNewlines,
    max_preserve_newlines: options.maxPreserveNewlines,
    space_in_empty_paren: options.spaceInParens,
    space_in_paren: options.spaceInParens,
    end_with_newline: options.endWithNewline
  };
  let formatted;
  try {
    formatted = js_beautify(text, beautifyOptions);
  } catch (err) {
    throw new JsError("format.js-beautify", err.message, null);
  }
  const parsed = parseProgram(text);
  if (!parsed.ast) {
    // Not JavaScript acorn can read (a fragment, JSX, TypeScript): js-beautify still lays it
    // out, and the result says it was not checked rather than implying it was.
    const where = parsed.failure.loc ? ` (line ${parsed.failure.loc.line}, column ${parsed.failure.loc.column + 1})` : "";
    return emit(context, formatted, { comments: 0, strings: 0, templates: 0, regexes: 0, diagnostics: 1, verified: false,
      note: `Not checked: the input does not parse as JavaScript${where}, so the output could not be compared with it.` });
  }
  const tree = reparse(formatted, parsed.sourceType);
  if (!tree || !sameTree(parsed.ast, tree)) {
    throw new JsError("js.beautify.changes-meaning", "Beautify would change what this program does (for example a line break after return); Minify keeps it, or add the semicolon", null);
  }
  return emit(context, formatted, { ...counts(parsed), diagnostics: 0, verified: true });
}
