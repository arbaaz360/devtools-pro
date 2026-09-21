import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";

export const OPERATION_ID = "convert.jsx";
export const CANCELLATION_STRIDE_TOKENS = 4096;
export const READ_CHUNK_BYTES = 64 * 1024;

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);
const BOOLEAN_ATTRIBUTES = new Set(["disabled", "checked", "selected", "hidden", "required", "readonly", "multiple", "autofocus", "autoplay", "controls", "loop", "muted", "open", "defer", "async", "novalidate"]);

const RENAME_MAP = new Map([
  ["class", "className"], ["for", "htmlFor"], ["tabindex", "tabIndex"], ["readonly", "readOnly"],
  ["maxlength", "maxLength"], ["colspan", "colSpan"], ["rowspan", "rowSpan"], ["autocomplete", "autoComplete"],
  ["autofocus", "autoFocus"], ["enctype", "encType"], ["accept-charset", "acceptCharset"], ["http-equiv", "httpEquiv"],
  ["crossorigin", "crossOrigin"], ["srcset", "srcSet"], ["contenteditable", "contentEditable"], ["spellcheck", "spellCheck"],
  ["novalidate", "noValidate"], ["formnovalidate", "formNoValidate"], ["frameborder", "frameBorder"], ["allowfullscreen", "allowFullScreen"],
  ["datetime", "dateTime"], ["accesskey", "accessKey"], ["hreflang", "hrefLang"], ["inputmode", "inputMode"],
  ["minlength", "minLength"], ["playsinline", "playsInline"], ["referrerpolicy", "referrerPolicy"], ["usemap", "useMap"]
]);

const SVG_ELEMENTS = new Set([
  "svg", "animate", "animateMotion", "animateTransform", "circle", "clipPath", "defs", "desc", "ellipse", "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting", "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR", "feGaussianBlur", "feImage", "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight", "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence", "filter", "foreignObject", "g", "image", "line", "linearGradient", "marker", "mask", "metadata", "mpath", "path", "pattern", "polygon", "polyline", "radialGradient", "rect", "set", "stop", "switch", "symbol", "text", "textPath", "tspan", "use", "view",
]);

export class JsxError extends Error {
  constructor(code, message, data, position) {
    const where = position?.offset === undefined ? "" : ` at line ${position.line}, column ${position.column} (byte ${position.offset})`;
    super(`${code}: ${message}${where}`);
    this.name = "JsxError";
    this.code = code;
    this.diagnostic = { code, severity: "error", message, data: data ?? {}, ...(position ?? {}) };
  }
}

const invalidOption = (message, data) => new JsxError("jsx.invalid-option", message, data);

const WRAP_VALUES = ["none", "fragment", "component"];
const INDENT_VALUES = new Map([["2", "2"], ["4", "4"], ["tab", "tab"], ["spaces-2", "2"], ["spaces-4", "4"]]);
const INDENT_TEXT = { 2: "  ", 4: "    ", tab: "\t" };
const SVG_ATTRIBUTES_VALUES = ["camel", "keep"];

