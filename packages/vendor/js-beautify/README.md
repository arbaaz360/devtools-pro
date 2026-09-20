# Vendored: js-beautify

| | |
|---|---|
| Upstream | https://github.com/beautifier/js-beautify |
| Version | 2.0.3 (npm tarball integrity `sha512-cyFbh3tkPhknnTD/0bLf0T0yy2ZIbqL05mttzbt4y1Zfr7NxqXQZ62dkBLKs3oHH/lpjmDRAnciJiSUyOy8XwQ==`) |
| File | `js/lib/beautify.js` from that tarball, sha256 `e6faadb6576a35467538daee02f028152808b5b4d82f80aca57e6bfeb4ba11c7` |
| Licence | MIT, `LICENSE` beside this file |
| Used by | `plugins/js` (DU-15, packet AG-115) |

`js-beautify.mjs` is the upstream UMD file made importable as an ES module:
four header comment lines and `const exports = {};` are prepended, and
`export const js_beautify = exports.js_beautify; export default js_beautify;`
appended. Nothing inside the upstream text is changed, so the upstream sha256
can be re-checked by stripping those lines. It reformats JavaScript text and
never evaluates it, uses no Node or browser APIs, and runs in the desktop
webview's worker engine as well as under Node.

Vendored rather than installed so that no package under `plugins/` gains an
npm dependency, the worker bundle is built from a reviewed file, and updates
are deliberate commits: to update, download the new tarball, replace the
file body, record the new version and hashes here, and run `plugins/js` tests.
