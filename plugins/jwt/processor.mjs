// JWT decoder and offline verifier (JWS compact serialization, RFC 7515/7519).
//
// Decoding never touches WebCrypto and always succeeds once the three
// dot-separated segments are present, base64url-decodable, and header/payload
// are JSON objects. Verification is a separate, best-effort step reported in
// `signature`: "none" for alg "none", "unsupported" for an alg outside the
// supported families, "not-checked" when no key was supplied, else "valid" or
// "invalid" from crypto.subtle.verify. A key that does not import for the
// algorithm family (wrong PEM shape, wrong key type, mismatched curve) is a
// thrown JwtError naming the family, never a silent "invalid". The `key`
// option value is never echoed in any output, error, or diagnostic.
import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";

export const OPERATION_ID = "security.jwt";
export const SECRET_ENCODINGS = Object.freeze(["utf8", "base64", "base64url"]);

// hash: WebCrypto hash name. saltLength/signatureLength: bytes, JOSE-defined.
export const ALGORITHMS = Object.freeze({
  HS256: Object.freeze({ family: "HMAC", hash: "SHA-256" }),
  HS384: Object.freeze({ family: "HMAC", hash: "SHA-384" }),
  HS512: Object.freeze({ family: "HMAC", hash: "SHA-512" }),
  RS256: Object.freeze({ family: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }),
  RS384: Object.freeze({ family: "RSASSA-PKCS1-v1_5", hash: "SHA-384" }),
  RS512: Object.freeze({ family: "RSASSA-PKCS1-v1_5", hash: "SHA-512" }),
  PS256: Object.freeze({ family: "RSA-PSS", hash: "SHA-256", saltLength: 32 }),
  PS384: Object.freeze({ family: "RSA-PSS", hash: "SHA-384", saltLength: 48 }),
  PS512: Object.freeze({ family: "RSA-PSS", hash: "SHA-512", saltLength: 64 }),
  ES256: Object.freeze({ family: "ECDSA", hash: "SHA-256", namedCurve: "P-256", signatureLength: 64 }),
  ES384: Object.freeze({ family: "ECDSA", hash: "SHA-384", namedCurve: "P-384", signatureLength: 96 }),
  ES512: Object.freeze({ family: "ECDSA", hash: "SHA-512", namedCurve: "P-521", signatureLength: 132 }),
});

export class JwtError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "JwtError";
    this.code = code;
    Object.assign(this, details);
  }
}

function check(context) {
  if (context.cancellation.isCancelled()) throw new ProcessorCancelled();
}

function invalid(message, data) {
  return new JwtError("invalid-option", message, data);
}

const KEY_IDS = ["key"];
const SECRET_ENCODING_IDS = ["secret-encoding", "secretEncoding"];
const CLOCK_TOLERANCE_IDS = ["clock-tolerance-seconds", "clockToleranceSeconds"];
const KNOWN_OPTIONS = new Set([...KEY_IDS, ...SECRET_ENCODING_IDS, ...CLOCK_TOLERANCE_IDS]);

export function readOptions(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid("options must be an object", { received: Array.isArray(raw) ? "array" : typeof raw });
  for (const optionKey of Object.keys(raw)) if (!KNOWN_OPTIONS.has(optionKey)) throw invalid(`unknown option ${optionKey}`, { option: optionKey, known: [...KNOWN_OPTIONS] });

  const key = raw.key === undefined ? "" : raw.key;
  if (typeof key !== "string") throw invalid("key must be a string", { option: "key", received: typeof key });

  const secretEncoding = raw["secret-encoding"] ?? raw.secretEncoding ?? "utf8";
  if (!SECRET_ENCODINGS.includes(secretEncoding)) throw invalid(`secret-encoding must be one of ${SECRET_ENCODINGS.map((item) => JSON.stringify(item)).join(", ")} (received ${JSON.stringify(secretEncoding)})`, { option: "secret-encoding", received: secretEncoding });

  const toleranceRaw = raw["clock-tolerance-seconds"] ?? raw.clockToleranceSeconds ?? 0;
  if (!Number.isInteger(toleranceRaw) || toleranceRaw < 0) throw invalid(`clock-tolerance-seconds must be an integer >= 0 (received ${JSON.stringify(toleranceRaw)})`, { option: "clock-tolerance-seconds", received: toleranceRaw });

  return { key, secretEncoding, clockToleranceSeconds: toleranceRaw };
}

