import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";

export class HexError extends Error {
  constructor(code, message, offset = null, options = {}) {
    super(message);
    this.name = "HexError";
    this.code = code;
    this.diagnostic = {
      code,
      severity: "error",
      message,
      offset,
      ...options
    };
  }
}

const MODES = ["encode", "decode"];
const CASES = ["lower", "upper"];
const SEPARATORS = ["none", "space", "colon"];

function choice(options, id, alias, allowed, fallback) {
  const value = options[id] ?? (alias ? options[alias] : undefined) ?? fallback;
  if (!allowed.includes(value))
    throw new HexError("hex.invalid-option", `${id} must be one of ${allowed.map((item) => JSON.stringify(item)).join(", ")} (received ${JSON.stringify(value)})`, null, { option: id });
  return value;
}

export function readOptions(options = {}) {
  for (const key of Object.keys(options)) {
    if (!["mode", "case", "separator", "bytes-per-line", "bytesPerLine"].includes(key)) {
      throw new HexError("hex.invalid-option", `unknown option ${key}`, null, { option: key });
    }
  }

  let bpl = options["bytes-per-line"] ?? options["bytesPerLine"] ?? 0;
  if (typeof bpl !== "number" || !Number.isInteger(bpl) || bpl < 0 || bpl > 256) {
    throw new HexError("hex.invalid-option", `bytes-per-line must be an integer between 0 and 256 (received ${JSON.stringify(bpl)})`, null, { option: "bytes-per-line" });
  }

  return {
    mode: choice(options, "mode", null, MODES, "encode"),
    case: choice(options, "case", null, CASES, "lower"),
    separator: choice(options, "separator", null, SEPARATORS, "none"),
    bytesPerLine: bpl,
  };
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

const asciiText = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
};

const hexPreview = (bytes) => {
  const parts = [];
  for (let i = 0; i < Math.min(bytes.length, 16); i++) {
    parts.push(bytes[i].toString(16).padStart(2, "0"));
  }
  return parts.join(" ") + (bytes.length > 16 ? " ..." : "");
};


function hexEncode(bytes, options, context) {
  const sep = options.separator === "space" ? " " : options.separator === "colon" ? ":" : "";
  const hexAlphabet = options.case === "upper" ? "0123456789ABCDEF" : "0123456789abcdef";
  const bpl = options.bytesPerLine;
  
  if (bytes.length === 0) return new Uint8Array(0);
  
  let outLen = bytes.length * 2;
  if (bytes.length > 1) {
    if (bpl > 0) {
      const normalLines = Math.floor((bytes.length - 1) / bpl);
      outLen += normalLines; // '\n'
      outLen += sep.length * (bytes.length - 1 - normalLines);
    } else {
      outLen += sep.length * (bytes.length - 1);
    }
  }
  
  if (outLen > context.limits.maxOutputBytes) {
    throw new HexError("hex.output-limit", `Encoding would produce ${outLen.toLocaleString("en-US")} bytes, above the ${context.limits.maxOutputBytes.toLocaleString("en-US")} byte output limit; split the input or raise the limit`, null, { needed: outLen, limit: context.limits.maxOutputBytes });
  }
  
  const output = new Uint8Array(outLen);
  let pos = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (i % 4096 === 0 && context.cancellation.isCancelled()) throw new ProcessorCancelled();
    const b = bytes[i];
    output[pos++] = hexAlphabet.charCodeAt(b >> 4);
    output[pos++] = hexAlphabet.charCodeAt(b & 15);
    
    if (i < bytes.length - 1) {
      if (bpl > 0 && (i + 1) % bpl === 0) {
        output[pos++] = 10; // '\n'
      } else {
        for (let j = 0; j < sep.length; j++) {
          output[pos++] = sep.charCodeAt(j);
        }
      }
    }
  }
  return output;
}