export function normalizeOptions(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalidOption("options must be an object", { received: Array.isArray(raw) ? "array" : typeof raw });

  for (const key of Object.keys(raw)) {
    if (!["wrap", "component-name", "componentName", "indent", "svg-attributes", "svgAttributes"].includes(key)) {
      throw invalidOption(`unknown option ${key}`, { option: key, known: ["wrap", "component-name", "indent", "svg-attributes"] });
    }
  }

  const wrap = raw.wrap === undefined ? "fragment" : raw.wrap;
  if (!WRAP_VALUES.includes(wrap)) throw invalidOption(`wrap must be one of ${WRAP_VALUES.join(", ")}`, { option: "wrap", received: wrap });

  const componentName = raw["component-name"] !== undefined ? raw["component-name"] : (raw.componentName !== undefined ? raw.componentName : "Component");
  if (typeof componentName !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(componentName)) throw invalidOption("component-name must be a valid JS identifier", { option: "component-name", received: componentName });
  if (raw["component-name"] !== undefined && raw.componentName !== undefined && raw["component-name"] !== raw.componentName) throw invalidOption("component-name and componentName disagree", { options: ["component-name", "componentName"] });

  let indent = "2";
  if (raw.indent !== undefined) {
    const value = String(raw.indent);
    if (!INDENT_VALUES.has(value)) throw invalidOption("indent must be one of 2, 4, tab", { option: "indent", received: raw.indent });
    indent = INDENT_VALUES.get(value);
  }

  const svgAttributes = raw["svg-attributes"] !== undefined ? raw["svg-attributes"] : (raw.svgAttributes !== undefined ? raw.svgAttributes : "camel");
  if (!SVG_ATTRIBUTES_VALUES.includes(svgAttributes)) throw invalidOption(`svg-attributes must be one of ${SVG_ATTRIBUTES_VALUES.join(", ")}`, { option: "svg-attributes", received: svgAttributes });
  if (raw["svg-attributes"] !== undefined && raw.svgAttributes !== undefined && raw["svg-attributes"] !== raw.svgAttributes) throw invalidOption("svg-attributes and svgAttributes disagree", { options: ["svg-attributes", "svgAttributes"] });

  return { wrap, componentName, indent, indentText: INDENT_TEXT[indent], svgAttributes };
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

async function readText(context) {
  const chunks = [];
  let length = 0;
  const overLimit = () => new JsxError("jsx.input-limit", `input exceeds the ${context.limits.maxInputBytes} byte input limit`, { bytes: length, limit: context.limits.maxInputBytes });
  try {
    for await (const chunk of context.readChunks("input", READ_CHUNK_BYTES)) {
      if (context.cancellation.isCancelled()) throw new ProcessorCancelled();
      length += chunk.byteLength;
      if (length > context.limits.maxInputBytes) throw overLimit();
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof Error && !(error instanceof JsxError) && error.name !== "ProcessorCancelled" && /exceeds/u.test(error.message)) throw overLimit();
    throw error;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let text;
  try { text = decoder.decode(bytes); } catch { throw new JsxError("jsx.invalid-utf8", "input is not valid UTF-8 text", { bytes: length }); }
  return { text, inputBytes: length };
}

const utf8Length = (codePoint) => (codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4);

export function resolvePositions(text, diagnostics) {
  const requests = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.charOffset !== undefined) requests.push({ diagnostic, field: "offset", at: diagnostic.charOffset, start: true });
    if (diagnostic.charEnd !== undefined) requests.push({ diagnostic, field: "end", at: diagnostic.charEnd, start: false });
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

const isSpace = (ch) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
const isAlpha = (ch) => ch !== undefined && ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z"));

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
        tokens.push({ kind: "comment", start: i, end, raw: source.slice(i, end), value: source.slice(i + 4, close < 0 ? length : close) });
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
      if (rawEnd > tag.end) {
        tokens.push({ kind: "raw", start: tag.end, end: rawEnd, value: source.slice(tag.end, rawEnd), tagName: tag.name });
      }
      i = rawEnd;
    }
  }
  return { tokens, counts };
}

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
    if (source[k] !== "=") { attrs.push({ rawName: attrName, name: attrName.toLowerCase(), value: null, quote: "" }); continue; }
    k += 1;
    while (k < length && isSpace(source[k])) k += 1;
    const quote = source[k];
    if (quote === "\"" || quote === "'") {
      const close = source.indexOf(quote, k + 1);
      const valueEnd = close < 0 ? length : close + 1;
      const valueRaw = source.slice(k + 1, close < 0 ? length : close);
      attrs.push({ rawName: attrName, name: attrName.toLowerCase(), value: valueRaw, quote });
      j = valueEnd;
      continue;
    }
    const valueStart = k;
    while (k < length && !isSpace(source[k]) && source[k] !== ">" && source[k] !== "/") k += 1;
    const valueRaw = source.slice(valueStart, k);
    attrs.push({ rawName: attrName, name: attrName.toLowerCase(), value: valueRaw, quote: "" });
    j = k;
  }
  return { kind: "startTag", start, end, name, rawName, attrs, selfClosing };
}

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

