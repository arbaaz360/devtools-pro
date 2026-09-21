# QR Code Generator

The `media.qr` plugin generates a QR code (SVG format) from the input text, using the vendored `qrcode-generator` module.

Note that only byte mode is used for encoding, so numeric and alphanumeric inputs still encode as bytes (this produces a larger but exact representation).

## Options

* **`error-correction`** (enum): The error correction level. Allowed values: `L`, `M`, `Q`, `H`. Default: `M`. Aliases: `errorCorrection`.
* **`cell-size`** (integer): The size of each QR code module in pixels. Allowed values: 1–40. Default: `8`. Aliases: `cellSize`.
* **`margin`** (integer): The size of the quiet zone around the QR code in modules. Allowed values: 0–16. Default: `4`.
* **`version`** (integer): The QR code version (size). Allowed values: 0–40. Default: `0` (automatic minimum version to fit the data).

## Output

The plugin produces an `image/svg+xml` artifact that encodes the QR code matrix into an SVG image. The SVG document includes an XML declaration and specific width and height pixel boundaries corresponding to `modules × cell-size + 2 × margin × cell-size`.

Exposed properties include:
* `version`: The actual version used to encode the QR code.
* `modules`: The number of modules (cells) per side.
* `errorCorrection`: The actual error correction level used.
* `cellSize`: The configured cell size.
* `margin`: The configured margin.
* `widthPx`: The computed width and height of the SVG image in pixels.
* `inputBytes`: The number of UTF-8 encoded bytes in the input text.
* `bytes`: The number of bytes of the output SVG string.

## Errors

* **`qr.empty`**: Emitted when the input text is empty or blank.
* **`qr.capacity`**: Emitted when the input exceeds the byte capacity of the chosen version and error correction level, or when it exceeds the absolute maximum capacity (2953 bytes) of the highest version (`40` level `L`).
* **`qr.invalid-option`**: Emitted when an unknown or wrongly-typed option is supplied.
