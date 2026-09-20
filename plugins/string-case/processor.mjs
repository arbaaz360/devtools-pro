import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";

export const OPERATION_ID = "text.case";
export const TARGETS = Object.freeze(["camel", "pascal", "snake", "kebab", "screaming-kebab", "constant"]);

export class StringCaseError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "StringCaseError";
    this.code = code;
    this.diagnostic = { code, severity: "error", message, data };
  }
}

function check(context) {
  if (context.cancellation.isCancelled()) throw new ProcessorCancelled();
}

function invalid(message, data) {
  return new StringCaseError("case.invalid-option", message, data);
}

const TARGET = ["target"];
const ACRONYMS = ["acronyms"];
const PRESERVE_ACRONYMS = ["preserve-acronyms", "preserveAcronyms"];
const KNOWN_OPTIONS = new Set([...TARGET, ...ACRONYMS, ...PRESERVE_ACRONYMS]);

export function normalizeOptions(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid("options must be an object", { received: Array.isArray(raw) ? "array" : typeof raw });
  for (const key of Object.keys(raw)) if (!KNOWN_OPTIONS.has(key)) throw invalid(`unknown option ${key}`, { option: key, known: [...KNOWN_OPTIONS] });

  const target = raw.target === undefined ? "camel" : raw.target;
  if (!TARGETS.includes(target)) throw invalid(`target must be one of ${TARGETS.join(", ")}`, { option: "target", received: target });

  const acronymsRaw = raw.acronyms === undefined ? "ID,API,DB,URL,HTTP" : raw.acronyms;
  if (typeof acronymsRaw !== "string") throw invalid(`acronyms must be a string`, { option: "acronyms", received: typeof acronymsRaw });

  let preserveAcronyms = true;
  const suppliedPreserve = PRESERVE_ACRONYMS.filter((id) => raw[id] !== undefined);
  if (suppliedPreserve.length > 0) {
    for (const id of suppliedPreserve) if (typeof raw[id] !== "boolean") throw invalid(`${id} must be a boolean`, { option: id, received: typeof raw[id] });
    if (suppliedPreserve.length > 1 && raw[suppliedPreserve[0]] !== raw[suppliedPreserve[1]]) throw invalid(`${suppliedPreserve[0]} and ${suppliedPreserve[1]} disagree`, { options: suppliedPreserve });
    preserveAcronyms = raw[suppliedPreserve[0]];
  }

  const acronymsList = acronymsRaw.split(',').map(s => s.trim()).filter(s => s.length > 0).map(s => s.toUpperCase());

  return {
    target,
    acronyms: new Set(acronymsList),
    preserveAcronyms
  };
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

async function readText(context) {
  const chunks = [];
  let length = 0;
  for await (const chunk of context.readChunks("input", 65536)) {
    check(context);
    length += chunk.byteLength;
    if (length > context.limits.maxInputBytes) throw new StringCaseError("case.input-limit", `input exceeds ${context.limits.maxInputBytes} bytes`, { bytes: length, limit: context.limits.maxInputBytes });
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let text;
  try { text = decoder.decode(bytes); } catch { throw new StringCaseError("case.invalid-utf8", "input is not valid UTF-8 text", { bytes: length }); }
  return { text, inputBytes: length };
}

function splitWords(s) {
  let modified = s.replace(/([\p{Ll}\p{M}])([\p{Lu}])/gu, "$1 $2");
  modified = modified.replace(/([\p{Lu}\p{M}]+)([\p{Lu}][\p{Ll}])/gu, "$1 $2");
  modified = modified.replace(/([\p{L}\p{M}])([\p{N}])/gu, "$1 $2");
  modified = modified.replace(/([\p{N}])([\p{L}\p{M}])/gu, "$1 $2");
  return Array.from(modified.matchAll(/[\p{L}\p{N}\p{M}]+/gu)).map(m => m[0]);
}

function convertWord(word, index, target, isAcronym) {
  if (isAcronym) {
    if (target === 'camel' && index === 0) return word.toLowerCase();
    if (target === 'camel' || target === 'pascal') return word.toUpperCase();
    if (target === 'snake' || target === 'kebab') return word.toLowerCase();
    if (target === 'screaming-kebab' || target === 'constant') return word.toUpperCase();
  }

  if (target === 'camel') {
    if (index === 0) return word.toLowerCase();
    const chars = Array.from(word);
    return chars[0].toUpperCase() + chars.slice(1).join('').toLowerCase();
  }
  if (target === 'pascal') {
    const chars = Array.from(word);
    return chars[0].toUpperCase() + chars.slice(1).join('').toLowerCase();
  }
  if (target === 'snake' || target === 'kebab') {
    return word.toLowerCase();
  }
  if (target === 'screaming-kebab' || target === 'constant') {
    return word.toUpperCase();
  }
  return word;
}

export async function execute(request, context) {
  check(context);
  if (request?.operationId !== undefined && request.operationId !== OPERATION_ID) {
    throw new StringCaseError("case.unsupported-operation", `unsupported operation ${request.operationId}`, { operationId: request.operationId, supported: [OPERATION_ID] });
  }
  const options = normalizeOptions(request?.options);
  const { text, inputBytes } = await readText(context);

  const parts = text.split(/(\r\n|\n)/);
  const outParts = [];
  let acronymsApplied = 0;

  let steps = 0;
  for (let idx = 0; idx < parts.length; idx++) {
    const token = parts[idx];
    if (idx % 2 === 1) {
      outParts.push(token);
      continue;
    }

    if ((steps++ & 1023) === 0) check(context);
    if (token === "") {
      outParts.push(token);
      continue;
    }
    const leadingMatch = token.match(/^\s*/);
    const trailingMatch = token.match(/\s*$/);
    const leading = leadingMatch[0];
    const trailing = trailingMatch[0];

    if (leading.length === token.length) {
      outParts.push(token);
      continue;
    }

    const middle = token.slice(leading.length, token.length - trailing.length);
    const words = splitWords(middle);

    if (words.length === 0) {
      outParts.push(token);
      continue;
    }

    const convertedWords = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const isAcronym = options.preserveAcronyms && options.acronyms.has(w.toUpperCase());
      if (isAcronym) acronymsApplied++;
      convertedWords.push(convertWord(w, i, options.target, isAcronym));
    }

    let sep = "";
    if (options.target === 'snake' || options.target === 'constant') sep = "_";
    if (options.target === 'kebab' || options.target === 'screaming-kebab') sep = "-";

    outParts.push(leading + convertedWords.join(sep) + trailing);
  }

  const output = outParts.join('');
  const outputBytes = encoder.encode(output);

  if (outputBytes.byteLength > context.limits.maxOutputBytes) {
    throw new StringCaseError("case.output-limit", `output exceeds ${context.limits.maxOutputBytes} bytes`, { bytes: outputBytes.byteLength, limit: context.limits.maxOutputBytes });
  }

  const report = {
    lines: Math.floor((parts.length + 1) / 2),
    converted: output !== text,
    acronymsApplied,
    text: output
  };

  await context.writeValue("output", report);
  await context.write("output", outputBytes);
  return report;
}
