# Vendored: marked

| | |
|---|---|
| Upstream | https://github.com/markedjs/marked |
| Version | 18.0.13 (npm tarball integrity `sha512-xTxVzZsBFwunP6HDmtBkabUQEYArnP7/rMDGmPj9SlrKlQ4i8MdYVow+nJL0eOqwpUqhzBoTBRADGN6uYwPyOw==`) |
| File | `lib/marked.esm.js`, sha256 `2e70fea3ee49f98ab67ee395e5af51cc6bee4fafed15910da9ccb7f650df8014` |
| Licence | MIT, `LICENSE` beside this file |
| Used by | `plugins/preview` (DU-25, packet AG-117) |

`marked.mjs` is the upstream ES module with two header comment lines added
and the trailing `sourceMappingURL` line removed; nothing else changed. It
parses Markdown to HTML text and never evaluates anything; it uses no Node or
browser APIs. It does not sanitise: the shell renders its output only inside a
sandboxed frame with scripts disabled. Update as described in
`../js-beautify/README.md`.
