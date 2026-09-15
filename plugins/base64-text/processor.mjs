const STANDARD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URLSAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const encoder = new TextEncoder();

function alphabet(variant) {
  if (variant === "standard") return STANDARD;
  if (variant === "url") return URLSAFE;
  throw new Error("variant must be standard or url");
}

function encode(bytes, table, padding) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]; const b = bytes[i + 1]; const c = bytes[i + 2];
    out += table[a >> 2];
    out += table[((a & 3) << 4) | (b === undefined ? 0 : b >> 4)];
    out += b === undefined ? "=" : table[((b & 15) << 2) | (c === undefined ? 0 : c >> 6)];
    out += c === undefined ? "=" : table[c & 63];
  }
  return padding === "omit" ? out.replace(/=+$/, "") : out;
}

function decode(value, table, padding, policy) {
  if (typeof value !== "string") throw new Error("Base64 input must be text");
  let text = value;
  if (policy === "tolerant" || policy === "replace") text = text.replace(/[\t\n\r ]/g, "");
  if (policy !== "strict" && padding === "optional") padding = "optional";
  if (text.length === 0) return new Uint8Array();
  if (/[^A-Za-z0-9+/_=-]/.test(text)) throw new Error("invalid Base64 character");
  if (table === URLSAFE && /[+/]/.test(text)) throw new Error("standard Base64 characters are not valid for the URL-safe variant");
  if (table === STANDARD && /[-_]/.test(text)) throw new Error("URL-safe Base64 characters are not valid for the standard variant");
  const firstPad = text.indexOf("=");
  if (firstPad >= 0 && /[^=]/.test(text.slice(firstPad))) throw new Error("padding must be at the end");
  const padCount = firstPad < 0 ? 0 : text.length - firstPad;
  if (padCount > 2 || text.length % 4 === 1) throw new Error("invalid Base64 length or padding");
  if (padding === "required" && text.length % 4 !== 0) throw new Error("padding is required");
  if (padding === "omit" && padCount !== 0) throw new Error("padding is not allowed");
  if (padCount && text.length % 4 !== 0) throw new Error("invalid Base64 padding");
  if (!padCount && padding !== "required" && text.length % 4 === 1) throw new Error("invalid Base64 length");
  const unpadded = text.replace(/=+$/, "");
  const padded = unpadded + "=".repeat((4 - (unpadded.length % 4)) % 4);
  const out = [];
  for (let i = 0; i < padded.length; i += 4) {
    const a = table.indexOf(padded[i]); const b = table.indexOf(padded[i + 1]);
    const c = padded[i + 2] === "=" ? 0 : table.indexOf(padded[i + 2]);
    const d = padded[i + 3] === "=" ? 0 : table.indexOf(padded[i + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error("invalid Base64 character");
    if (padded[i + 2] === "=" && (b & 15) !== 0) throw new Error("non-canonical Base64 trailing bits");
    if (padded[i + 3] === "=" && padded[i + 2] !== "=" && (c & 3) !== 0) throw new Error("non-canonical Base64 trailing bits");
    out.push((a << 2) | (b >> 4));
    if (padded[i + 2] !== "=") out.push(((b & 15) << 4) | (c >> 2));
    if (padded[i + 3] !== "=") out.push(((c & 3) << 6) | d);
  }
  return Uint8Array.from(out);
}

export async function execute(request, context) {
  const options = request?.options ?? {};
  const mode = options.mode ?? "encode";
  const variant = options.variant ?? "standard";
  const padding = options.padding ?? "required";
  const policy = options["error-policy"] ?? options.errorPolicy ?? "strict";
  if (!["encode", "decode"].includes(mode)) throw new Error("mode must be encode or decode");
  if (!["required", "omit", "optional"].includes(padding)) throw new Error("padding must be required, omit or optional");
  if (!["strict", "tolerant", "replace"].includes(policy)) throw new Error("errorPolicy must be strict, tolerant or replace");
  const input = new TextDecoder().decode(await context.read("input"));
  const table = alphabet(variant);
  let outputBytes;
  let outputText;
  if (mode === "encode") {
    outputText = encode(encoder.encode(input), table, padding);
    outputBytes = encoder.encode(outputText);
  } else {
    const decoded = decode(input, table, padding, policy);
    try { outputText = new TextDecoder("utf-8", { fatal: policy !== "replace" }).decode(decoded); }
    catch { throw new Error("decoded bytes are not valid UTF-8"); }
    outputBytes = encoder.encode(outputText);
  }
  const result = { mode, variant, padding, errorPolicy: policy, text: outputText, inputBytes: encoder.encode(input).byteLength, outputBytes: outputBytes.byteLength, complete: true };
  await context.writeValue("output", result);
  await context.write("output", outputBytes);
  return result;
}
