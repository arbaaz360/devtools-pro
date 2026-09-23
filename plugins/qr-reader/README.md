# QR Code Reader

The `media.qr-reader` plugin reads a QR code out of an image and reports its decoded text, using the vendored `jsQR` decoder.

The engine decodes the image container (PNG/JPEG/WebP) before handing the processor RGBA pixels — four bytes each, row-major from the top-left — plus their width and height (`context.info("input")`). The processor never parses an image container itself, which is also why its tests build pixel buffers directly and run under plain Node.

## Options

* **`invert`** (boolean): Re-invert every RGB channel of the source pixels before decoding (alpha is left alone). Use this for a code that is genuinely white-on-dark; `jsQR`'s own automatic inversion (driven by `try-harder`) is a binarization-threshold flip, not a pixel-color flip, so a truly inverted image can still need this. Default: `false`.
* **`try-harder`** (boolean): Passed to `jsQR` as `inversionAttempts: "attemptBoth"` when `true` (tries both normal and threshold-inverted binarization), or `"dontInvert"` when `false`. Default: `true`. Alias: `tryHarder`.

## Output

The plugin writes the decoded text as the output bytes (UTF-8 encoded).

Exposed properties include:
* `text`: The decoded text.
* `bytes`: The UTF-8 byte length of the decoded text.
* `version`: The QR version `jsQR` decoded (1-40).
* `imageWidth`, `imageHeight`: The dimensions of the input image in pixels.
* `location`: The four corner points `jsQR` located the code at (`topLeft`, `topRight`, `bottomLeft`, `bottomRight`), each `{ x, y }` rounded to the nearest integer pixel.

`jsQR`'s public decode result does not report the error-correction level the code was encoded with (only its internal decoder does, and that value is not returned to callers), so this package never emits an `errorCorrectionLevel` property — there is nothing correct to report. No `annotations` are emitted either: the editor shows an image, not text, so there is nothing to highlight.

## Errors

* **`qr.invalid-option`**: Emitted when an unknown option, or a wrongly-typed `invert`/`try-harder` value, is supplied.
* **`qr.not-an-image`**: Emitted when the input port's `contentKind` is not `image`, its width/height are missing, or its pixel buffer does not match `width * height * 4` bytes.
* **`qr.not-found`**: Emitted when no QR code is located in the image — including a blank or single-colour image. The message suggests a sharper crop, better contrast, or the `invert` option.

## Limits

`maxInputBytes` is 67,108,864 bytes (16 megapixels at four RGBA bytes per pixel). `maxOutputBytes` is 65,536 bytes. `deadlineMs` is 5,000. Cancellation is checked before and after the decode.

## Fixtures

`fixtures/*.json` fix the shape `{ name, options, image: { width, height, scale, modules }, output | error }`: `modules` is a row-major array of `"0"`/`"1"` strings (one character per QR module, `"1"` meaning a dark module), which `test.mjs` expands into an RGBA pixel buffer at `scale` pixels per module. The real fixtures' `modules` matrices were produced by the vendored `qrcode-generator` — the same `encodeModules` helper defined in `test.mjs` — encoding each fixture's known text (rather than by hand-editing a pixel dump), so every fixture states the code it means. Because the vendored encoder's byte-mode path truncates each UTF-16 code unit to its low byte instead of emitting real UTF-8 (see `packages/vendor/qrcode-generator/qrcode.mjs:737-742`), `encodeModules` first converts the fixture's text to UTF-8 bytes itself and hands the encoder a same-length "byte string" (one character per byte, `String.fromCharCode`), so the encoder's per-character truncation is a no-op and the emitted module data carries the correct UTF-8 bytes; `jsQR`'s own byte-mode decoder reassembles that back into the original Unicode text. `test.mjs` also runs a live round trip for the DU-21 sample (`https://example.com`) that calls the encoder itself rather than reading a fixture file, so the encode step is visible at test time, not just at fixture authoring time.
