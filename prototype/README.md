# Workbench UI scaffold

This is a dependency-free, static prototype for the first vertical slice: the structured-data inspector and formatter. It communicates the shell, document tabs, smart detection, split input/output canvas, text/table views, diagnostics, offline status, and command palette.

Open `index.html` directly in a browser. The **Format**, **Minify**, **Copy output**, `Ctrl/Cmd-K`, and output **Table** controls are functional. The UI-independent execution boundary is documented in [Tool Contract and Document Model.md](../Tool%20Contract%20and%20Document%20Model.md). The prototype intentionally keeps parsing in the browser so the interaction contract can be reviewed before selecting the production shell and domain core.
