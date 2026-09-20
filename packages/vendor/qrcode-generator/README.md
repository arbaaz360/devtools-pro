# Vendored: qrcode-generator

| | |
|---|---|
| Upstream | https://github.com/kazuhikoarase/qrcode-generator |
| Version | 2.0.4 (npm tarball integrity `sha512-mZSiP6RnbHl4xL2Ap5HfkjLnmxfKcPWpWe/c+5XxCuetEenqmNFf1FH/ftXPCtFG5/TDobjsjz6sSNL0Sr8Z9g==`) |
| File | `dist/qrcode.mjs`, sha256 `ea91d7118a5395289170da848b7c6758b996163bfbccf312591ab65a4911b7c0` |
| Licence | MIT, `LICENSE` beside this file |
| Used by | `plugins/qr` (DU-21, packet AG-119) |

`qrcode.mjs` is the upstream ES module with two header comment lines added;
nothing else changed. It encodes text into QR modules and renders SVG text;
no DOM, no Node APIs. Update as described in `../js-beautify/README.md`.
