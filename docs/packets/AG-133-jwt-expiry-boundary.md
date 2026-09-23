# AG-133 — A JWT is expired at its exp instant (DU-04)

## Branch

`claude/AG-133-jwt-expiry-boundary` from the latest `origin/main`. Record the base SHA.

## Allowed files

```text
plugins/jwt/**
```

## Required reading

The DU-04 card in `docs/DEVUTILS_REQUIREMENTS.md`; `docs/parity/DU-04.md`;
`plugins/jwt/README.md`; RFC 7519 §4.1.4 (`exp`) and §4.1.5 (`nbf`); and
`docs/WORKER_PROTOCOL.md`, including "Where an expected value comes from".

## Goal

An independent review (finding AST-018, reproduced by the integrator) found that a
token is reported valid at the exact second it expires:

```text
exp = 1790164800   clock = 2026-09-23T12:00:00Z (= 1790164800)   tolerance 0
got:  signature valid, expired false, valid true
RFC 7519 §4.1.4: the current time MUST be before exp -> at equality it is expired
```

The comparison is `nowSeconds > exp`, and flooring the clock to whole seconds extends
validity through the whole expiry second. The review traced it to
`plugins/jwt/processor.mjs` near line 170 (at `5866a49`).

## Requirements

- **`exp`**: valid only while `now < exp + tolerance`. With tolerance 0 the token
  is expired from the instant `now == exp`.
- **`nbf`**: not yet valid while `now < nbf - tolerance`; valid from `now == nbf`.
- Compare using the clock's full precision. Do not floor `now` in the direction
  that extends validity.
- NumericDate values may be fractional (`exp: 1790164800.5`); honour them exactly.
- The result says which claim failed and by how much, as it does today.

## Checks

```text
node --experimental-strip-types --test plugins/jwt/test.mjs
node scripts/test-plugins.mjs
pnpm --dir apps/desktop build
git diff --check
```

## Evidence

**The oracle is RFC 7519's text, applied to tokens the test signs itself** with
`node:crypto` (HMAC-SHA256 over `base64url(header) + "." + base64url(payload)`, a key
used only by the test). The expected verdict for each case is written by hand from
§4.1.4 and §4.1.5, not recorded from the processor.

Cover, with a fixed clock: `exp` one second before, at, and one second after now;
the same with a fractional `exp`; `nbf` one second before, at, and after now; and
each with a tolerance of 30 seconds. Quote the table in your status.

## Out of scope

Signing (a known DU-04 gap), other algorithms' key handling, the shell.
