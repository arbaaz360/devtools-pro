import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";
import { js_beautify } from "../../packages/vendor/js-beautify/js-beautify.mjs";

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

async function beautify(context, options) {
  let length = 0;
  const chunks = [];
  for await (const chunk of context.readChunks("input", 65536)) {
    if (context.cancellation.isCancelled()) throw new ProcessorCancelled();
    length += chunk.byteLength;
    if (length > context.limits.maxInputBytes) throw new JsError("js.input-limit", "input exceeds max bytes");
    chunks.push(chunk);
  }
  
  if (length === 0) {
    const bytes = new Uint8Array(0);
    const result = { lines: 0, comments: 0, strings: 0, templates: 0, regexes: 0, diagnostics: 0, bytes: 0 };
    await context.writeValue("output", result);
    await context.write("output", bytes);
    return result;
  }
  
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  
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
  
  let formatted = "";
  try {
    formatted = js_beautify(text, beautifyOptions);
  } catch (err) {
    throw new JsError("format.js-beautify", err.message, null);
  }
  
  const encoder = new TextEncoder();
  const outBytes = encoder.encode(formatted);
  if (outBytes.byteLength > context.limits.maxOutputBytes) throw new JsError("js.output-limit", "output exceeds limit");
  
  const props = processTokens(formatted, "none");
  
  const result = {
    lines: props.lines,
    comments: props.comments,
    strings: props.strings,
    templates: props.templates,
    regexes: props.regexes,
    diagnostics: props.diagnosticsCount,
    bytes: outBytes.byteLength
  };
  
  await context.writeValue("output", result);
  await context.write("output", outBytes);
  return result;
}

async function minify(context, options) {
  let length = 0;
  const chunks = [];
  for await (const chunk of context.readChunks("input", 65536)) {
    if (context.cancellation.isCancelled()) throw new ProcessorCancelled();
    length += chunk.byteLength;
    if (length > context.limits.maxInputBytes) throw new JsError("js.input-limit", "input exceeds max bytes");
    chunks.push(chunk);
  }
  
  if (length === 0) {
    const bytes = new Uint8Array(0);
    const result = { lines: 0, comments: 0, strings: 0, templates: 0, regexes: 0, diagnostics: 0, bytes: 0 };
    await context.writeValue("output", result);
    await context.write("output", bytes);
    return result;
  }
  
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  
  const minified = processTokens(text, options.preserveComments);
  const encoder = new TextEncoder();
  const outBytes = encoder.encode(minified.out);
  if (outBytes.byteLength > context.limits.maxOutputBytes) throw new JsError("js.output-limit", "output exceeds max bytes");
  
  const result = {
    lines: minified.lines,
    comments: minified.comments,
    strings: minified.strings,
    templates: minified.templates,
    regexes: minified.regexes,
    diagnostics: minified.diagnosticsCount,
    bytes: outBytes.byteLength
  };
  
  await context.writeValue("output", result);
  await context.write("output", outBytes);
  return result;
}

