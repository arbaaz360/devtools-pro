# AG-123 — QR code reader package (the other half of DU-21)

## Branch

`claude/AG-123-qr-reader` from the latest `origin/main`. Record the base SHA.

## Allowed files

```text
plugins/qr-reader/**
```

## Required reading

`ARCHITECTURE.md`, `packages/plugin-sdk/README.md`, the DU-21 card in
`docs/DEVUTILS_REQUIREMENTS.md`, the "working" rules in
`docs/WORKER_PROTOCOL.md`, the **image inputs** paragraph in
`docs/PLUGIN_HOST_IMPLEMENTATION.md`, `packages/vendor/jsqr/README.md`, and
`plugins/qr/` — the generator this reads back, whose fixtures show the shape
of a package that carries a vendored library.

## Goal

A new package `plugins/qr-reader/` with plugin id `media.qr-reader` that reads
a QR code out of an image and reports its text.

The engine hands an image port **decoded RGBA pixels**, four bytes each,
row-major from the top-left, with their width and height available from
`context.info(port)`. The processor therefore never parses PNG or JPEG, needs
no canvas, and its tests run under plain node by building pixels directly.

## Requirements

- Package files as in the reference packages; `tests.requirementIds: ["DU-21"]`.
- One tool `media.qr-reader`, title `QR Code Reader`, category `converter`,
  workspace kind `transform`, one operation `media.qr-reader`.
- Input port `input`, kind `document`, `required: true`,
  **`contentKinds: ["image"]`**, `mime: ["image/png", "image/jpeg", "image/webp"]`.
  Declaring `contentKinds: ["image"]` is what makes the shell treat the tool as
  taking bytes and the engine decode the picture; without it the port receives
  text and nothing works.
- Output port `output`, kind `value`, representations
  `["text", "properties", "annotations"]`, mime `["text/plain"]`.
- Options (kebab-case ids, camelCase aliases, structured errors for unknown
  keys and wrong types): `invert` boolean (default `false`, retry with the
  image inverted, which reads white-on-dark codes); `try-harder` boolean
  (default `true`, jsQR's `inversionAttempts: "attemptBoth"` when set,
  `"dontInvert"` when not).
- Decoding: `import jsQR from "../../packages/vendor/jsqr/jsqr.mjs"`, called as
  `jsQR(pixels, width, height, { inversionAttempts })`. Read the pixels with
  `context.read("input")` and the shape with `await context.info("input")`;
  a port whose `contentKind` is not `image`, or whose `width`/`height` are
  missing, is a structured error `qr.not-an-image`, not a crash.
- Output: the decoded text as the output bytes.
- Properties: `text`, `bytes` (the decoded payload's byte length), `version`,
  `errorCorrectionLevel` where jsQR reports it, `imageWidth`, `imageHeight`,
  and `location` — the four corner points jsQR returns, rounded to integers.
- Annotations: none. The editor shows an image, not text, so there is nothing
  to highlight; do not emit an `annotations` array.
- No code found is a structured error `qr.not-found` whose message says what
  to try (a sharper crop, better contrast, `invert`), **not** an empty success.
  A blank or single-colour image takes the same path.
- Limits: `maxInputBytes` 67108864 (16 megapixels at four bytes a pixel),
  `maxOutputBytes` 65536, `deadlineMs` 5000. Cancellation polled before and
  after the decode.
- Fixtures under `fixtures/`: at least 12 cases as
  `{ name, options, image: { width, height, scale, modules }, output | error }`
  — store the QR **modules** (a row-major array of booleans or a string of
  `0`/`1` per row) and have `test.mjs` expand them to pixels, rather than
  committing megabytes of raw pixel arrays. Cover: the DU-21 sample
  `https://example.com`, each error-correction level, a code with a quiet zone
  and one without, a scaled-up code (4 and 8 pixels per module), a code in the
  corner of a larger image, UTF-8 text with astral characters, an inverted
  code with `invert` on and off, an image with no code at all, and a
  single-colour image.
- Generate fixtures with the vendored **encoder** (`packages/vendor/qrcode-generator`)
  inside `test.mjs`, so a fixture states the code it means rather than a pixel
  dump nobody can check. Never record what this package outputs as the
  expectation: the encoder is the oracle, and the test asserts that decoding
  its output returns the text that was encoded.

## Checks

```text
node --experimental-strip-types --test plugins/qr-reader/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin media.qr-reader --help
pnpm --dir apps/desktop build
git diff --check
```

The headless script feeds text, so it cannot drive an image port: the package's
own tests are the evidence here. Say so in your status rather than inventing a
command that appears to work.

## Evidence

Test counts, fixture counts, the round-trip test's output for the DU-21 sample
(the text encoded and the text decoded), and the
`pnpm --dir apps/desktop build` summary line.

## Out of scope

Reading several codes from one image, barcodes other than QR, camera capture,
deskewing a photographed code beyond what jsQR does itself, and the shell work
that shows the located corners over the image.
