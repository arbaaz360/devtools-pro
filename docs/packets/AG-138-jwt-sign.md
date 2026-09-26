# AG-138 — JWT signing (DU-04)

## Branch

`antigravity/AG-138-jwt-sign` from the latest `origin/main`. Record the base SHA.

## Allowed files

```text
plugins/jwt/**
```

## Required reading

The DU-04 card in `docs/DEVUTILS_REQUIREMENTS.md` ("signing and verification
offline"); `docs/parity/DU-04.md`; `plugins/jwt/README.md` and `processor.mjs` (the
verify path already imports keys through WebCrypto); `plugins/uuid/manifest.json`,
which shows a package with two operations; RFC 7515 Appendix A and RFC 7518 §3; and
`docs/WORKER_PROTOCOL.md`, including "Where an expected value comes from".

## Goal

The JWT tool decodes and verifies but cannot sign, and that is the largest DU-04 gap.
Add a second operation that signs a payload into a compact JWS.

## Requirements

- **A new operation `security.jwt.sign`** alongside `security.jwt`, with the same input
  port and output shape (representations `["text", "properties"]`). The existing
  operation's behaviour does not change.
- **The payload** is the editor text:
  - it must parse as a JSON object, else `jwt.payload-not-object`;
  - its **exact bytes** are what is signed, never a re-serialisation.
- **Options for `security.jwt.sign`:** kebab-case, camelCase aliases, structured errors.
  - `alg`: HS256/384/512, RS256/384/512, PS256/384/512, ES256/384/512. Default
    `HS256`. No `none`, ever.
  - `key`: `sensitive: true`, reusing the existing option's shape. An HMAC secret, or
    a PKCS#8 PEM private key (`-----BEGIN PRIVATE KEY-----`).
  - `secret-encoding`: reuse the existing option, for HMAC only.
  - `header`: optional text. When empty, the header is `{"alg":"<alg>","typ":"JWT"}`.
    When given, it must be a JSON object whose `alg` equals the chosen `alg`, else
    `jwt.header-alg-mismatch`, and its **exact bytes** are used.
- **Crypto, WebCrypto only:**
  - HMAC: `importKey("raw", …)`.
  - The rest: `importKey("pkcs8", …)` with RSASSA-PKCS1-v1_5 for RS\*, and RSA-PSS for
    PS\* with `saltLength` equal to the hash length in bytes (RFC 7518 §3.5).
  - ECDSA: the curve must match the alg (P-256 for ES256, P-384 for ES384, P-521 for
    ES512; RFC 7518 §3.4). WebCrypto's ECDSA signature is already `r‖s`, which JWS
    requires. Do not DER-encode it.
- **Refused**, as structured errors:
  - a key of the wrong type or curve for the alg (`jwt.key-mismatch`);
  - an HMAC key shorter than the hash output (`jwt.key-too-short`; RFC 7518 §3.2 says
    such a key MUST NOT be used);
  - a PEM that is not PKCS#8, e.g. `BEGIN RSA PRIVATE KEY` (`jwt.key-format`). The
    message says how to convert it (`openssl pkcs8 -topk8 -nocrypt`).
- **The key never appears** in the output, the properties or an error message.
- **Properties:** `alg`, `headerBytes`, `payloadBytes`, `signatureBytes`, `keyType`.
- **Round trip:** the tool's own verify operation accepts every token it signs, given
  the matching public key.
- `README.md`: the sign operation, its options, the refusals, and the PKCS#8 note.

## Checks

```text
node --experimental-strip-types --test plugins/jwt/test.mjs
node scripts/test-plugins.mjs
pnpm --dir apps/desktop build
git diff --check
```

## Evidence

**Two oracles, neither of them this package.**

1. **RFC 7515 Appendix A, reproduced exactly.**
   - **A.1 (HS256)** is deterministic. With the RFC's header bytes (they contain
     CRLF and spaces), payload bytes and JWK `k`, the token must be, character for
     character:

     ```text
     eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
     ```

     The integrator recomputed this with `node:crypto`. Pass the RFC's header
     through the `header` option and the key as `secret-encoding: base64url`.
   - **A.2 (RS256)** is also deterministic (PKCS#1 v1.5). Take the RFC's RSA JWK and
     convert it to PKCS#8 PEM in the test with
     `crypto.createPrivateKey({ key: jwk, format: "jwk" }).export({ type: "pkcs8", format: "pem" })`.
     The token must equal the one printed in A.2.1.
2. **`node:crypto` verifies what the tool signs** in every other case, since those
   signatures are randomized:
   - ES256 with A.3's key, and ES512 with A.4's key, verified with
     `crypto.verify(hash, input, { key, dsaEncoding: "ieee-p1363" }, sig)`;
   - PS256/384/512 and RS384/512 with keys from `generateKeyPairSync`, verified with
     `crypto.verify` (PSS: `padding: RSA_PKCS1_PSS_PADDING`, `saltLength` = hash
     bytes).

   Also cover the tool's own verify accepting each token, and each refusal.

Quote the A.1 and A.2 tokens your test produced, and the list of algs verified by
`node:crypto`, in your status.

## Out of scope

JWE (encryption), JWK or JWKS input, `alg: none`, key generation in the tool, editing
a decoded token and re-signing it in one step, and the shell.