function hexDecode(input, context) {
  const isHexDigit = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
  const isWhitespace = (c) => c === 32 || c === 9 || c === 10 || c === 13;
  const isSeparator = (c) => isWhitespace(c) || c === 58 || c === 45 || c === 44; // : - ,
  
  const getHexValue = (c) => {
    if (c >= 48 && c <= 57) return c - 48;
    if (c >= 65 && c <= 70) return c - 55;
    if (c >= 97 && c <= 102) return c - 87;
    return 0;
  };

  const temp = new Uint8Array(input.length);
  let outPos = 0;
  
  let i = 0;
  let runStartOffset = -1;
  let currentRunHexCount = 0;
  let currentByte = 0;
  let inRun = false;
  
  while (i < input.length) {
    if (i % 4096 === 0 && context.cancellation.isCancelled()) throw new ProcessorCancelled();
    const c = input[i];
    
    // Check for 0x or \x
    if (c === 48 && i + 1 < input.length && (input[i+1] === 120 || input[i+1] === 88)) { // 0x or 0X
      if (inRun && currentRunHexCount % 2 !== 0) {
        throw new HexError("hex.odd-length", "odd number of digits in run", runStartOffset);
      }
      inRun = false;
      currentRunHexCount = 0;
      i += 2;
      continue;
    }
    
    if (c === 92 && i + 1 < input.length && input[i+1] === 120) { // \x
      if (inRun && currentRunHexCount % 2 !== 0) {
        throw new HexError("hex.odd-length", "odd number of digits in run", runStartOffset);
      }
      inRun = false;
      currentRunHexCount = 0;
      i += 2;
      continue;
    }
    
    if (isSeparator(c)) {
      if (inRun && currentRunHexCount % 2 !== 0) {
        throw new HexError("hex.odd-length", "odd number of digits in run", runStartOffset);
      }
      inRun = false;
      currentRunHexCount = 0;
      i++;
      continue;
    }
    
    if (isHexDigit(c)) {
      if (!inRun) {
        inRun = true;
        runStartOffset = i;
        currentRunHexCount = 0;
      }
      
      const val = getHexValue(c);
      if (currentRunHexCount % 2 === 0) {
        currentByte = val << 4;
      } else {
        currentByte |= val;
        temp[outPos++] = currentByte;
      }
      currentRunHexCount++;
      i++;
      continue;
    }
    
    throw new HexError("hex.invalid-character", "invalid character", i);
  }
  
  if (inRun && currentRunHexCount % 2 !== 0) {
    throw new HexError("hex.odd-length", "odd number of digits in run", runStartOffset);
  }
  
  if (outPos > context.limits.maxOutputBytes) {
    throw new HexError("hex.output-limit", `Decoding would produce ${outPos.toLocaleString("en-US")} bytes, above the ${context.limits.maxOutputBytes.toLocaleString("en-US")} byte output limit; split the input or raise the limit`, null, { needed: outPos, limit: context.limits.maxOutputBytes });
  }
  
  return temp.slice(0, outPos);
}

export async function execute(request, context) {
  if (context.cancellation.isCancelled()) throw new ProcessorCancelled();
  
  const options = readOptions(request?.options);
  let inputBytes;
  try {
    inputBytes = await context.read('input');
  } catch (e) {
    if (e instanceof Error && e.message.includes("named input")) inputBytes = undefined;
    else throw e;
  }
  
  if (!inputBytes) inputBytes = new Uint8Array(0);

  if (options.mode === "encode") {
    const output = hexEncode(inputBytes, options, context);
    
    const result = {
      bytes: inputBytes.byteLength,
      characters: output.byteLength,
      case: options.case,
      separator: options.separator,
      contentKind: "text",
      mime: "text/plain; charset=us-ascii",
      utf8: true,
      text: asciiText(output),
      complete: true
    };
    
    await context.writeValue("output", result);
    await context.write("output", output);
    return result;
  } else {
    const decoded = hexDecode(inputBytes, context);
    
    let text = null;
    let utf8 = true;
    try {
      text = strictUtf8.decode(decoded);
    } catch {
      utf8 = false;
    }
    
    let result;
    if (utf8) {
      result = {
        bytes: decoded.byteLength,
        utf8: true,
        contentKind: "text",
        mime: "text/plain; charset=utf-8",
        text,
        complete: true
      };
    } else {
      result = {
        bytes: decoded.byteLength,
        utf8: false,
        contentKind: "binary",
        mime: "application/octet-stream",
        text: null,
        hexPreview: hexPreview(decoded),
        complete: true
      };
    }
    
    await context.writeValue("output", result);
    await context.write("output", decoded);
    return result;
  }
}
