import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";
import { marked } from "../../packages/vendor/marked/marked.mjs";

/**
 * Markdown and HTML preview for `preview.documents` (DU-25, DU-11).
 *
 * Web platform APIs only: this module runs in the desktop webview's Worker
 * engine as well as under Node, so there are no `node:` imports. Bytes come
 * in through `context.readChunks`, are decoded with `TextDecoder`, and the
 * result is encoded with `TextEncoder`.
 *
 * `preview.markdown` renders Markdown to HTML with the vendored `marked` and
 * always wraps the result in a complete document. `preview.html` wraps its
 * input the same way unless the input already looks like a full document
 * (starts with `<!DOCTYPE` or `<html`, after leading whitespace/comments),
 * in which case it is passed through byte for byte. Neither tool sanitises
 * its output: the shell renders it only inside a sandboxed frame with
 * scripts disabled.
 */

export const OPERATIONS = Object.freeze(["preview.markdown", "preview.html"]);
export const THEMES = Object.freeze(["light", "dark"]);
export const READ_CHUNK_BYTES = 64 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

export class PreviewError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "PreviewError";
    this.code = code;
    this.diagnostic = { code, severity: "error", message, data: data ?? {} };
  }
}

const invalidOption = (message, data) => new PreviewError("preview.invalid-option", message, data);