async function readText(context) {
  const chunks = [];
  let length = 0;
  for await (const chunk of context.readChunks("input", 65536)) {
    check(context);
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new JwtError("input-encoding", "input is not valid UTF-8 text", {}); }
}

/** Decode base64 or base64url text to bytes via the platform `atob`; padding is added if missing. */
function decodeBase64Like(text, urlSafe) {
  if (!(urlSafe ? /^[A-Za-z0-9_-]*$/ : /^[A-Za-z0-9+/]*={0,2}$/).test(text)) throw new Error("invalid base64 characters");
  let base64 = urlSafe ? text.replace(/-/g, "+").replace(/_/g, "/") : text;
  base64 += "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64UrlDecodeSegment(raw, name) {
  if (raw.length % 4 === 1) throw new JwtError("segment-base64", `${name} segment has an invalid length for base64url`, { segment: name });
  try { return decodeBase64Like(raw, true); } catch { throw new JwtError("segment-base64", `${name} segment is not valid base64url`, { segment: name }); }
}

function decodeJsonSegment(raw, name) {
  const bytes = base64UrlDecodeSegment(raw, name);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new JwtError("segment-json", `${name} segment is not valid UTF-8`, { segment: name }); }
  let value;
  try { value = JSON.parse(text); } catch { throw new JwtError("segment-json", `${name} segment is not valid JSON`, { segment: name }); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new JwtError("segment-json", `${name} segment must be a JSON object`, { segment: name });
  return value;
}

function decodeSignatureSegment(raw, alg) {
  if (raw === "") {
    if (alg !== "none") throw new JwtError("segment-signature", 'signature segment is empty; only alg: "none" may omit a signature', { segment: "signature", algorithm: alg });
    return new Uint8Array(0);
  }
  return base64UrlDecodeSegment(raw, "signature");
}

function splitToken(text) {
  const parts = text.split(".");
  if (parts.length !== 3) throw new JwtError("structure", `token must have three dot-separated segments (header.payload.signature); found ${parts.length}`, { segments: parts.length });
  return parts;
}

function decodeSecretOption(text, encoding) {
  if (encoding === "utf8") return new TextEncoder().encode(text);
  try { return decodeBase64Like(text, encoding === "base64url"); } catch { throw new JwtError("key-encoding", `key could not be decoded as ${encoding}`, { encoding }); }
}

function pemToDer(pem, family) {
  const match = /-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----/.exec(pem);
  if (!match) throw new JwtError("key-import", `key does not import for the ${family} family: expected a PEM SPKI public key (-----BEGIN PUBLIC KEY-----)`, { family });
  try { return decodeBase64Like(match[1].replace(/\s+/g, ""), false); } catch { throw new JwtError("key-import", `key does not import for the ${family} family: the PEM body is not valid base64`, { family }); }
}

async function verifySignature(alg, options, signatureBytes, signingInput) {
  const spec = ALGORITHMS[alg];
  if (spec.family === "HMAC") {
    const secretBytes = decodeSecretOption(options.key, options.secretEncoding);
    let key;
    try { key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: spec.hash }, false, ["verify"]); }
    catch { throw new JwtError("key-import", `key does not import for the HMAC family (${alg})`, { family: "HMAC", algorithm: alg }); }
    try { return await crypto.subtle.verify("HMAC", key, signatureBytes, signingInput); } catch { return false; }
  }
  const der = pemToDer(options.key, spec.family);
  const importParams = spec.family === "ECDSA" ? { name: "ECDSA", namedCurve: spec.namedCurve } : { name: spec.family, hash: spec.hash };
  let key;
  try { key = await crypto.subtle.importKey("spki", der, importParams, false, ["verify"]); }
  catch { throw new JwtError("key-import", `key does not import for the ${spec.family} family (${alg})`, { family: spec.family, algorithm: alg }); }
  const verifyParams = spec.family === "RSA-PSS" ? { name: "RSA-PSS", saltLength: spec.saltLength } : spec.family === "ECDSA" ? { name: "ECDSA", hash: spec.hash } : { name: "RSASSA-PKCS1-v1_5" };
  try { return await crypto.subtle.verify(verifyParams, key, signatureBytes, signingInput); } catch { return false; }
}

