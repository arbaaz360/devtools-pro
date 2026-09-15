import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
const UNRESERVED = /^[A-Za-z0-9._~-]$/u;
const FORM_SAFE = /^[A-Za-z0-9.*_-]$/u;

function check(context) {
  if (context.cancellation.isCancelled()) throw new ProcessorCancelled();
}

async function readText(context) {
  const chunks = [];
  let length = 0;
  for await (const chunk of context.readChunks("input", 64 * 1024)) {
    chunks.push(chunk); length += chunk.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return { text: fatalDecoder.decode(bytes), inputBytes: length }; }
  catch { throw new Error("input is not valid UTF-8 text"); }
}

function encodePercent(text, form, context) {
  let output = "";
  let seen = 0;
  for (const character of text) {
    if ((seen++ & 4095) === 0) check(context);
    if (form && character === " ") { output += "+"; continue; }
    const safe = form ? FORM_SAFE : UNRESERVED;
    if (safe.test(character)) { output += character; continue; }
    for (const byte of encoder.encode(character)) output += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return output;
}

function decodePercent(text, form, context) {
  const bytes = [];
  for (let index = 0; index < text.length;) {
    if ((index & 4095) === 0) check(context);
    const code = text.charCodeAt(index);
    if (code === 0x25) {
      if (index + 2 >= text.length) throw new Error(`percent escape is truncated at UTF-16 offset ${index}`);
      const token = text.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/u.test(token)) throw new Error(`percent escape must use two hexadecimal digits at UTF-16 offset ${index}`);
      bytes.push(Number.parseInt(token, 16)); index += 3; continue;
    }
    const character = String.fromCodePoint(text.codePointAt(index));
    if (form && character === "+") bytes.push(0x20);
    else bytes.push(...encoder.encode(character));
    index += character.length;
  }
  try { return fatalDecoder.decode(Uint8Array.from(bytes)); }
  catch { throw new Error("percent-decoded bytes are not valid UTF-8"); }
}

function querySlice(input) {
  const trimmed = input.trim();
  const question = trimmed.indexOf("?");
  const looksLikeUrl = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(trimmed);
  if (looksLikeUrl && question < 0) return { query: "", url: new URL(trimmed) };
  let raw = question >= 0 ? trimmed.slice(question + 1) : trimmed.replace(/^\?/, "");
  const fragment = raw.indexOf("#");
  if (fragment >= 0) raw = raw.slice(0, fragment);
  let url = null;
  if (looksLikeUrl) {
    try { url = new URL(trimmed); } catch { throw new Error("full URL input is malformed"); }
  }
  return { query: raw, url };
}

function parseQuery(input, context) {
  const { query, url } = querySlice(input);
  const entries = [];
  const parameters = {};
  if (query !== "") {
    for (const part of query.split("&")) {
      check(context);
      if (entries.length >= 10000) throw new Error("query contains more than 10,000 parameters");
      const equals = part.indexOf("=");
      const rawName = equals < 0 ? part : part.slice(0, equals);
      const rawValue = equals < 0 ? "" : part.slice(equals + 1);
      const decodedName = decodePercent(rawName, true, context);
      const value = decodePercent(rawValue, true, context);
      const arrayNotation = decodedName.endsWith("[]");
      const name = arrayNotation ? decodedName.slice(0, -2) : decodedName;
      entries.push({ name, value, arrayNotation, hadEquals: equals >= 0 });
      if (!(name in parameters)) parameters[name] = arrayNotation ? [value] : value;
      else if (Array.isArray(parameters[name])) parameters[name].push(value);
      else parameters[name] = [parameters[name], value];
    }
  }
  const components = url ? { href: url.href, scheme: url.protocol.slice(0, -1), host: url.host, path: url.pathname, fragment: url.hash.slice(1) } : null;
  return { parameters, entries, components, bracketSemantics: "terminal [] creates an array; other brackets are literal" };
}

async function emit(context, text, value) {
  const bytes = encoder.encode(text);
  if (bytes.byteLength > context.limits.maxOutputBytes) throw new Error(`output exceeds ${context.limits.maxOutputBytes} bytes`);
  await context.writeValue("output", value);
  await context.write("output", bytes);
}

export async function execute(request, context) {
  const { text, inputBytes } = await readText(context);
  const options = request?.options ?? {};
  if (request?.operationId === "url.parse-query") {
    const indent = Number(options.indent ?? 2);
    if (!Number.isSafeInteger(indent) || indent < 0 || indent > 8) throw new Error("indent must be an integer from 0 to 8");
    const result = parseQuery(text, context);
    const output = JSON.stringify(result.parameters, null, indent);
    await emit(context, output, { ...result, inputBytes, outputBytes: encoder.encode(output).byteLength, complete: true });
    return result;
  }
  if (request?.operationId !== undefined && request.operationId !== "url.transform") throw new Error(`unsupported operation ${request.operationId}`);
  const mode = options.mode ?? "encode";
  const encoding = options.encoding ?? "rfc3986";
  if (mode !== "encode" && mode !== "decode") throw new Error("mode must be encode or decode");
  if (encoding !== "rfc3986" && encoding !== "form") throw new Error("encoding must be rfc3986 or form");
  const output = mode === "encode" ? encodePercent(text, encoding === "form", context) : decodePercent(text, encoding === "form", context);
  await emit(context, output, { mode, encoding, text: output, inputBytes, outputBytes: encoder.encode(output).byteLength, complete: true });
  return output;
}