export function buildTree(tokens, sink) {
  const root = { type: "root", children: [] };
  const stack = [root];
  let pending = 0;

  const top = () => stack[stack.length - 1];

  for (const token of tokens) {
    if ((pending++ & (CANCELLATION_STRIDE_TOKENS - 1)) === 0) sink.check();
    if (token.kind === "text") { top().children.push({ type: "text", value: token.value }); continue; }
    if (token.kind === "raw") { top().children.push({ type: "raw", value: token.value, tagName: token.tagName, start: token.start, startEnd: token.end }); continue; }
    if (token.kind === "comment") { top().children.push({ type: "comment", value: token.value }); continue; }
    if (token.kind === "doctype" || token.kind === "bogus") continue;

    if (token.kind === "endTag") {
      if (VOID_ELEMENTS.has(token.name)) {
        sink.diagnostic({
          code: "jsx.void-end-tag",
          severity: "warning",
          message: `</${token.name}> is a void element and never has an end tag; it is dropped`,
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
          code: "jsx.stray-end-tag",
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
        sink.diagnostic({
          code: "jsx.unclosed-element",
          severity: "warning",
          message: `<${frame.name}> was never closed; it is closed by </${token.name}>`,
          data: { tag: frame.name, closedBy: token.name },
          charOffset: frame.start,
          charEnd: frame.startEnd,
        });
      }
      const frame = stack.pop();
      frame.hasEndTag = true;
      frame.endRawName = token.rawName;
      continue;
    }

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
    if (node.isVoid) continue;
    if (node.selfClosing && !node.isRawText) continue;
    stack.push(node);
  }

  while (stack.length > 1) {
    const frame = stack.pop();
    sink.diagnostic({
      code: "jsx.unclosed-element",
      severity: "warning",
      message: `<${frame.name}> was never closed; it is closed at end of input`,
      data: { tag: frame.name },
      charOffset: frame.start,
      charEnd: frame.startEnd,
    });
  }
  return root;
}

function toCamelCase(str) {
  return str.split(/[:-]/).map((word, index) => {
    if (index === 0) return word.toLowerCase();
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join("");
}

function parseStyle(styleStr) {
  const obj = {};
  for (const decl of styleStr.split(";")) {
    const idx = decl.indexOf(":");
    if (idx < 0) continue;
    let prop = decl.slice(0, idx).trim();
    const val = decl.slice(idx + 1).trim();
    if (!prop || !val) continue;
    if (prop.startsWith("-ms-")) prop = prop.slice(1);
    let camelProp = toCamelCase(prop);
    if (prop.startsWith("-webkit-") || prop.startsWith("-moz-") || prop.startsWith("-o-")) {
      camelProp = camelProp.charAt(0).toUpperCase() + camelProp.slice(1);
    }
    obj[camelProp] = val;
  }
  return obj;
}

function renderStyle(obj) {
  const keys = Object.keys(obj);
  if (keys.length === 0) return null;
  const parts = keys.map(k => {
    const val = obj[k];
    return `${k}: ${JSON.stringify(val)}`;
  });
  return `{{ ${parts.join(", ")} }}`;
}

function renameAttribute(attr, inSvg, options) {
  if (attr.name.startsWith("data-") || attr.name.startsWith("aria-")) return attr.rawName;
  if (attr.name.startsWith("on") && attr.name.length > 2) {
    return "on" + attr.name[2].toUpperCase() + attr.name.slice(3).toLowerCase();
  }
  if (RENAME_MAP.has(attr.name)) return RENAME_MAP.get(attr.name);
  if (inSvg) {
    if (attr.rawName === "viewBox") return "viewBox";
    if (options.svgAttributes === "camel" && /[:-]/.test(attr.rawName)) {
      return toCamelCase(attr.rawName);
    }
  }
  return attr.rawName;
}

function renderElement(node, depth, options, metrics, sink, inSvgContext) {
  const lines = [];
  const indent = options.indentText.repeat(depth);
  const isSvg = inSvgContext || SVG_ELEMENTS.has(node.rawName);

  let startTag = `${indent}<${node.rawName}`;
  for (const attr of node.attrs) {
    if (attr.name === "style" && attr.value !== null) {
      metrics.stylesConverted += 1;
      const styleObj = parseStyle(attr.value);
      const styleStr = renderStyle(styleObj);
      if (styleStr) startTag += ` style=${styleStr}`;
      continue;
    }
    const newName = renameAttribute(attr, isSvg, options);
    if (newName !== attr.rawName) metrics.attributesRenamed += 1;

    if (BOOLEAN_ATTRIBUTES.has(attr.name) && (attr.value === null || attr.value === "")) {
      startTag += ` ${newName}`;
      continue;
    }

    let val = attr.value === null ? "true" : attr.value;
    let quote = attr.quote || "\"";
    const isDoubleQuotedOrWillBe = attr.quote === '"' || attr.quote === "";
    if (isDoubleQuotedOrWillBe && val.includes('"')) {
      startTag += ` ${newName}={"${val.replace(/"/g, '\\"')}"}`;
    } else {
      const q = attr.quote === "'" ? "'" : '"';
      startTag += ` ${newName}=${q}${val}${q}`;
    }
  }

  const isSelfClosing = node.isVoid || node.selfClosing || node.children.length === 0;
  if (isSelfClosing) {
    startTag += " />";
    lines.push(startTag);
    return lines;
  }
  
  startTag += ">";
  lines.push(startTag);

  for (const child of node.children) {
    if ((sink.count++ & (CANCELLATION_STRIDE_TOKENS - 1)) === 0) sink.check();
    if (child.type === "element") {
      lines.push(...renderElement(child, depth + 1, options, metrics, sink, isSvg));
    } else if (child.type === "text") {
      const text = child.value.replace(/[\{\}]/g, m => m === '{' ? '{"{"}' : '{"}"}');
      if (text.trim() || text.includes("\n")) {
        const textLines = text.split("\n");
        for (let i = 0; i < textLines.length; i++) {
          if (i === 0) lines.push(options.indentText.repeat(depth + 1) + textLines[i]);
          else lines.push(textLines[i]); 
        }
      }
    } else if (child.type === "comment") {
      let val = child.value.replace(/\*\//g, "* /");
      lines.push(options.indentText.repeat(depth + 1) + `{/*${val}*/}`);
    } else if (child.type === "raw") {
      sink.diagnostic({
        code: "jsx.raw-element-warning",
        severity: "warning",
        message: `<${child.tagName}> block found, emitting as template literal`,
        charOffset: child.start,
        charEnd: child.startEnd
      });
      const val = child.value.replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
      lines.push(options.indentText.repeat(depth + 1) + `{` + "`" + val + "`" + `}`);
    }
  }

  lines.push(options.indentText.repeat(depth) + `</${node.rawName}>`);
  return lines;
}

export function format(text, rawOptions, check = () => {}) {
  const options = normalizeOptions(rawOptions);
  if (!text.trim()) throw new JsxError("jsx.empty", "the document is empty; there is nothing to format", { bytes: encoder.encode(text).byteLength });
  
  const diagnostics = [];
  const sink = { check, count: 0, diagnostic: (d) => diagnostics.push(d) };
  
  const { tokens, counts } = tokenize(text, sink);
  const root = buildTree(tokens, sink);
  
  const metrics = {
    elements: counts.elements,
    attributesRenamed: 0,
    stylesConverted: 0,
    comments: counts.comments
  };
  
  let outputLines = [];
  
  if (options.wrap === "component") {
    outputLines.push(`export default function ${options.componentName}() {`);
    outputLines.push(options.indentText + "return (");
  }
  
  const innerDepth = options.wrap === "component" ? 3 : (options.wrap === "fragment" ? 1 : 0);
  
  if (options.wrap === "fragment" || options.wrap === "component") {
    const wrapDepth = options.wrap === "component" ? 2 : 0;
    outputLines.push(options.indentText.repeat(wrapDepth) + "<>");
  }

  for (const child of root.children) {
    if (child.type === "element") {
      outputLines.push(...renderElement(child, innerDepth, options, metrics, sink, false));
    } else if (child.type === "text") {
      const txt = child.value.replace(/\{/g, '{"{"}').replace(/\}/g, '{"}"}');
      if (txt.trim()) {
         const lines = txt.split("\n");
         for (let i = 0; i < lines.length; i++) {
           if (lines[i].trim()) {
             if (i === 0) outputLines.push(options.indentText.repeat(innerDepth) + lines[i].trimStart());
             else outputLines.push(lines[i]);
           }
         }
      }
    } else if (child.type === "comment") {
      let val = child.value.replace(/\*\//g, "* /");
      outputLines.push(options.indentText.repeat(innerDepth) + `{/*${val}*/}`);
    }
  }

  if (options.wrap === "fragment" || options.wrap === "component") {
    const wrapDepth = options.wrap === "component" ? 2 : 0;
    outputLines.push(options.indentText.repeat(wrapDepth) + "</>");
  }

  if (options.wrap === "component") {
    outputLines.push(options.indentText + ");");
    outputLines.push("}");
  }

  const output = outputLines.join("\n");
  diagnostics.sort((a, b) => a.charOffset - b.charOffset || a.charEnd - b.charEnd);
  resolvePositions(text, diagnostics);
  
  return { output, diagnostics, metrics, options };
}

export async function execute(request, context) {
  if (request?.operationId && request.operationId !== OPERATION_ID) {
    throw new JsxError("jsx.unsupported-operation", `unsupported operation ${request.operationId}`, { operationId: request.operationId, supported: [OPERATION_ID] });
  }
  if (context.cancellation.isCancelled()) throw new ProcessorCancelled();
  
  const { text, inputBytes } = await readText(context);
  const check = () => { if (context.cancellation.isCancelled()) throw new ProcessorCancelled(); };
  
  const result = format(text, request?.options, check);
  const bytes = encoder.encode(result.output);
  const cap = Math.min(context.limits.maxOutputBytes, context.limits.maxChunkBytes);
  if (bytes.byteLength > cap) throw new JsxError("jsx.output-limit", `output exceeds limit ${cap}`, { bytes: bytes.byteLength, limit: cap });

  const report = {
    elements: result.metrics.elements,
    attributesRenamed: result.metrics.attributesRenamed,
    stylesConverted: result.metrics.stylesConverted,
    comments: result.metrics.comments,
    diagnostics: result.diagnostics.length,
    bytes: bytes.byteLength,
    annotations: result.diagnostics
  };

  await context.writeValue("output", report);
  await context.write("output", bytes);
  return report;
}
