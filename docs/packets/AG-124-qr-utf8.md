# AG-124 — The QR generator must encode UTF-8 (DU-21)

## Branch

`claude/AG-124-qr-utf8` from the latest `origin/main`. Record the base SHA.

## Allowed files

```text
plugins/qr/**
```

## Required reading

The DU-21 card in `docs/DEVUTILS_REQUIREMENTS.md`, `docs/parity/DU-21.md`
(the audit that found this), `packages/vendor/qrcode-generator/README.md`,
`packages/vendor/jsqr/README.md`, `plugins/qr-reader/test.mjs` — which shows
how to decode in a test — and `docs/WORKER_PROTOCOL.md`.

## Goal

`media.qr` produces a code that, when scanned, gives back the text that was
encoded. Today it does that only for ASCII.

Confirmed with the two vendored libraries, encoding exactly as `plugins/qr`
does and decoding with `jsQR`:

```text
"https://example.com"   ->  "https://example.com"   round trip: true
"café"                  ->  ""                      round trip: false
"日本語のテキスト"        ->  ""                      round trip: false
```

Any non-ASCII character produces a code that scans as nothing. The cause is
the vendored encoder's default byte conversion, which is not UTF-8; the
package passes a JavaScript string to `addData(text, "Byte")` and takes what
it gets. The card says byte mode over UTF-8, and the package README claims it.

## Requirements

- Encode the input as UTF-8 bytes and give the encoder those bytes, rather
  than relying on its default string conversion. `qrcode-generator` exposes
  `qrcode.stringToBytes`; setting it to a `TextEncoder`-based function before
  `addData` is the smallest correct change. Whatever route you take, the
  encoder must receive the same bytes `new TextEncoder().encode(text)` gives.
- The capacity check must count **UTF-8 bytes**, not characters: `é` is two
  bytes and `日` is three, so the existing `qr.capacity` boundary cases move.
  A 2,953-byte input at level L still fits; 2,954 still does not.
- `inputBytes` in the properties is the UTF-8 byte length.
- No change to the SVG shape, the options, the error codes or the limits.

## Checks

```text
node --experimental-strip-types --test plugins/qr/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin media.qr --input "input=café"
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin media.qr --input "input=https://example.com"
pnpm --dir apps/desktop build
git diff --check
```

## How this is proved, and how it is not

Every existing fixture pins the SVG this generator produced. That is why the
package is green while the output is wrong: a golden recorded through the
thing under test proves it is stable, not that it is right. **Re-recording
the SVGs would hide this bug again.**

So the package gains a test that decodes:

- Import `jsQR` from `packages/vendor/jsqr/jsqr.mjs`, render the generated
  code's modules to RGBA pixels the way `plugins/qr-reader/test.mjs` does,
  decode, and assert the decoded text **equals the input**.
- Cover at least: `https://example.com`, `café`, `日本語のテキスト`, an emoji
  with a zero-width joiner, a string mixing scripts, and one 2,953-byte
  input at level L.
- Keep the existing SVG fixtures, and re-pin only those whose bytes actually
  change because the encoded payload changed. Say in your status which
  fixtures moved and why.

## Evidence

The three round-trip lines above, re-run after the fix, showing each input
decoding back to itself; test counts; which SVG fixtures were re-pinned;
the `pnpm --dir apps/desktop build` summary line.

## Out of scope

Numeric and alphanumeric modes (the README states byte mode only, and that
stays true), ECI headers, the reader package, and the shell.