function check(context) {
  if (context.cancellation.isCancelled()) throw new ProcessorCancelled();
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const MARKDOWN_OPTIONS = new Set(["gfm", "breaks", "theme"]);

export function normalizeMarkdownOptions(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalidOption("options must be an object", { received: Array.isArray(raw) ? "array" : typeof raw });
  for (const key of Object.keys(raw)) if (!MARKDOWN_OPTIONS.has(key)) throw invalidOption(`unknown option ${key}`, { option: key, known: [...MARKDOWN_OPTIONS] });

  const gfm = raw.gfm === undefined ? true : raw.gfm;
  if (typeof gfm !== "boolean") throw invalidOption("gfm must be a boolean", { option: "gfm", received: typeof gfm });

  const breaks = raw.breaks === undefined ? false : raw.breaks;
  if (typeof breaks !== "boolean") throw invalidOption("breaks must be a boolean", { option: "breaks", received: typeof breaks });

  const theme = raw.theme === undefined ? "dark" : raw.theme;
  if (!THEMES.includes(theme)) throw invalidOption(`theme must be one of ${THEMES.join(", ")}`, { option: "theme", received: theme });

  return { gfm, breaks, theme };
}

export function normalizeHtmlOptions(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalidOption("options must be an object", { received: Array.isArray(raw) ? "array" : typeof raw });
  const keys = Object.keys(raw);
  if (keys.length > 0) throw invalidOption(`unknown option ${keys[0]}`, { option: keys[0], known: [] });
  return {};
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function readText(context) {
  const chunks = [];
  let length = 0;
  for await (const chunk of context.readChunks("input", READ_CHUNK_BYTES)) {
    check(context);
    length += chunk.byteLength;
    if (length > context.limits.maxInputBytes) throw new PreviewError("preview.input-limit", `input exceeds the ${context.limits.maxInputBytes} byte input limit`, { bytes: length, limit: context.limits.maxInputBytes });
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let text;
  try { text = decoder.decode(bytes); } catch { throw new PreviewError("preview.invalid-utf8", "input is not valid UTF-8 text", { bytes: length }); }
  return { text, inputBytes: length };
}

// ---------------------------------------------------------------------------
// Document detection and wrapping
// ---------------------------------------------------------------------------

/** Index in `text` after skipping leading whitespace and complete `<!-- -->` comments. */
export function skipLeadingWhitespaceAndComments(text) {
  let i = 0;
  for (;;) {
    let advanced = false;
    while (i < text.length && /\s/.test(text[i])) { i++; advanced = true; }
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end === -1) break;
      i = end + 3;
      advanced = true;
    }
    if (!advanced) break;
  }
  return i;
}

/** True when `text` already begins with `<!DOCTYPE` or `<html`, after leading whitespace/comments. */
export function looksLikeFullDocument(text) {
  const rest = text.slice(skipLeadingWhitespaceAndComments(text));
  return /^<!doctype(?=[\s>])/i.test(rest) || /^<html(?=[\s>/])/i.test(rest);
}

const PALETTES = Object.freeze({
  dark: { bg: "#1e1e1e", fg: "#e6e6e6", muted: "#9aa0a6", border: "#3c3c3c", codeBg: "#2a2a2a", link: "#8ab4f8" },
  light: { bg: "#ffffff", fg: "#1a1a1a", muted: "#5f6368", border: "#d0d0d0", codeBg: "#f2f2f2", link: "#1a73e8" },
});

function styleBlock(theme) {
  const p = PALETTES[theme];
  return `:root { color-scheme: ${theme}; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 15px;
  line-height: 1.6;
  background: ${p.bg};
  color: ${p.fg};
  padding: 24px;
}
code, pre, kbd, samp {
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
}
pre {
  background: ${p.codeBg};
  padding: 12px;
  border-radius: 4px;
  overflow: auto;
}
code {
  background: ${p.codeBg};
  padding: 0.15em 0.3em;
  border-radius: 3px;
}
pre code {
  background: none;
  padding: 0;
}
table {
  border-collapse: collapse;
  width: 100%;
}
th, td {
  border: 1px solid ${p.border};
  padding: 6px 10px;
  text-align: left;
}
img { max-width: 100%; height: auto; }
a { color: ${p.link}; }
blockquote {
  margin: 0;
  padding: 0 1em;
  border-left: 4px solid ${p.border};
  color: ${p.muted};
}
hr {
  border: none;
  border-top: 1px solid ${p.border};
}`;
}

/** Wraps `bodyHtml` in a complete, self-contained document: no external resources, no `<script>`, no `<base>`. */
export function wrapDocument(bodyHtml, theme) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="${theme}">
<style>
${styleBlock(theme)}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

const count = (html, pattern) => { const m = html.match(pattern); return m ? m.length : 0; };

export function computeProperties(html, wrapped) {
  const bytes = encoder.encode(html);
  return {
    bytes: bytes.byteLength,
    headings: count(html, /<h[1-6][\s>]/gi),
    links: count(html, /<a[\s>]/gi),
    images: count(html, /<img[\s>]/gi),
    codeBlocks: count(html, /<pre[\s>]/gi),
    scripts: count(html, /<script/gi),
    wrapped,
  };
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

function outputCap(context) {
  return Math.min(context.limits.maxOutputBytes, context.limits.maxChunkBytes);
}

async function finish(context, html, properties) {
  const bytes = encoder.encode(html);
  const cap = outputCap(context);
  if (bytes.byteLength > cap) {
    throw new PreviewError("preview.output-limit", `output would be ${bytes.byteLength} bytes, above the ${cap} byte output limit`, { bytes: bytes.byteLength, limit: cap });
  }
  await context.writeValue("output", properties);
  await context.write("output", bytes);
  return properties;
}

async function executeMarkdown(request, context) {
  const options = normalizeMarkdownOptions(request?.options);
  const { text } = await readText(context);
  check(context);
  const body = marked.parse(text, { gfm: options.gfm, breaks: options.breaks, async: false });
  check(context);
  const html = wrapDocument(body, options.theme);
  return finish(context, html, computeProperties(html, true));
}

async function executeHtml(request, context) {
  normalizeHtmlOptions(request?.options);
  const { text } = await readText(context);
  check(context);
  if (text.length === 0) throw new PreviewError("preview.empty", "the document is empty; there is nothing to preview", { bytes: 0 });
  const passthrough = looksLikeFullDocument(text);
  const html = passthrough ? text : wrapDocument(text, "dark");
  check(context);
  return finish(context, html, computeProperties(html, !passthrough));
}

export async function execute(request, context) {
  const operation = request?.operationId ?? "preview.markdown";
  if (!OPERATIONS.includes(operation)) {
    throw new PreviewError("preview.unsupported-operation", `unsupported operation ${operation}`, { operationId: operation, supported: [...OPERATIONS] });
  }
  check(context);
  if (operation === "preview.markdown") return executeMarkdown(request, context);
  return executeHtml(request, context);
}