function numericClaim(payload, name) {
  const value = payload?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isoFromSeconds(seconds) {
  return new Date(seconds * 1000).toISOString();
}

function computeClaims(payload, clock, toleranceSeconds) {
  const nowSeconds = new Date(clock.now()).getTime() / 1000;
  const exp = numericClaim(payload, "exp");
  const nbf = numericClaim(payload, "nbf");
  const iat = numericClaim(payload, "iat");
  return {
    expired: exp !== undefined && nowSeconds >= exp + toleranceSeconds,
    notYetValid: nbf !== undefined && nowSeconds < nbf - toleranceSeconds,
    expiresAt: exp !== undefined ? isoFromSeconds(exp) : null,
    notBefore: nbf !== undefined ? isoFromSeconds(nbf) : null,
    issuedAt: iat !== undefined ? isoFromSeconds(iat) : null,
  };
}

function indentBlock(text) {
  return text.split("\n").map((line) => (line.length === 0 ? "" : `  ${line}`)).join("\n");
}

function renderText(result) {
  const headerJson = indentBlock(JSON.stringify(result.header, null, 2));
  const payloadJson = indentBlock(JSON.stringify(result.payload, null, 2));
  const lines = [`signature: ${result.signature}`, `expired: ${result.claims.expired}`, `notYetValid: ${result.claims.notYetValid}`];
  if (result.claims.expiresAt !== null) lines.push(`expiresAt: ${result.claims.expiresAt}`);
  if (result.claims.notBefore !== null) lines.push(`notBefore: ${result.claims.notBefore}`);
  if (result.claims.issuedAt !== null) lines.push(`issuedAt: ${result.claims.issuedAt}`);
  return [headerJson, "", payloadJson, "", indentBlock(lines.join("\n"))].join("\n");
}

export async function execute(request, context) {
  check(context);
  if (request?.operationId !== undefined && request.operationId !== OPERATION_ID) {
    throw new JwtError("unsupported-operation", `unsupported operation ${request.operationId}`, { operationId: request.operationId, supported: [OPERATION_ID] });
  }
  const options = readOptions(request?.options);
  const raw = (await readText(context)).trim();
  const [headerRaw, payloadRaw, signatureRaw] = splitToken(raw);
  const header = decodeJsonSegment(headerRaw, "header");
  const payload = decodeJsonSegment(payloadRaw, "payload");
  const alg = header.alg;
  const signatureBytes = decodeSignatureSegment(signatureRaw, alg);

  let signatureStatus;
  if (alg === "none") {
    signatureStatus = "none";
  } else if (typeof alg !== "string" || !ALGORITHMS[alg]) {
    signatureStatus = "unsupported";
  } else if (options.key === "") {
    signatureStatus = "not-checked";
  } else {
    check(context);
    const signingInput = new TextEncoder().encode(`${headerRaw}.${payloadRaw}`);
    const verified = await verifySignature(alg, options, signatureBytes, signingInput);
    check(context);
    signatureStatus = verified ? "valid" : "invalid";
  }

  const claims = computeClaims(payload, context.clock, options.clockToleranceSeconds);
  const valid = signatureStatus === "valid" && !claims.expired && !claims.notYetValid;
  const result = { header, payload, algorithm: alg, signature: signatureStatus, claims, valid };
  const text = renderText(result);
  const outputBytes = new TextEncoder().encode(text);
  if (outputBytes.byteLength > context.limits.maxOutputBytes) throw new JwtError("output-limit", `output would be ${outputBytes.byteLength} bytes, above the ${context.limits.maxOutputBytes} byte limit`, { needed: outputBytes.byteLength, limit: context.limits.maxOutputBytes });

  await context.writeValue("output", { ...result, text });
  await context.write("output", outputBytes);
  return result;
}
