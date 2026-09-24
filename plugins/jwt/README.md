# JWT Decoder & Verifier

`security.jwt` decodes a JSON Web Token (JWS compact serialization, RFC 7515)
into its header, payload and signature, then verifies the signature offline
against a caller-supplied key for the HS, RS, PS and ES families. Claim
validity (`exp`, `nbf`) is reported separately from signature validity, using
a clock injected through `context.clock.now()` so results are testable. The
processor uses only the public plugin SDK and web platform APIs
(`crypto.subtle`, `atob`, `TextEncoder`/`TextDecoder`): no `node:` imports.

## Decoding

The `input` document is one token; surrounding whitespace is ignored. It must
split into exactly three `.`-separated segments (header, payload, signature).
Anything else throws a structured `JwtError`:

| `code` | When |
|---|---|
| `structure` | Not exactly three dot-separated segments. `segments` names the count found. |
| `segment-base64` | A segment is not valid base64url (optional padding is accepted). `segment` names which one. |
| `segment-json` | The header or payload segment, once decoded, is not valid JSON or is not a JSON object (array, string, number, `null`). `segment` names which one. |
| `segment-signature` | The signature segment is empty while `alg` is not `"none"` — only `alg: "none"` may omit a signature. |

Decoding never calls WebCrypto and always succeeds once these checks pass,
regardless of whether `alg` is supported or a key was supplied.

## Verification

Verification runs only when decoding succeeds, and is independent of it:

| `signature` | When |
|---|---|
| `"none"` | `alg` is `"none"`. Never verified, even if a signature segment or a key is present. |
| `"unsupported"` | `alg` is anything other than `HS256/384/512`, `RS256/384/512`, `PS256/384/512`, `ES256/384/512` or `"none"`. The literal value is still reported in `algorithm`; this is not a thrown error. |
| `"not-checked"` | The `key` option is `""` (the default): decode only, do not verify. |
| `"valid"` / `"invalid"` | The key was imported for the algorithm family and `crypto.subtle.verify` returned true or false. |

A key that does **not import** for the required algorithm family — the wrong
shape (not PEM for RS/PS/ES), a key of the wrong type (an EC key given for an
RSA algorithm), or an EC key on the wrong curve — is a structured error
`key-import` naming the `family`, never a silent `"invalid"`. A key that
*does* import but does not match the signature reports `"invalid"`, not an
error.

- **HS256/384/512**: HMAC over the secret bytes from `key`, decoded per
  `secret-encoding` (`utf8` default, `base64`, `base64url`). HMAC import never
  rejects any byte string, so `key-import` cannot occur for HS*.
- **RS256/384/512**: RSASSA-PKCS1-v1_5. `key` must be a PEM SPKI public key
  (`-----BEGIN PUBLIC KEY-----`).
- **PS256/384/512**: RSA-PSS with salt length equal to the hash length in
  bytes (32/48/64). Same PEM SPKI key shape as RS*.
- **ES256/384/512**: ECDSA over P-256/P-384/P-521 with the JOSE raw `r‖s`
  signature (WebCrypto's native ECDSA signature format already matches JOSE,
  so no DER conversion is needed). PEM SPKI key; the curve is validated
  against the key by WebCrypto's own import.

A failure to decode the secret (`secret-encoding: base64`/`base64url` on text
that is not valid base64) is `key-encoding`, naming the `encoding`, never the
key text. The `key` option value is never included in any output, error
message, or diagnostic field, under any code path — this is asserted directly
in the test suite, not just documented.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `key` | string, `sensitive: true` | `""` | The HMAC secret for HS*, or a PEM SPKI public key for RS*/PS*/ES*. Empty means decode only. |
| `secret-encoding` | enum `utf8`, `base64`, `base64url` | `utf8` | How `key` is read for HS*. `secretEncoding` is accepted as a camelCase alias. |
| `clock-tolerance-seconds` | integer ≥ 0 | `0` | Applied to both `exp` and `nbf` when computing `expired`/`notYetValid`. `clockToleranceSeconds` is accepted as an alias. |

