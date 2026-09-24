# Vendored: acorn

| | |
|---|---|
| Upstream | https://github.com/acornjs/acorn |
| Version | 8.18.0 (npm tarball integrity `sha512-lGq+9yr1/GuAWaVYIHRjvvySG5/4VfKIvC8EWxStPdcDh/Ka7FG3twP6v4d5BkravUilhIAsG4Qj83t02LWUPQ==`) |
| File | `dist/acorn.mjs` from that tarball, byte for byte; sha256 `953573b8fdab71599749ea5f2b33d3e760c2116178f9423ee7458dbe39d59453` |
| Licence | MIT, `LICENSE` beside this file |
| Used by | `plugins/js` (DU-15): both operations read the program with it and check their output parses to the same syntax tree |

Owner decision, 2026-09-25 (`docs/DEVUTILS_REQUIREMENTS.md`, § Owner decisions): the
JavaScript tool reads code with a real parser. The upstream ES module is used unchanged,
so the sha256 above re-checks the file directly. It has no dependencies, uses no Node
or browser APIs, never evaluates what it parses, and runs in the desktop webview's
worker engine as well as under Node.

Vendored rather than installed, like `js-beautify`, so that no package under `plugins/`
gains an npm dependency and the worker bundle is built from a reviewed file. To update:
`npm pack acorn@<version>`, copy `package/dist/acorn.mjs` and `package/LICENSE` here,
and update the version, integrity and sha256 above.
