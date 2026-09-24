import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorCancelled, ProcessorContext, SeededRandom,
} from "../../packages/plugin-sdk/src/context.ts";
import { ALGORITHMS, JwtError, execute } from "./processor.mjs";

const te = new TextEncoder();
const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const NOW = "2024-01-01T00:00:00.000Z";
const NOW_SECONDS = Math.floor(Date.parse(NOW) / 1000);
const LIMITS = { maxInputBytes: 65536, maxOutputBytes: 1048576, maxChunkBytes: 1048576, deadlineMs: 1000 };
const FIXED_SECRET = "your-256-bit-secret";

function b64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64urlJson = (value) => b64url(te.encode(JSON.stringify(value)));

async function pemOf(publicKey) {
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
  let binary = "";
  for (const byte of spki) binary += String.fromCharCode(byte);
  const lines = btoa(binary).match(/.{1,64}/g).join("\n");
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----\n`;
}

async function signToken(alg, header, payload, sign) {
  const h = b64urlJson(header);
  const p = b64urlJson(payload);
  const signatureBytes = await sign(te.encode(`${h}.${p}`));
  return { token: `${h}.${p}.${b64url(signatureBytes)}`, signatureBytes };
}

async function hmacSigner(secretBytes, hash) {
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash }, false, ["sign"]);
  return async (data) => new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}
async function rsaPkcs1(hash) {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash }, true, ["sign", "verify"]);
  return { pem: await pemOf(pair.publicKey), sign: async (data) => new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, pair.privateKey, data)) };
}
async function rsaPss(hash, saltLength) {
  const pair = await crypto.subtle.generateKey({ name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash }, true, ["sign", "verify"]);
  return { pem: await pemOf(pair.publicKey), sign: async (data) => new Uint8Array(await crypto.subtle.sign({ name: "RSA-PSS", saltLength }, pair.privateKey, data)) };
}
async function ecdsa(namedCurve, hash) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve }, true, ["sign", "verify"]);
  return { pem: await pemOf(pair.publicKey), sign: async (data) => new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash }, pair.privateKey, data)) };
}

// Generated once with WebCrypto; nothing here is committed to disk.
const KEYS = {
  RS256: await rsaPkcs1("SHA-256"), RS384: await rsaPkcs1("SHA-384"), RS512: await rsaPkcs1("SHA-512"),
  PS256: await rsaPss("SHA-256", 32), PS384: await rsaPss("SHA-384", 48), PS512: await rsaPss("SHA-512", 64),
  ES256: await ecdsa("P-256", "SHA-256"), ES384: await ecdsa("P-384", "SHA-384"), ES512: await ecdsa("P-521", "SHA-512"),
};
// A second, unrelated key per family/curve: same shape (so it imports), wrong material (so verification fails).
const WRONG_RSA = await rsaPkcs1("SHA-256");
const WRONG_EC = { P256: await ecdsa("P-256", "SHA-256"), P384: await ecdsa("P-384", "SHA-384"), P521: await ecdsa("P-521", "SHA-512") };

async function run(options, tokenText, { cancellation = new CancellationToken(), clock = new FixedClock(NOW), limits = LIMITS } = {}) {
  const reader = new MemoryReader().insert("input", tokenText);
  const before = reader.inputs.get("input").slice();
  const outputs = new MemoryOutputSink();
  const context = new ProcessorContext(reader, outputs, cancellation, clock, new SeededRandom(1), new MemorySecrets(), limits);
  const result = await execute({ pluginId: "security.jwt", toolId: "security.jwt", operationId: "security.jwt", options }, context);
  assert.deepEqual(reader.inputs.get("input"), before, "source bytes must be untouched");
  const bytes = outputs.bytes.get("output");
  return { result, value: outputs.values.get("output"), bytes, text: bytes ? new TextDecoder().decode(bytes) : undefined };
}

async function rejects(options, tokenText, code, { cancellation = new CancellationToken(), clock = new FixedClock(NOW), limits = LIMITS } = {}) {
  const sink = new MemoryOutputSink();
  const context = new ProcessorContext(new MemoryReader().insert("input", tokenText), sink, cancellation, clock, new SeededRandom(1), new MemorySecrets(), limits);
  let caught;
  try { await execute({ options }, context); } catch (error) { caught = error; }
  assert.ok(caught, `expected ${code} for ${JSON.stringify(tokenText)}`);
  if (code) { assert.ok(caught instanceof JwtError, `expected JwtError, got ${caught.name}: ${caught.message}`); assert.equal(caught.code, code, caught.message); }
  assert.equal(sink.bytes.size, 0, "no output may be written on failure");
  assert.equal(sink.values.size, 0, "no output may be written on failure");
  return caught;
}

test("algorithm table matches the JOSE-defined hash and signature sizes", () => {
  assert.equal(ALGORITHMS.PS256.saltLength, 32);
  assert.equal(ALGORITHMS.PS384.saltLength, 48);
  assert.equal(ALGORITHMS.PS512.saltLength, 64);
  assert.equal(ALGORITHMS.ES256.signatureLength, 64);
  assert.equal(ALGORITHMS.ES384.signatureLength, 96);
  assert.equal(ALGORITHMS.ES512.signatureLength, 132);
});

test("decode only: an empty key never verifies and is reported not-checked", async () => {
  const { hs256 } = await fixture("jwt-known");
  const { result, value, text } = await run({}, hs256.token);
  assert.deepEqual(result.header, hs256.header);
  assert.deepEqual(result.payload, hs256.payload);
  assert.equal(result.algorithm, "HS256");
  assert.equal(result.signature, "not-checked");
  assert.equal(result.valid, false);
  assert.equal(result.claims.issuedAt, new Date(hs256.payload.iat * 1000).toISOString());
  assert.equal(result.claims.expiresAt, null);
  assert.equal(result.claims.notBefore, null);
  assert.equal(value.text, text);
});

test("the known HS256 vector verifies with its secret and fails with the wrong one", async () => {
  const { hs256 } = await fixture("jwt-known");
  const good = await run({ key: hs256.secret }, hs256.token);
  assert.equal(good.result.signature, "valid");
  assert.equal(good.result.valid, true);
  const bad = await run({ key: "the-wrong-secret" }, hs256.token);
  assert.equal(bad.result.signature, "invalid");
  assert.equal(bad.result.valid, false);
});

test("the static self-generated RS256 vector verifies with its PEM public key and fails with a different one", async () => {
  const { rs256 } = await fixture("jwt-known");
  const good = await run({ key: rs256.publicKeyPem }, rs256.token);
  assert.equal(good.result.signature, "valid");
  assert.equal(good.result.valid, true);
  const bad = await run({ key: WRONG_RSA.pem }, rs256.token);
  assert.equal(bad.result.signature, "invalid");
});

test("every HS/RS/PS/ES algorithm verifies a freshly signed token and rejects a wrong key of the same shape", async () => {
  for (const alg of ["HS256", "HS384", "HS512"]) {
    const secretBytes = te.encode(FIXED_SECRET);
    const sign = await hmacSigner(secretBytes, ALGORITHMS[alg].hash);
    const { token } = await signToken(alg, { alg, typ: "JWT" }, { sub: "1", iat: NOW_SECONDS }, sign);
    assert.equal((await run({ key: FIXED_SECRET }, token)).result.signature, "valid", alg);
    assert.equal((await run({ key: "not-the-secret" }, token)).result.signature, "invalid", alg);
  }
  for (const alg of ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512"]) {
    const { pem, sign } = KEYS[alg];
    const { token } = await signToken(alg, { alg, typ: "JWT" }, { sub: "1", iat: NOW_SECONDS }, sign);
    assert.equal((await run({ key: pem }, token)).result.signature, "valid", alg);
    assert.equal((await run({ key: WRONG_RSA.pem }, token)).result.signature, "invalid", alg);
  }
  for (const [alg, wrong] of [["ES256", WRONG_EC.P256], ["ES384", WRONG_EC.P384], ["ES512", WRONG_EC.P521]]) {
    const { pem, sign } = KEYS[alg];
    const { token, signatureBytes } = await signToken(alg, { alg, typ: "JWT" }, { sub: "1", iat: NOW_SECONDS }, sign);
    assert.equal(signatureBytes.byteLength, ALGORITHMS[alg].signatureLength, `${alg}: JOSE raw r||s length`);
    assert.equal((await run({ key: pem }, token)).result.signature, "valid", alg);
    assert.equal((await run({ key: wrong.pem }, token)).result.signature, "invalid", alg);
  }
});

test('alg "none" never verifies, with or without a signature segment, even when a key is supplied', async () => {
  const withoutSignature = `${b64urlJson({ alg: "none" })}.${b64urlJson({})}.`;
  const withSignature = `${b64urlJson({ alg: "none" })}.${b64urlJson({})}.AAAA`;
  for (const token of [withoutSignature, withSignature]) {
    const { result } = await run({ key: FIXED_SECRET }, token);
    assert.equal(result.signature, "none");
    assert.equal(result.valid, false);
  }
});

test("an alg outside the supported list is reported unsupported, with the value named, not an exception", async () => {
  const token = `${b64urlJson({ alg: "HS1" })}.${b64urlJson({})}.AAAA`;
  const { result } = await run({ key: FIXED_SECRET }, token);
  assert.equal(result.algorithm, "HS1");
  assert.equal(result.signature, "unsupported");
  assert.equal(result.valid, false);
});

test("malformed tokens are structured errors naming the segment and reason", async () => {
  for (const vector of await fixture("jwt-malformed")) {
    const error = await rejects({}, vector.token, vector.code);
    if (vector.segment) assert.equal(error.segment, vector.segment, vector.name);
    if (vector.segments !== undefined) assert.equal(error.segments, vector.segments, vector.name);
  }
});

test("a key that does not import for the algorithm family is a structured error naming the family, never a silent invalid", async () => {
  const { rs256 } = await fixture("jwt-known");
  const notPem = await rejects({ key: "just-a-plain-string" }, rs256.token, "key-import");
  assert.equal(notPem.family, "RSASSA-PKCS1-v1_5");
  const wrongKeyType = await rejects({ key: WRONG_EC.P256.pem }, rs256.token, "key-import");
  assert.equal(wrongKeyType.family, "RSASSA-PKCS1-v1_5");

  const { sign } = KEYS.ES256;
  const { token: es256Token } = await signToken("ES256", { alg: "ES256", typ: "JWT" }, { sub: "1" }, sign);
  const wrongCurve = await rejects({ key: WRONG_EC.P384.pem }, es256Token, "key-import");
  assert.equal(wrongCurve.family, "ECDSA");
});

test("key-encoding failures for HMAC secrets are structured errors naming the encoding, not the value", async () => {
  const error = await rejects({ key: "not valid base64!!", "secret-encoding": "base64" }, (await fixture("jwt-known")).hs256.token, "key-encoding");
  assert.equal(error.encoding, "base64");
  assert.ok(!error.message.includes("not valid base64!!"));
});

test("secret-encoding accepts base64 and base64url and decodes to the same bytes as utf8", async () => {
  const secretBytes = te.encode(FIXED_SECRET);
  const sign = await hmacSigner(secretBytes, "SHA-256");
  const { token } = await signToken("HS256", { alg: "HS256" }, { sub: "1" }, sign);
  const b64 = btoa(Array.from(secretBytes, (b) => String.fromCharCode(b)).join(""));
  const b64u = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal((await run({ key: FIXED_SECRET, "secret-encoding": "utf8" }, token)).result.signature, "valid");
  assert.equal((await run({ key: b64, "secret-encoding": "base64" }, token)).result.signature, "valid");
  assert.equal((await run({ key: b64u, "secret-encoding": "base64url" }, token)).result.signature, "valid");
  assert.equal((await run({ key: b64, secretEncoding: "base64" }, token)).result.signature, "valid", "camelCase alias");
});

test("exp in the past is expired without tolerance and not expired once tolerance covers the gap", async () => {
  const sign = await hmacSigner(te.encode(FIXED_SECRET), "SHA-256");
  const { token } = await signToken("HS256", { alg: "HS256" }, { exp: NOW_SECONDS - 100 }, sign);
  const noTolerance = await run({ key: FIXED_SECRET }, token);
  assert.equal(noTolerance.result.claims.expired, true);
  assert.equal(noTolerance.result.claims.expiresAt, new Date((NOW_SECONDS - 100) * 1000).toISOString());
  // Tolerance exactly equal to the gap still lands on the expiry boundary (now == exp + tolerance),
  // which is expired per AG-133; only a tolerance past the gap is not expired.
  const exactlyAtBoundary = await run({ key: FIXED_SECRET, "clock-tolerance-seconds": 100 }, token);
  assert.equal(exactlyAtBoundary.result.claims.expired, true);
  const covered = await run({ key: FIXED_SECRET, "clock-tolerance-seconds": 101 }, token);
  assert.equal(covered.result.claims.expired, false);
});

test("nbf in the future is not-yet-valid without tolerance and valid once tolerance covers the gap", async () => {
  const sign = await hmacSigner(te.encode(FIXED_SECRET), "SHA-256");
  const { token } = await signToken("HS256", { alg: "HS256" }, { nbf: NOW_SECONDS + 100 }, sign);
  const noTolerance = await run({ key: FIXED_SECRET }, token);
  assert.equal(noTolerance.result.claims.notYetValid, true);
  assert.equal(noTolerance.result.claims.notBefore, new Date((NOW_SECONDS + 100) * 1000).toISOString());
  const covered = await run({ key: FIXED_SECRET, "clock-tolerance-seconds": 100 }, token);
  assert.equal(covered.result.claims.notYetValid, false);
});

test("exp: expired strictly from the boundary instant onward, at whole-second and tolerance-shifted boundaries (AG-133)", async () => {
  const sign = await hmacSigner(te.encode(FIXED_SECRET), "SHA-256");
  const cases = [
    { label: "exp one second before now, tolerance 0", exp: NOW_SECONDS - 1, tolerance: 0, expectedExpired: true },
    { label: "exp exactly at now, tolerance 0", exp: NOW_SECONDS, tolerance: 0, expectedExpired: true },
    { label: "exp one second after now, tolerance 0", exp: NOW_SECONDS + 1, tolerance: 0, expectedExpired: false },
    { label: "exp one second before now, tolerance 30", exp: NOW_SECONDS - 1, tolerance: 30, expectedExpired: false },
    { label: "exp exactly at now, tolerance 30", exp: NOW_SECONDS, tolerance: 30, expectedExpired: false },
    { label: "exp one second after now, tolerance 30", exp: NOW_SECONDS + 1, tolerance: 30, expectedExpired: false },
  ];
  for (const { label, exp, tolerance, expectedExpired } of cases) {
    const { token } = await signToken("HS256", { alg: "HS256" }, { exp }, sign);
    const { result } = await run({ key: FIXED_SECRET, "clock-tolerance-seconds": tolerance }, token);
    assert.equal(result.claims.expired, expectedExpired, label);
  }
});

test("exp: a fractional NumericDate is honoured to sub-second precision, never floored toward validity (AG-133)", async () => {
  const sign = await hmacSigner(te.encode(FIXED_SECRET), "SHA-256");
  const clock = new FixedClock("2024-01-01T00:00:00.500Z");
  const halfSecondNow = NOW_SECONDS + 0.5;
  const cases = [
    { label: "fractional exp one second before now, tolerance 0", exp: halfSecondNow - 1, tolerance: 0, expectedExpired: true },
    { label: "fractional exp exactly at now, tolerance 0", exp: halfSecondNow, tolerance: 0, expectedExpired: true },
    { label: "fractional exp one second after now, tolerance 0", exp: halfSecondNow + 1, tolerance: 0, expectedExpired: false },
    { label: "fractional exp one second before now, tolerance 30", exp: halfSecondNow - 1, tolerance: 30, expectedExpired: false },
    { label: "fractional exp exactly at now, tolerance 30", exp: halfSecondNow, tolerance: 30, expectedExpired: false },
    { label: "fractional exp one second after now, tolerance 30", exp: halfSecondNow + 1, tolerance: 30, expectedExpired: false },
  ];
  for (const { label, exp, tolerance, expectedExpired } of cases) {
    const { token } = await signToken("HS256", { alg: "HS256" }, { exp }, sign);
    const { result } = await run({ key: FIXED_SECRET, "clock-tolerance-seconds": tolerance }, token, { clock });
    assert.equal(result.claims.expired, expectedExpired, label);
  }
});

test("nbf: valid from the boundary instant onward, not-yet-valid only strictly before it, at whole-second and tolerance-shifted boundaries (AG-133)", async () => {
  const sign = await hmacSigner(te.encode(FIXED_SECRET), "SHA-256");
  const cases = [
    { label: "nbf one second before now, tolerance 0", nbf: NOW_SECONDS - 1, tolerance: 0, expectedNotYetValid: false },
    { label: "nbf exactly at now, tolerance 0", nbf: NOW_SECONDS, tolerance: 0, expectedNotYetValid: false },
    { label: "nbf one second after now, tolerance 0", nbf: NOW_SECONDS + 1, tolerance: 0, expectedNotYetValid: true },
    { label: "nbf one second before now, tolerance 30", nbf: NOW_SECONDS - 1, tolerance: 30, expectedNotYetValid: false },
    { label: "nbf exactly at now, tolerance 30", nbf: NOW_SECONDS, tolerance: 30, expectedNotYetValid: false },
    { label: "nbf one second after now, tolerance 30", nbf: NOW_SECONDS + 1, tolerance: 30, expectedNotYetValid: false },
  ];
  for (const { label, nbf, tolerance, expectedNotYetValid } of cases) {
    const { token } = await signToken("HS256", { alg: "HS256" }, { nbf }, sign);
    const { result } = await run({ key: FIXED_SECRET, "clock-tolerance-seconds": tolerance }, token);
    assert.equal(result.claims.notYetValid, expectedNotYetValid, label);
  }
});

test("expired claims are reported separately from a valid signature: expired true, signature valid, valid false", async () => {
  const sign = await hmacSigner(te.encode(FIXED_SECRET), "SHA-256");
  const { token } = await signToken("HS256", { alg: "HS256" }, { exp: NOW_SECONDS - 100 }, sign);
  const { result } = await run({ key: FIXED_SECRET }, token);
  assert.equal(result.claims.expired, true);
  assert.equal(result.signature, "valid");
  assert.equal(result.valid, false);
});

test("absent exp/nbf/iat claims are null, and expired/notYetValid default to false", async () => {
  const sign = await hmacSigner(te.encode(FIXED_SECRET), "SHA-256");
  const { token } = await signToken("HS256", { alg: "HS256" }, { sub: "1" }, sign);
  const { result } = await run({ key: FIXED_SECRET }, token);
  assert.deepEqual(result.claims, { expired: false, notYetValid: false, expiresAt: null, notBefore: null, issuedAt: null });
});

test("the text representation is header JSON, blank line, payload JSON, blank line, signature and present claims, all indented", async () => {
  const { hs256 } = await fixture("jwt-known");
  const { text } = await run({ key: hs256.secret }, hs256.token);
  const lines = text.split("\n");
  const blanks = lines.filter((line) => line === "");
  assert.equal(blanks.length, 2, "exactly two separating blank lines");
  for (const line of lines) if (line !== "") assert.ok(line.startsWith("  "), `not indented: ${JSON.stringify(line)}`);
  assert.ok(text.includes('  "alg": "HS256"'));
  assert.ok(text.includes('  "sub": "1234567890"'));
  assert.ok(text.includes("  signature: valid"));
  assert.ok(text.includes("  issuedAt: "));
  assert.ok(!text.includes("expiresAt"), "absent claim is omitted, not printed as null");
  assert.ok(!text.includes("notBefore"), "absent claim is omitted, not printed as null");
});

test("the key option is never echoed in output or in any error", async () => {
  const marker = "sh0uldN3verLeak";
  const sign = await hmacSigner(te.encode(marker), "SHA-256");
  const { token } = await signToken("HS256", { alg: "HS256" }, { sub: "1" }, sign);
  const good = await run({ key: marker }, token);
  assert.ok(!JSON.stringify(good.value).includes(marker));
  assert.ok(!good.text.includes(marker));
  const badPem = `-----BEGIN PUBLIC KEY-----\n${marker}\n-----END PUBLIC KEY-----\n`;
  const { rs256 } = await fixture("jwt-known");
  const error = await rejects({ key: badPem }, rs256.token, "key-import");
  assert.ok(!error.message.includes(marker));
  assert.ok(!JSON.stringify(error).includes(marker));
});

test("cancellation is polled before and after the WebCrypto verification call", async () => {
  class CancelAfter { constructor(n) { this.n = n; this.calls = 0; } isCancelled() { this.calls += 1; return this.calls > this.n; } }
  const { hs256 } = await fixture("jwt-known");
  await assert.rejects(() => run({ key: hs256.secret }, hs256.token, { cancellation: new CancelAfter(2) }), ProcessorCancelled, "before verify");
  await assert.rejects(() => run({ key: hs256.secret }, hs256.token, { cancellation: new CancelAfter(3) }), ProcessorCancelled, "after verify");
});

test("options are validated with the manifest ids; unknown options and wrong types are named", async () => {
  const { hs256 } = await fixture("jwt-known");
  const unknown = await rejects({ nope: true }, hs256.token, "invalid-option");
  assert.equal(unknown.option, "nope");
  const wrongKeyType = await rejects({ key: 5 }, hs256.token, "invalid-option");
  assert.equal(wrongKeyType.option, "key");
  const wrongEncoding = await rejects({ "secret-encoding": "hex" }, hs256.token, "invalid-option");
  assert.equal(wrongEncoding.option, "secret-encoding");
  const negativeTolerance = await rejects({ "clock-tolerance-seconds": -1 }, hs256.token, "invalid-option");
  assert.equal(negativeTolerance.option, "clock-tolerance-seconds");
  const nonIntegerTolerance = await rejects({ "clock-tolerance-seconds": 1.5 }, hs256.token, "invalid-option");
  assert.equal(nonIntegerTolerance.option, "clock-tolerance-seconds");
  const aliasAccepted = await run({ key: hs256.secret, clockToleranceSeconds: 0 }, hs256.token);
  assert.equal(aliasAccepted.result.signature, "valid");
});

test("surrounding whitespace in the input is ignored", async () => {
  const { hs256 } = await fixture("jwt-known");
  const { result } = await run({ key: hs256.secret }, `\n  ${hs256.token}\t\n`);
  assert.equal(result.signature, "valid");
});

test("input over the 64 KiB limit is rejected before any output exists", async () => {
  const oversized = "a".repeat(65537);
  const sink = new MemoryOutputSink();
  const context = new ProcessorContext(new MemoryReader().insert("input", oversized), sink, new CancellationToken(), new FixedClock(NOW), new SeededRandom(1), new MemorySecrets(), LIMITS);
  await assert.rejects(() => execute({ options: {} }, context), /exceeds/);
  assert.equal(sink.bytes.size, 0);
  assert.equal(sink.values.size, 0);
});
