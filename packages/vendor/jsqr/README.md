# Vendored: jsQR

| | |
|---|---|
| Upstream | https://github.com/cozmo/jsQR |
| Version | 1.4.0 (`npm pack jsqr`) |
| File | `dist/jsQR.js`, sha256 `bc40c8a15196236b2314db0856f72ca0b49980cd5413b8c852a7349f5fee0859` |
| Licence | **Apache-2.0**, `LICENSE` beside this file |
| Used by | `plugins/qr-reader` (packet AG-123) |

`jsqr.mjs` is the upstream UMD bundle with six header lines prepended and two
export lines appended; nothing else changed. The UMD header looks for `module`
and `exports`, so declaring both as consts makes it take its CommonJS branch and
assign the decoder to `module.exports`, which the file then exports.

**This is the first Apache-2.0 component in the repository** — the other three
vendored libraries are MIT. Apache-2.0 is permissive and compatible with
distributing this project, and it asks for the licence text (kept here) and for
modifications to be stated (they are, above). It also grants patent rights and
terminates that grant for anyone who brings a patent claim about the code, which
MIT says nothing about either way.

## What it does, and what it needs

`jsQR(pixels, width, height)` takes **RGBA pixels**, four bytes each, row-major
from the top-left — not a PNG or a JPEG. It locates and decodes a QR code and
returns `{ data, binaryData, location, version, ... }`, or `null` when it finds
none. Nothing in it touches the DOM, so it runs in a worker and under node.

That is why the engine decodes an image input to pixels before handing it to a
processor (see PLUGIN_HOST_IMPLEMENTATION.md): the container format is the
host's problem, and a package keeps tests that run under plain node.

A round trip against the encoder vendored beside it — `qrcode-generator` makes
the modules, this decodes the pixels — returns the original text, which is the
cheapest proof that both are intact.