function processTokens(text, preserveComments) {
  let out = "";
  let lines = 0;
  let commentsCount = 0;
  let stringsCount = 0;
  let templatesCount = 0;
  let regexesCount = 0;
  let diagnosticsCount = 0;
  let annotations = [];
  
  let i = 0;
  let len = text.length;
  
  let lastType = null;
  let lastValue = null;
  let lastCharEmitted = null;
  let endsWithNewline = false;
  
  const regexKeywords = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else"]);
  const regexPunct = new Set(["(", ",", "[", "{", ";", ":", "!", "?", "="]);
  
  function canRegexFollow(lastType, lastValue) {
    if (!lastType) return true;
    if (lastType === "keyword" && regexKeywords.has(lastValue)) return true;
    if ((lastType === "op" || lastType === "punct") && regexPunct.has(lastValue)) return true;
    if (lastType === "op") return true;
    return false;
  }
  
  function isIdentifierChar(c) { return c && /[a-zA-Z0-9_$]/.test(c); }
  function isOpChar(c) { return c && "+-*/%&|^~<>=!?:".includes(c); }
  
  let stack = [];
  let braceDepth = 0;
  let braceStack = [];
  
  function emit(str, type) {
    if (!str) return;
    for (let j = 0; j < str.length; j++) if (str[j] === "\n") lines++;
    
    if (type !== "comment") {
      if (out.length > 0 && endsWithNewline) {
         let needSemicolon = false;
         let endTokens = ["return", "break", "continue", "throw", "++", "--", ")", "]", "}"];
         if (lastType === "id" || lastType === "num" || lastType === "string" || lastType === "template") needSemicolon = true;
         else if ((lastType === "keyword" || lastType === "punct" || lastType === "op") && endTokens.includes(lastValue)) needSemicolon = true;
         
         if (needSemicolon) {
            let nextStarts = ["(", "[", "`", "+", "-", "/"];
            let startsWith = false;
            if (isIdentifierChar(str[0])) startsWith = true;
            else if (nextStarts.includes(str[0])) startsWith = true;
            
            if (startsWith) {
               out += "\n";
               lines++;
            } else {
               if (needsSpace(lastCharEmitted, str[0])) out += " ";
            }
         } else {
            if (needsSpace(lastCharEmitted, str[0])) out += " ";
         }
      } else if (out.length > 0) {
         if (needsSpace(lastCharEmitted, str[0])) out += " ";
      }
      
      out += str;
      lastCharEmitted = str[str.length - 1];
      if (type !== "punct" && type !== "op") {
         lastType = type;
         lastValue = str;
      } else {
         lastType = type;
         lastValue = str;
      }
      endsWithNewline = false;
    }
  }
  
  function needsSpace(L, R) {
     if (!L || !R) return false;
     if (isIdentifierChar(L) && isIdentifierChar(R)) return true;
     if (L === '+' && R === '+') return true;
     if (L === '-' && R === '-') return true;
     if (L === '/' && R === '*') return true;
     if (L === '/' && R === '/') return true;
     return false;
  }
  
  while (i < len) {
    let char = text[i];
    
    if (stack[stack.length - 1] === "TEMPLATE") {
       let start = i;
       let closed = false;
       while (i < len) {
          if (text[i] === "\\") { i += 2; continue; }
          if (text[i] === "$" && text[i+1] === "{") {
             out += text.substring(start, i + 2);
             for (let j = start; j < i + 2; j++) if (text[j] === "\n") lines++;
             stack.pop();
             braceStack.push(braceDepth);
             i += 2;
             lastCharEmitted = "{";
             lastType = "punct";
             lastValue = "{";
             endsWithNewline = false;
             closed = true;
             break;
          }
          if (text[i] === "`") {
             i++;
             out += text.substring(start, i);
             for (let j = start; j < i; j++) if (text[j] === "\n") lines++;
             stack.pop();
             lastCharEmitted = "`";
             lastType = "template";
             lastValue = "`";
             endsWithNewline = false;
             templatesCount++;
             closed = true;
             break;
          }
          i++;
       }
       if (!closed) {
          out += text.substring(start, i);
          for (let j = start; j < i; j++) if (text[j] === "\n") lines++;
          stack.pop();
          diagnosticsCount++;
          annotations.push({ code: "js.unterminated-template", severity: "warning", message: "unterminated template", offset: start });
       }
       continue;
    }
    
    if (/\s/.test(char)) {
      if (char === "\n") endsWithNewline = true;
      i++;
      continue;
    }
    
    if (char === "\/" && text[i+1] === "\/") {
      let start = i;
      while(i < len && text[i] !== "\n" && text[i] !== "\r") i++;
      let commentText = text.substring(start, i);
      if (preserveComments === "license" && (commentText.includes("/*!") || commentText.includes("@license") || commentText.includes("@preserve"))) {
         if (out.length > 0 && lastCharEmitted !== "\n") out += " ";
         out += commentText;
         lastCharEmitted = commentText[commentText.length - 1];
         commentsCount++;
      }
      continue;
    }
    
    if (char === "\/" && text[i+1] === "*") {
      let start = i;
      i += 2;
      let closed = false;
      while(i < len - 1) {
         if (text[i] === "*" && text[i+1] === "\/") {
            closed = true;
            i += 2;
            break;
         }
         if (text[i] === "\n") endsWithNewline = true;
         i++;
      }
      if (!closed) {
         diagnosticsCount++;
         annotations.push({ code: "js.unterminated-comment", severity: "warning", message: "unterminated block comment", offset: start });
         i = len;
      }
      let commentText = text.substring(start, i);
      if (preserveComments === "license" && (commentText.includes("/*!") || commentText.includes("@license") || commentText.includes("@preserve"))) {
         if (out.length > 0 && lastCharEmitted !== "\n" && out[out.length-1] !== " ") out += " ";
         out += commentText;
         lastCharEmitted = commentText[commentText.length - 1];
         commentsCount++;
      }
      continue;
    }
    
    if (char === "\/" && canRegexFollow(lastType, lastValue)) {
      let start = i;
      i++;
      let inClass = false;
      let closed = false;
      while(i < len) {
        if (text[i] === "\\") { i += 2; continue; }
        if (text[i] === "[") inClass = true;
        if (text[i] === "]") inClass = false;
        if (text[i] === "\/" && !inClass) { i++; closed = true; break; }
        if (text[i] === "\n" || text[i] === "\r") break;
        i++;
      }
      if (!closed) {
         diagnosticsCount++;
         annotations.push({ code: "js.unterminated-regex", severity: "warning", message: "unterminated regex", offset: start });
      } else {
         while (i < len && /[a-zA-Z]/.test(text[i])) i++;
      }
      emit(text.substring(start, i), "regex");
      regexesCount++;
      continue;
    }
    
    if (char === "\"" || char === "'") {
      let quote = char;
      let start = i;
      i++;
      let closed = false;
      while(i < len) {
        if (text[i] === "\\") { i += 2; continue; }
        if (text[i] === quote) { i++; closed = true; break; }
        if (text[i] === "\n" || text[i] === "\r") break;
        i++;
      }
      if (!closed) {
         diagnosticsCount++;
         annotations.push({ code: "js.unterminated-string", severity: "warning", message: "unterminated string", offset: start });
      }
      emit(text.substring(start, i), "string");
      stringsCount++;
      continue;
    }
    
    if (char === "`") {
      let start = i;
      i++;
      out += (out.length > 0 && needsSpace(lastCharEmitted, "`") ? " `" : "`");
      lastCharEmitted = "`";
      lastType = "template";
      stack.push("TEMPLATE");
      continue;
    }
    
    if (char === "{") {
       braceDepth++;
       emit("{", "punct");
       i++;
       continue;
    }
    if (char === "}") {
       braceDepth--;
       emit("}", "punct");
       if (braceStack.length > 0 && braceDepth === braceStack[braceStack.length - 1]) {
          braceStack.pop();
          stack.push("TEMPLATE");
       }
       i++;
       continue;
    }
    
    if (/[a-zA-Z_$]/.test(char)) {
      let start = i;
      while(i < len && /[a-zA-Z0-9_$]/.test(text[i])) i++;
      let val = text.substring(start, i);
      let type = regexKeywords.has(val) ? "keyword" : "id";
      emit(val, type);
      continue;
    }
    
    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(text[i+1]))) {
      let start = i;
      while(i < len && /[0-9.a-zA-Z_]/.test(text[i])) i++;
      emit(text.substring(start, i), "num");
      continue;
    }
    
    let opChars = "+-*/%&|^~<>=!?:";
    if (opChars.includes(char)) {
      let start = i;
      while(i < len && opChars.includes(text[i])) i++;
      let val = text.substring(start, i);
      emit(val, "op");
      continue;
    }
    
    emit(char, "punct");
    i++;
  }
  
  if (out.length > 0 && out[out.length - 1] === "\n") {
    lines--;
  }
  
  return { out, lines, comments: commentsCount, strings: stringsCount, templates: templatesCount, regexes: regexesCount, diagnosticsCount, annotations };
}