Unknown option keys and options of the wrong type are structured
`invalid-option` errors naming the option.

## Result value

`header` and `payload` (the decoded JSON objects), `algorithm` (the literal
`header.alg` value, whatever its type), `signature` (see above), `valid`
(`signature === "valid"` and neither `expired` nor `notYetValid`), and:

```text
claims: {
  expired: boolean,      // exp is a number and now >= exp + tolerance (expired from the exp instant itself)
  notYetValid: boolean,  // nbf is a number and now < nbf - tolerance (valid from the nbf instant itself)
  expiresAt: string | null,  // ISO UTC, or null when exp is absent/non-numeric
  notBefore: string | null,
  issuedAt: string | null,   // from iat, informational only (not compared to now)
}
```

`now` comes from `context.clock.now()`, not the host clock, so expiry is
testable with a fixed clock. The comparison uses the clock's full precision
(fractional seconds are never floored toward validity), and `exp`/`nbf` may
themselves be fractional NumericDate values, honoured exactly. A claim that
is present but not a JSON number is treated as absent (`expired`/
`notYetValid` default to `false`, the ISO field to `null`) rather than
throwing, since RFC 7519 defines these as NumericDate.

## Text representation

The header JSON (`JSON.stringify(header, null, 2)`), a blank line, the
payload JSON, a blank line, then `signature: <status>`, `expired: <bool>`,
`notYetValid: <bool>`, and one `<claim>: <value>` line per present claim among
`expiresAt`/`notBefore`/`issuedAt` (omitted, not printed as `null`, when
absent). Every non-blank line is indented two spaces so the whole block —
header, payload, or status — can be copied as one unit.

## Limits

`maxInputBytes` 64 KiB, `maxOutputBytes` 1 MiB (enforced by the SDK context;
the token and its JSON segments are always far smaller). Cancellation is
polled at the start of `execute`, once per input chunk, and immediately
before and after the `crypto.subtle.verify` call, so a cancellation raised
during verification is never silently absorbed.

## Fixtures

`fixtures/jwt-known.json` holds two externally-checkable vectors:

- `hs256`: the canonical `jwt.io` HS256 example (also used in this package's
  headless proof commands), with its well-known secret `your-256-bit-secret`.
- `rs256`: a **self-generated** RS256 token and its SPKI PEM public key
  (`crypto.subtle.generateKey`, RSASSA-PKCS1-v1_5, 2048-bit), used the same
  way the packet asked for a static RFC 7515 Appendix A.2 vector. This
  environment had no network access to confirm the literal RFC constants
  byte-for-byte, and an incorrect hand-transcribed RSA modulus would fail
  silently plausible-looking rather than obviously wrong, so a self-generated,
  self-verified vector was committed instead. See Limitations below.

`fixtures/jwt-malformed.json` holds the structural/segment error vectors
(wrong segment count, invalid base64url per segment, non-object header,
non-JSON payload, empty signature with `alg` not `none`).

Every other vector — every HS/RS/PS/ES algorithm signed and verified, wrong
keys of the same shape, wrong key types, wrong EC curves, `alg: "none"`,
unsupported `alg`, expired/not-yet-valid claims, cancellation — is
constructed by `test.mjs` itself with `crypto.subtle` (`generateKey` for RSA
and EC) and is not committed to disk, per the packet.

## Limitations

- The `rs256` static fixture is self-generated, not the literal RFC 7515
  Appendix A.2 example, because this sandbox has no outbound network access
  to the RFC text and a memorized long base64url RSA modulus is exactly the
  kind of constant that is easy to get subtly wrong without a way to check
  it. The self-generated vector is verified the same way (a real
  `crypto.subtle.verify` against a real PEM key) and exercises the same code
  path.
- Signing tokens, private keys, JWK input, `x5c` chains, nested JWE, network
  calls, and the segmented-token/editable-workspace UI are out of scope per
  the packet and are not implemented here.
