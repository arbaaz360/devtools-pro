import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";

/**
 * HTML beautifier and minifier for `format.html` (DU-13).
 *
 * Web platform APIs only: this module runs in the desktop webview's Worker
 * engine as well as under Node, so there are no `node:` imports. Bytes come in
 * through `context.readChunks`, are decoded with `TextDecoder`, and the result
 * is encoded with `TextEncoder`.
 *
 * Execution is: read -> tokenize (one forward pass, bounded lookahead) ->
 * build a tolerant element tree -> render. Formatting never fails: every
 * recovery is recorded as a `warning` diagnostic and the output is still
 * produced. Only an empty document, a limit breach, invalid UTF-8 or an
 * invalid option is an error.
 */

/** Operations this processor serves. */
export const OPERATIONS = Object.freeze(["beautify", "minify"]);
/** Chunk size requested from the SDK reader. */
export const READ_CHUNK_BYTES = 64 * 1024;
/** Tokens (and nodes) processed between cooperative cancellation checks. */
export const CANCELLATION_STRIDE_TOKENS = 4096;

/** Elements that never have content and never get an end tag. */
export const VOID_ELEMENTS = Object.freeze(new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
]));
/** Elements whose content is copied byte for byte. */
export const RAW_TEXT_ELEMENTS = Object.freeze(new Set(["script", "style", "pre", "textarea"]));
/** Elements that stay inline with the text around them. */
export const INLINE_ELEMENTS = Object.freeze(new Set([
  "a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "dfn", "em", "i", "kbd", "mark", "q", "s",
  "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr", "img", "input", "label",
  "select", "textarea", "button",
]));
/** Named block elements. Every element that is not inline is a block element, named or not. */
export const BLOCK_ELEMENTS = Object.freeze(new Set([
  "html", "head", "body", "div", "p", "section", "article", "header", "footer", "nav", "main", "aside",
  "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "form", "fieldset",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "figure", "figcaption", "details", "summary",
  "dl", "dt", "dd", "hr", "br",
]));
/** Elements whose end tag may be omitted; omitting one is valid HTML, not a recovery. */
export const OPTIONAL_END_TAG = Object.freeze(new Set([
  "li", "p", "dt", "dd", "tr", "td", "th", "option", "thead", "tbody", "tfoot", "html", "head", "body",
]));
/**
 * Starting one of these closes an open `<p>`, exactly as the HTML parser does.
 * It is the named block elements without `<br>` — a line break belongs inside a
 * paragraph — plus the blocks HTML lists that have no layout rule of their own.
 * An element the formatter does not know does not close a paragraph either: it
 * may well be phrasing content.
 */
export const CLOSES_PARAGRAPH = Object.freeze(new Set([
  ...[...BLOCK_ELEMENTS].filter((name) => name !== "br"),
  "address", "center", "dialog", "dir", "hgroup", "listing", "menu", "plaintext", "pre", "xmp",
]));

/** An element is inline when it is in the inline list; everything else, known or not, is a block. */
export const isInlineElement = (name) => INLINE_ELEMENTS.has(name);
export const isBlockElement = (name) => !INLINE_ELEMENTS.has(name);

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/** Thrown for every structured failure; `diagnostic` carries a position when one exists. */
export class HtmlError extends Error {
  constructor(code, message, data, position) {
    const where = position?.offset === undefined ? "" : ` at line ${position.line}, column ${position.column} (byte ${position.offset})`;
    super(`${code}: ${message}${where}`);
    this.name = "HtmlError";
    this.code = code;
    this.diagnostic = { code, severity: "error", message, data: data ?? {}, ...(position ?? {}) };
  }
}

const invalidOption = (message, data) => new HtmlError("html.invalid-option", message, data);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const INDENT_KEYS = ["indent"];
const PRESERVE_COMMENTS_KEYS = ["preserve-comments", "preserveComments"];
const WRAP_ATTRIBUTES_KEYS = ["wrap-attributes", "wrapAttributes"];
const INDENT_INNER_HTML_KEYS = ["indent-inner-html", "indentInnerHtml"];
const KNOWN_OPTIONS = new Set([
  ...INDENT_KEYS, ...PRESERVE_COMMENTS_KEYS, ...WRAP_ATTRIBUTES_KEYS, ...INDENT_INNER_HTML_KEYS,
]);

