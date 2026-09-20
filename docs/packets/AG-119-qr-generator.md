# AG-119 — QR code generator package (DU-21)

## Branch

`antigravity/AG-119-qr-generator` from the latest `origin/main`. Record the
base SHA.

## Allowed files

```text
plugins/qr/**
```

`packages/vendor/qrcode-generator/` is read-only for this packet: import it,
never edit it.

## Required reading

`ARCHITECTURE.md`, `Tool Contract and Document Model.md`,
`packages/plugin-sdk/README.md`, the DU-21 card in
`docs/DEVUTILS_REQUIREMENTS.md`, `packages/vendor/qrcode-generator/README.md`,
the "working" rules in `docs/WORKER_PROTOCOL.md` (a processor uses web
platform APIs only), and two reference packages: `plugins/uuid/` for a
generator workspace and `plugins/string-case/` for option validation.

## Goal

A new package `plugins/qr/` with plugin id `media.qr` that encodes the
document text as a QR code and emits it as SVG, using the vendored
`qrcode-generator`. Reading QR codes from images is a later packet.

## Requirements

- Package files as in the reference packages; `tests.requirementIds: ["DU-21"]`.
- One tool `media.qr`, category `generator`, workspace kind `generator`, one
  operation `media.qr`. Input port `input` (document, text, `required: true`,
  `maxBytes` 2953, the QR byte-mode capacity at version 40 level L). Output
  port `output`, kind `artifact`, mime `image/svg+xml`, representations
  `["image", "code", "properties"]`.
- Options (kebab-case ids, camelCase aliases, structured errors for unknown
  keys and wrong types): `error-correction` enum `L`, `M`, `Q`, `H`
  (default `M`); `cell-size` integer 1–40 px (default `8`); `margin`
  integer 0–16 cells (default `4`, the QR quiet zone); `version` integer
  0–40 (default `0`, automatic: the smallest version that fits).
- Encoding: `import { qrcode } from "../../packages/vendor/qrcode-generator/qrcode.mjs"`;
  `qrcode(version, level)`, `addData(text, "Byte")` with the input as UTF-8
  bytes, `make()`, then `createSvgTag({ cellSize, margin, scalable: true })`.
  An input that does not fit the requested version and level, or exceeds
  the capacity at version 40, is a structured error `qr.capacity` naming the
  byte count and the capacity. Empty input is an error `qr.empty`.
- Output: the SVG text, with a leading `<?xml version="1.0" encoding="UTF-8"?>`
  line so it saves as a valid file, and `width`/`height` attributes in
  pixels (modules × cell size + 2 × margin × cell size).
- Properties: `version`, `modules` (module count per side), `errorCorrection`,
  `cellSize`, `margin`, `widthPx`, `inputBytes`, `bytes` (SVG length).
- Determinism: the same input and options produce byte-identical SVG; pin
  the SVG for every fixture. Byte mode only; the README states that numeric
  and alphanumeric modes are not used, so a digits-only input still encodes
  as bytes (larger but exact).
- Limits: `maxInputBytes` 4096, `maxOutputBytes` 4 MiB. Cancellation polled
  before and after `make()`. Source bytes immutable, asserted per test.
- Fixtures under `fixtures/`: at least 25 cases with pinned SVG: `https://example.com`,
  a 2953-byte input at level L (fits) and 2954 (rejected), each error
  level, cell sizes 1 and 40, margin 0 and 16, explicit versions 1 and 40,
  UTF-8 text with astral characters, a newline-containing input, empty
  input rejected, `version: 1` with an input too large for it rejected.

## Checks

```text
node --experimental-strip-types --test plugins/qr/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin media.qr --input "input=https://example.com"
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin media.qr --input "input=hello" --options '{"error-correction":"H","cell-size":4,"margin":2}'
pnpm --dir apps/desktop build
git diff --check
```

## Evidence

Test counts, fixture counts, both headless outputs (the SVG shortened to its
first line and byte length), the `pnpm --dir apps/desktop build` summary
line.

## Out of scope

Reading QR codes from images (needs binary input on the worker engine),
PNG output, logos or colours, the image preview pane (shell work).