/** Accepted spellings per canonical indent value. `spaces-2`/`spaces-4` are the manifest choice ids. */
const INDENT_VALUES = new Map([
  ["2", "2"], ["4", "4"], ["tab", "tab"], ["spaces-2", "2"], ["spaces-4", "4"],
]);
const INDENT_TEXT = { 2: "  ", 4: "    ", tab: "\t" };
const WRAP_ATTRIBUTE_VALUES = ["auto", "force"];

function booleanOption(raw, keys, fallback) {
  const supplied = keys.filter((key) => raw[key] !== undefined);
  if (supplied.length === 0) return fallback;
  for (const key of supplied) {
    if (typeof raw[key] !== "boolean") throw invalidOption(`${key} must be a boolean`, { option: key, received: raw[key] === null ? "null" : Array.isArray(raw[key]) ? "array" : typeof raw[key] });
  }
  if (supplied.length > 1 && raw[supplied[0]] !== raw[supplied[1]]) throw invalidOption(`${supplied[0]} and ${supplied[1]} disagree`, { options: supplied });
  return raw[supplied[0]];
}

/**
 * Normalizes the four declared options. Ids are kebab-case; every multi-word
 * id also accepts its camelCase alias, and supplying both with different
 * values is an error. Unknown keys and wrong types are structured errors.
 */
export function normalizeOptions(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalidOption("options must be an object", { received: Array.isArray(raw) ? "array" : typeof raw });
  for (const key of Object.keys(raw)) if (!KNOWN_OPTIONS.has(key)) throw invalidOption(`unknown option ${key}`, { option: key, known: [...KNOWN_OPTIONS] });

  let indent = "2";
  if (raw.indent !== undefined) {
    const value = typeof raw.indent === "number" && Number.isInteger(raw.indent) ? String(raw.indent) : raw.indent;
    if (typeof value !== "string" || !INDENT_VALUES.has(value)) {
      throw invalidOption("indent must be one of 2, 4, tab", { option: "indent", received: typeof raw.indent === "object" ? "object" : raw.indent, accepted: [...INDENT_VALUES.keys()] });
    }
    indent = INDENT_VALUES.get(value);
  }

  const wrapRaw = raw["wrap-attributes"] !== undefined ? raw["wrap-attributes"] : raw.wrapAttributes;
  if (raw["wrap-attributes"] !== undefined && raw.wrapAttributes !== undefined && raw["wrap-attributes"] !== raw.wrapAttributes) {
    throw invalidOption("wrap-attributes and wrapAttributes disagree", { options: ["wrap-attributes", "wrapAttributes"] });
  }
  let wrapAttributes = "auto";
  if (wrapRaw !== undefined) {
    if (typeof wrapRaw !== "string" || !WRAP_ATTRIBUTE_VALUES.includes(wrapRaw)) {
      throw invalidOption(`wrap-attributes must be one of ${WRAP_ATTRIBUTE_VALUES.join(", ")}`, { option: "wrap-attributes", received: typeof wrapRaw === "object" ? "object" : wrapRaw });
    }
    wrapAttributes = wrapRaw;
  }

  return {
    indent,
    indentText: INDENT_TEXT[indent],
    preserveComments: booleanOption(raw, PRESERVE_COMMENTS_KEYS, true),
    wrapAttributes,
    indentInnerHtml: booleanOption(raw, INDENT_INNER_HTML_KEYS, false),
  };
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

async function readText(context) {
  const chunks = [];
  let length = 0;
  const overLimit = () => new HtmlError("html.input-limit", `input exceeds the ${context.limits.maxInputBytes} byte input limit`, { bytes: length, limit: context.limits.maxInputBytes });
  try {
    for await (const chunk of context.readChunks("input", READ_CHUNK_BYTES)) {
      if (context.cancellation.isCancelled()) throw new ProcessorCancelled();
      length += chunk.byteLength;
      if (length > context.limits.maxInputBytes) throw overLimit();
      chunks.push(chunk);
    }
  } catch (error) {
    // The SDK reader rejects an oversized port before it yields; report it with a code.
    if (error instanceof Error && !(error instanceof HtmlError) && error.name !== "ProcessorCancelled" && /exceeds/u.test(error.message)) throw overLimit();
    throw error;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let text;
  try { text = decoder.decode(bytes); } catch { throw new HtmlError("html.invalid-utf8", "input is not valid UTF-8 text", { bytes: length }); }
  return { text, inputBytes: length };
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

const utf8Length = (codePoint) => (codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4);

/**
 * Fills byte `offset`/`end` plus `line`/`column` for every diagnostic in one
 * sweep over the source. Byte offsets are authoritative; line and column are
 * derived display hints that count code points and treat CRLF as one break.
 */
export function resolvePositions(text, diagnostics) {
  const requests = [];
  for (const diagnostic of diagnostics) {
    requests.push({ diagnostic, field: "offset", at: diagnostic.charOffset, start: true });
    requests.push({ diagnostic, field: "end", at: diagnostic.charEnd, start: false });
  }
  requests.sort((a, b) => a.at - b.at || (a.start ? -1 : 1));
  let line = 1;
  let column = 1;
  let byte = 0;
  let i = 0;
  let afterCarriageReturn = false;
  for (const request of requests) {
    while (i < request.at) {
      const code = text.codePointAt(i);
      const units = code > 0xffff ? 2 : 1;
      byte += utf8Length(code);
      if (code === 0x0a) {
        if (!afterCarriageReturn) { line += 1; column = 1; }
        afterCarriageReturn = false;
        i += 1;
        continue;
      }
      if (code === 0x0d) { line += 1; column = 1; afterCarriageReturn = true; i += 1; continue; }
      afterCarriageReturn = false;
      column += 1;
      i += units;
    }
    request.diagnostic[request.field] = byte;
    if (request.start) { request.diagnostic.line = line; request.diagnostic.column = column; }
  }
  for (const diagnostic of diagnostics) { delete diagnostic.charOffset; delete diagnostic.charEnd; }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

const isSpace = (ch) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
const isAlpha = (ch) => ch !== undefined && ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z"));

/**
 * One forward pass over the source. The scanner never returns to a character
 * it has left behind; the only lookahead is the fixed prefix of a markup
 * construct (`<!--`, `<!DOCTYPE`, `</name`), so the buffer it needs is bounded
 * by the longest element name, not by the document.
 *
 * Produces: `doctype`, `comment`, `bogus` (`<!...>` and `<?...>` that are not a
 * comment or doctype), `startTag`, `endTag`, `text` and `raw` (the byte-for-byte
 * content of a raw-text element). Character references are never touched; they
 * travel inside `text` values.
 */
export function tokenize(source, sink) {
  const tokens = [];
  const length = source.length;
  const counts = { elements: 0, attributes: 0, comments: 0 };
  let i = 0;
  let pending = 0;
  const text = (start, end) => { if (end > start) tokens.push({ kind: "text", start, end, value: source.slice(start, end) }); };

  while (i < length) {
    if ((pending++ & (CANCELLATION_STRIDE_TOKENS - 1)) === 0) sink.check();
    const lt = source.indexOf("<", i);
    if (lt < 0) { text(i, length); break; }
    if (lt > i) { text(i, lt); i = lt; }
    const next = source[i + 1];

    if (next === "!") {
      if (source.startsWith("<!--", i)) {
        const close = source.indexOf("-->", i + 4);
        const end = close < 0 ? length : close + 3;
        tokens.push({ kind: "comment", start: i, end, raw: source.slice(i, end) });
        counts.comments += 1;
        i = end;
        continue;
      }
      if (source.slice(i, i + 9).toLowerCase() === "<!doctype") {
        const close = source.indexOf(">", i);
        const end = close < 0 ? length : close + 1;
        tokens.push({ kind: "doctype", start: i, end, raw: source.slice(i, end) });
        i = end;
        continue;
      }
      const close = source.indexOf(">", i + 2);
      const end = close < 0 ? length : close + 1;
      tokens.push({ kind: "bogus", start: i, end, raw: source.slice(i, end) });
      i = end;
      continue;
    }

    if (next === "?") {
      const close = source.indexOf(">", i + 2);
      const end = close < 0 ? length : close + 1;
      tokens.push({ kind: "bogus", start: i, end, raw: source.slice(i, end) });
      i = end;
      continue;
    }

    if (next === "/") {
      if (!isAlpha(source[i + 2])) { text(i, i + 1); i += 1; continue; }
      let j = i + 2;
      const nameStart = j;
      while (j < length && !isSpace(source[j]) && source[j] !== ">" && source[j] !== "/") j += 1;
      const rawName = source.slice(nameStart, j);
      while (j < length && source[j] !== ">") j += 1;
      const end = j < length ? j + 1 : length;
      tokens.push({ kind: "endTag", start: i, end, name: rawName.toLowerCase(), rawName });
      i = end;
      continue;
    }

    if (!isAlpha(next)) { text(i, i + 1); i += 1; continue; }

    const tag = readStartTag(source, i, sink);
    tokens.push(tag);
    counts.elements += 1;
    counts.attributes += tag.attrs.length;
    i = tag.end;

    if (RAW_TEXT_ELEMENTS.has(tag.name)) {
      const rawEnd = findRawTextEnd(source, tag.end, tag.name);
      if (rawEnd > tag.end) tokens.push({ kind: "raw", start: tag.end, end: rawEnd, value: source.slice(tag.end, rawEnd) });
      i = rawEnd;
    }
  }
  return { tokens, counts };
}

/** Attributes: double-quoted, single-quoted, unquoted and valueless, each kept as written. */
function readStartTag(source, start, sink) {
  const length = source.length;
  let j = start + 1;
  const nameStart = j;
  while (j < length && !isSpace(source[j]) && source[j] !== ">" && source[j] !== "/") j += 1;
  const rawName = source.slice(nameStart, j);
  const name = rawName.toLowerCase();
  const attrs = [];
  let selfClosing = false;
  let end = length;

  for (;;) {
    while (j < length && isSpace(source[j])) j += 1;
    if (j >= length) { end = length; break; }
    if (source[j] === ">") { end = j + 1; break; }
    if (source[j] === "/" && source[j + 1] === ">") { selfClosing = true; end = j + 2; break; }
    if (source[j] === "/") { j += 1; continue; }

    const attrStart = j;
    while (j < length && !isSpace(source[j]) && source[j] !== "=" && source[j] !== ">" && source[j] !== "/") j += 1;
    if (j === attrStart) { j += 1; continue; }
    const attrName = source.slice(attrStart, j);

    let k = j;
    while (k < length && isSpace(source[k])) k += 1;
    if (source[k] !== "=") { attrs.push({ rawName: attrName, name: attrName.toLowerCase(), raw: attrName, hasValue: false, quote: "" }); continue; }
    k += 1;
    while (k < length && isSpace(source[k])) k += 1;
    const quote = source[k];
    if (quote === "\"" || quote === "'") {
      const close = source.indexOf(quote, k + 1);
      const valueEnd = close < 0 ? length : close + 1;
      const valueRaw = source.slice(k, valueEnd);
      attrs.push({ rawName: attrName, name: attrName.toLowerCase(), raw: `${attrName}=${valueRaw}`, hasValue: true, quote });
      j = valueEnd;
      continue;
    }
    const valueStart = k;
    while (k < length && !isSpace(source[k]) && source[k] !== ">") k += 1;
    const valueRaw = source.slice(valueStart, k);
    if (/["'`<=]/.test(valueRaw)) {
      sink.diagnostic({
        code: "html.unquoted-attribute",
        severity: "warning",
        message: `unquoted value for attribute "${attrName}" on <${name}> contains ${JSON.stringify(valueRaw.match(/["'`<=]/)[0])}; an unquoted value ends at the first whitespace or ">", so quotes and ">" cannot appear inside it`,
        data: { tag: name, attribute: attrName, value: valueRaw },
        charOffset: valueStart,
        charEnd: k,
      });
    }
    attrs.push({ rawName: attrName, name: attrName.toLowerCase(), raw: `${attrName}=${valueRaw}`, hasValue: true, quote: "" });
    j = k;
  }
  return { kind: "startTag", start, end, name, rawName, attrs, selfClosing };
}

/** Raw text ends at the first `</name` followed by whitespace, `/`, `>` or end of input. */
function findRawTextEnd(source, from, name) {
  let p = from;
  for (;;) {
    const idx = source.indexOf("</", p);
    if (idx < 0) return source.length;
    if (source.slice(idx + 2, idx + 2 + name.length).toLowerCase() === name) {
      const after = source[idx + 2 + name.length];
      if (after === undefined || isSpace(after) || after === ">" || after === "/") return idx;
    }
    p = idx + 2;
  }
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

const isConditionalComment = (raw) => raw.slice(0, 7).toLowerCase() === "<!--[if";

/** Drops comments when `preserve-comments` is off, then merges the text that becomes adjacent. */
export function filterTokens(tokens, options) {
  const kept = [];
  for (const token of tokens) {
    if (token.kind === "comment" && !options.preserveComments && !isConditionalComment(token.raw)) continue;
    const last = kept[kept.length - 1];
    if (token.kind === "text" && last?.kind === "text") {
      last.value += token.value;
      last.end = token.end;
      continue;
    }
    kept.push(token.kind === "text" ? { ...token } : token);
  }
  return kept;
}

const isBlockNode = (node) => node.type === "doctype" || (node.type === "element" && isBlockElement(node.name));

/**
 * Builds a tolerant element tree. Optional end tags close the way the HTML
 * parser closes them, and every other recovery is reported:
 * `html.mismatched-end-tag`, `html.stray-end-tag`, `html.void-end-tag`,
 * `html.unclosed-element` and `html.content-after-html`.
 */
export function buildTree(tokens, sink) {
  const root = { type: "root", children: [] };
  const stack = [root];
  let maxDepth = 0;
  let afterHtml = false;
  let reportedAfterHtml = false;
  let pending = 0;

  const top = () => stack[stack.length - 1];
  const append = (node) => { top().children.push(node); };
  const unclosed = (frame) => {
    if (OPTIONAL_END_TAG.has(frame.name)) return;
    sink.diagnostic({
      code: "html.unclosed-element",
      severity: "warning",
      message: `<${frame.name}> was never closed; it is closed here`,
      data: { tag: frame.name },
      charOffset: frame.start,
      charEnd: frame.startEnd,
    });
  };
  const popTo = (index) => {
    while (stack.length > index + 1) unclosed(stack.pop());
  };
  const noteAfterHtml = (token) => {
    if (!afterHtml || reportedAfterHtml) return;
    if (token.kind === "text" && /^[ \t\n\r\f]*$/u.test(token.value)) return;
    reportedAfterHtml = true;
    sink.diagnostic({
      code: "html.content-after-html",
      severity: "warning",
      message: "content after </html> is not part of the document the HTML parser builds",
      data: { tag: "html" },
      charOffset: token.start,
      charEnd: token.end,
    });
  };

  for (const token of tokens) {
    if ((pending++ & (CANCELLATION_STRIDE_TOKENS - 1)) === 0) sink.check();
    noteAfterHtml(token);

    if (token.kind === "text") { append({ type: "text", value: token.value }); continue; }
    if (token.kind === "raw") { append({ type: "raw", value: token.value }); continue; }
    if (token.kind === "doctype") { append({ type: "doctype", raw: token.raw }); continue; }
    if (token.kind === "comment" || token.kind === "bogus") { append({ type: token.kind, raw: token.raw }); continue; }

    if (token.kind === "endTag") {
      if (VOID_ELEMENTS.has(token.name)) {
        sink.diagnostic({
          code: "html.void-end-tag",
          severity: "warning",
          message: `<${token.name}> is a void element and never has an end tag; </${token.name}> is dropped`,
          data: { tag: token.name },
          charOffset: token.start,
          charEnd: token.end,
        });
        continue;
      }
      let index = -1;
      for (let k = stack.length - 1; k >= 1; k -= 1) if (stack[k].name === token.name) { index = k; break; }
      if (index < 0) {
        sink.diagnostic({
          code: "html.stray-end-tag",
          severity: "warning",
          message: `</${token.name}> has no open <${token.name}>; it is dropped`,
          data: { tag: token.name },
          charOffset: token.start,
          charEnd: token.end,
        });
        continue;
      }
      while (stack.length > index + 1) {
        const frame = stack.pop();
        if (OPTIONAL_END_TAG.has(frame.name)) continue;
        sink.diagnostic({
          code: "html.mismatched-end-tag",
          severity: "warning",
          message: `</${token.name}> closes <${frame.name}>, which was still open`,
          data: { tag: token.name, closed: frame.name },
          charOffset: token.start,
          charEnd: token.end,
        });
      }
      const frame = stack.pop();
      frame.hasEndTag = true;
      frame.endRawName = token.rawName;
      if (token.name === "html") afterHtml = true;
      continue;
    }

    // startTag
    implicitClose(stack, token.name, sink);
    const node = {
      type: "element",
      name: token.name,
      rawName: token.rawName,
      attrs: token.attrs,
      selfClosing: token.selfClosing,
      isVoid: VOID_ELEMENTS.has(token.name),
      isRawText: RAW_TEXT_ELEMENTS.has(token.name),
      hasEndTag: false,
      endRawName: token.rawName,
      children: [],
      start: token.start,
      startEnd: token.end,
    };
    top().children.push(node);
    const depth = stack.length;
    if (depth > maxDepth) maxDepth = depth;
    if (node.isVoid) continue;
    if (node.selfClosing && !node.isRawText) continue;
    stack.push(node);
  }
  popTo(0);
  return { root, depth: maxDepth };
}

/** Pops the frames the HTML parser closes when `name` starts. No end tag is invented. */
function implicitClose(stack, name, sink) {
  const closeThrough = (index) => {
    while (stack.length > index) {
      const frame = stack.pop();
      if (OPTIONAL_END_TAG.has(frame.name)) continue;
      sink.diagnostic({
        code: "html.unclosed-element",
        severity: "warning",
        message: `<${frame.name}> was never closed; it is closed by the following <${name}>`,
        data: { tag: frame.name, closedBy: name },
        charOffset: frame.start,
        charEnd: frame.startEnd,
      });
    }
  };
  /** `li`, `dt`/`dd`: scan down past inline elements and the transparent `div`/`p`/`address`. */
  const closeListItem = (targets) => {
    for (let k = stack.length - 1; k >= 1; k -= 1) {
      const frame = stack[k];
      if (targets.includes(frame.name)) { closeThrough(k); return; }
      if (isBlockElement(frame.name) && !["div", "p", "address"].includes(frame.name)) return;
    }
  };
  /** Table insertion: clear back to the nearest listed context, and only if one is open. */
  const clearBackTo = (boundaries) => {
    for (let k = stack.length - 1; k >= 1; k -= 1) {
      if (boundaries.includes(stack[k].name)) { closeThrough(k + 1); return; }
    }
  };

  switch (name) {
    case "li": closeListItem(["li"]); break;
    case "dt": case "dd": closeListItem(["dt", "dd"]); break;
    case "option": if (stack[stack.length - 1].name === "option") stack.pop(); break;
    case "optgroup":
      if (stack[stack.length - 1].name === "option") stack.pop();
      if (stack[stack.length - 1].name === "optgroup") stack.pop();
      break;
    case "tr": clearBackTo(["table", "thead", "tbody", "tfoot", "template"]); break;
    case "td": case "th": clearBackTo(["tr", "template"]); break;
    case "thead": case "tbody": case "tfoot": clearBackTo(["table", "template"]); break;
    case "body": case "frameset": {
      for (let k = stack.length - 1; k >= 1; k -= 1) if (stack[k].name === "head") { closeThrough(k); break; }
      break;
    }
    default: break;
  }
  // A `<p>` closes when a block element starts; a `p` can only have inline content open below it.
  if (!CLOSES_PARAGRAPH.has(name)) return;
  for (let k = stack.length - 1; k >= 1; k -= 1) {
    const frame = stack[k];
    if (frame.name === "p") { closeThrough(k); return; }
    if (!isInlineElement(frame.name)) return;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Collapses a text run. Whitespace is HTML whitespace only, so NBSP survives. */
function collapseText(value, trimLeft, trimRight) {
  let text = value.replace(/[ \t\n\r\f]+/gu, " ");
  if (trimLeft && text.startsWith(" ")) text = text.slice(1);
  if (trimRight && text.endsWith(" ")) text = text.slice(0, -1);
  return text;
}

/**
 * Trimming happens at block boundaries only: the edge of a block element's
 * content, the edge of the document, or the side that touches a block sibling.
 * Inside an inline element the edges are kept as a single space, which is why
 * `<b>bold </b>` does not lose its space. Both operations use this one rule,
 * which is what makes beautify -> minify -> beautify a fixed point.
 */
function textAt(nodes, index, container) {
  const containerIsBlock = container.type === "root" || (container.type === "element" && isBlockElement(container.name));
  const previous = nodes[index - 1];
  const next = nodes[index + 1];
  const trimLeft = previous ? isBlockNode(previous) : containerIsBlock;
  const trimRight = next ? isBlockNode(next) : containerIsBlock;
  return collapseText(nodes[index].value, trimLeft, trimRight);
}

function startTagText(node) {
  let text = `<${node.rawName}`;
  for (const attr of node.attrs) text += ` ${attr.raw}`;
  return text + (node.selfClosing ? "/>" : ">");
}

const endTagText = (node) => `</${node.endRawName}>`;

/**
 * Concatenates `nodes[from, to)` with no added whitespace. The whole sibling
 * list is passed so a text node still sees its real neighbours, which is what
 * the trimming rule needs when a run is only part of a container's children.
 *
 * This is the minify renderer, and it is also what produces a beautified
 * inline run, so a run is exactly its minified form. That shared definition is
 * what makes beautify -> minify -> beautify a fixed point.
 */
function emitRange(nodes, from, to, container, parts, sink) {
  for (let index = from; index < to; index += 1) {
    if ((sink.count++ & (CANCELLATION_STRIDE_TOKENS - 1)) === 0) sink.check();
    const node = nodes[index];
    switch (node.type) {
      case "text": parts.push(textAt(nodes, index, container)); break;
      case "raw": parts.push(node.value); break;
      case "doctype": case "comment": case "bogus": parts.push(node.raw); break;
      case "element":
        parts.push(startTagText(node));
        if (node.children.length > 0) emitRange(node.children, 0, node.children.length, node, parts, sink);
        if (node.hasEndTag) parts.push(endTagText(node));
        break;
      default: break;
    }
  }
}

function flattenRange(nodes, from, to, container, sink) {
  const parts = [];
  emitRange(nodes, from, to, container, parts, sink);
  return parts.join("");
}

/** `wrap-attributes: force` puts one attribute per line, indented one level. */
function openTagLine(node, indent, options) {
  if (options.wrapAttributes !== "force" || node.attrs.length <= 1) return indent + startTagText(node);
  const inner = indent + options.indentText;
  const lines = [`${indent}<${node.rawName}`];
  for (const attr of node.attrs) lines.push(inner + attr.raw);
  return lines.join("\n") + (node.selfClosing ? "/>" : ">");
}

function beautifyNodes(nodes, container, depth, lines, options, sink) {
  let index = 0;
  while (index < nodes.length) {
    if ((sink.count++ & (CANCELLATION_STRIDE_TOKENS - 1)) === 0) sink.check();
    if (isBlockNode(nodes[index])) { beautifyBlock(nodes[index], container, depth, lines, options, sink); index += 1; continue; }
    const start = index;
    while (index < nodes.length && !isBlockNode(nodes[index])) index += 1;
    const text = flattenRange(nodes, start, index, container, sink);
    if (text !== "") lines.push(options.indentText.repeat(depth) + text);
  }
}

function beautifyBlock(node, container, depth, lines, options, sink) {
  if (node.type === "doctype") { lines.push(options.indentText.repeat(depth) + node.raw); return; }

  // indent-inner-html: off, <head> and <body> sit at the level of <html>.
  let own = depth;
  if (!options.indentInnerHtml && (node.name === "head" || node.name === "body")
    && container.type === "element" && container.name === "html") own = Math.max(0, depth - 1);
  const indent = options.indentText.repeat(own);
  const open = openTagLine(node, indent, options);

  if (node.children.length === 0) {
    lines.push(open + (node.hasEndTag ? endTagText(node) : ""));
    return;
  }
  if (!node.children.some(isBlockNode)) {
    lines.push(open + flattenRange(node.children, 0, node.children.length, node, sink) + (node.hasEndTag ? endTagText(node) : ""));
    return;
  }
  lines.push(open);
  beautifyNodes(node.children, node, own + 1, lines, options, sink);
  if (node.hasEndTag) lines.push(indent + endTagText(node));
}

export function beautify(root, options, sink) {
  const lines = [];
  beautifyNodes(root.children, root, 0, lines, options, sink);
  return lines.join("\n");
}

export function minify(root, options, sink) {
  void options;
  return flattenRange(root.children, 0, root.children.length, root, sink);
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

/** One artifact per port: the SDK sink accepts a single chunk per artifact. */
const outputCap = (context) => Math.min(context.limits.maxOutputBytes, context.limits.maxChunkBytes);

/** Formats `text` and returns the output plus the report. Exported for tests. */
export function format(text, operation, rawOptions, check = () => {}) {
  const options = normalizeOptions(rawOptions);
  // "Empty" is HTML whitespace only, so a document that is nothing but a
  // no-break space still formats; `String.prototype.trim` would drop that too.
  if (/^[ \t\n\r\f]*$/u.test(text)) throw new HtmlError("html.empty", "the document is empty; there is nothing to format", { bytes: encoder.encode(text).byteLength });
  const diagnostics = [];
  const sink = { check, count: 0, diagnostic: (diagnostic) => diagnostics.push(diagnostic) };
  const { tokens, counts } = tokenize(text, sink);
  const { root, depth } = buildTree(filterTokens(tokens, options), sink);
  const output = operation === "minify" ? minify(root, options, sink) : beautify(root, options, sink);
  diagnostics.sort((a, b) => a.charOffset - b.charOffset || a.charEnd - b.charEnd);
  resolvePositions(text, diagnostics);
  return { output, diagnostics, counts, depth, options };
}

export async function execute(request, context) {
  const operation = request?.operationId ?? "beautify";
  if (!OPERATIONS.includes(operation)) {
    throw new HtmlError("html.unsupported-operation", `unsupported operation ${operation}`, { operationId: operation, supported: [...OPERATIONS] });
  }
  if (context.cancellation.isCancelled()) throw new ProcessorCancelled();
  const normalized = normalizeOptions(request?.options);
  const { text, inputBytes } = await readText(context);
  const check = () => { if (context.cancellation.isCancelled()) throw new ProcessorCancelled(); };
  const result = format(text, operation, request?.options, check);

  const bytes = encoder.encode(result.output);
  const cap = outputCap(context);
  if (bytes.byteLength > cap) {
    throw new HtmlError("html.output-limit", `${operation} output would be ${bytes.byteLength} bytes, above the ${cap} byte output limit`, { bytes: bytes.byteLength, limit: cap });
  }

  const report = {
    operation,
    elements: result.counts.elements,
    attributes: result.counts.attributes,
    comments: result.counts.comments,
    depth: result.depth,
    diagnostics: result.diagnostics.length,
    bytes: bytes.byteLength,
    inputBytes,
    options: {
      indent: normalized.indent,
      "preserve-comments": normalized.preserveComments,
      "wrap-attributes": normalized.wrapAttributes,
      "indent-inner-html": normalized.indentInnerHtml,
    },
    annotations: result.diagnostics,
  };
  await context.writeValue("output", report);
  await context.write("output", bytes);
  return report;
}
