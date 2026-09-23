# AG-129 — HTML/SVG to JSX must keep text, attribute values and style declarations (DU-24)

## Branch

`claude/AG-129-jsx-meaning` from the latest `origin/main`. Record the base SHA.

## Allowed files

```text
plugins/jsx/**
```

## Required reading

"Owner decisions → Transforms preserve meaning" in `docs/DEVUTILS_REQUIREMENTS.md`;
the DU-24 card there; `docs/parity/DU-24.md`; `plugins/jsx/README.md`; and
`docs/WORKER_PROTOCOL.md`, including "Where an expected value comes from".

## Goal

An independent review (findings AST-014, AST-015 and AST-016, reproduced by the
integrator) found three ways the converter changes content while reporting
success with no diagnostics:

```text
1. Text beside an inline element loses its spaces
   <p>Hello <b>world</b> !</p>
   emits  <p>\n  Hello \n  <b>\n    world\n  </b>\n   !\n</p>
   JSX drops whitespace at line boundaries, so this renders "Helloworld!"

2. An unquoted attribute value stops at "/"
   <img src=https://example.com/a.png>
   emits  <img src="https:" example.com="true" a.png="true" />      (TS1003, TS1382)

3. Style declarations
   style="--brand-color: red; color: var(--brand-color)"
   emits  { BrandColor: "red", color: "var(--brand-color)" }        (the variable is renamed away)
   style="background-image: url(data:image/png;base64,YQ==)"
   is split at the ";" inside url(...)
```

The review traced these to `plugins/jsx/processor.mjs` near lines 454 and 464
(text emission), 255 (unquoted attribute values) and 373–391 (style parsing), at
`5866a49`.

## Requirements

- **The rendered text of the JSX equals the text of the HTML.** Wherever the
  emitter breaks a line inside text, it keeps each significant space explicitly
  (`{" "}`), or keeps the inline run on one line. Text-only and element-only
  content may be laid out freely.
- **Unquoted attribute values end only at ASCII whitespace or `>`**, as in the
  HTML specification's unquoted attribute value state. `/` belongs to the value:
  `<br class=a/>` has the value `a/`.
- **Style objects keep what they were given.** A custom property (`--anything`)
  keeps its name verbatim as a quoted key. Declarations split on `;` only outside
  parentheses and quotes. Values pass through unchanged.
- An input the converter cannot represent faithfully gets a diagnostic, never a
  silently changed result.

## Checks

```text
node --experimental-strip-types --test plugins/jsx/test.mjs
node scripts/test-plugins.mjs
pnpm --dir apps/desktop install --frozen-lockfile
pnpm --dir apps/desktop build
git diff --check
```

## Evidence

**The oracle is the TypeScript compiler, not this package.** The repository pins
TypeScript 7 in `apps/desktop`, which has no JavaScript API — `require("typescript")`
exposes only a version. Use its command-line compiler, as the review did:

```js
// resolve from apps/desktop, which CI installs before the gate runs
const tsc = join(dirname(createRequire(desktopPackageJson).resolve("typescript/package.json")), "bin/tsc");
spawnSync(process.execPath, [tsc, "--ignoreConfig", "--jsx", "react", "--target", "ES2020", file])
```

If TypeScript is not installed, the test **fails** with that message; it does not
skip. Compile once per test run, with every corpus case in one or a few files, not
one process per case.

For every corpus case:

1. The emitted JSX compiles with no diagnostics.
2. Evaluate the compiled JavaScript with a minimal `React.createElement` that
   returns the concatenated string children. The rendered text equals the HTML's
   text, **written by hand in the fixture** from the HTML (`Hello world !` for case
   1), never produced by the converter.
3. Attribute values and style objects equal hand-written expectations: `src` is
   `https://example.com/a.png`; the style object is
   `{ "--brand-color": "red", color: "var(--brand-color)" }`.

The corpus holds the reproductions plus inline elements at the start and end of
text, nested inline elements, `&nbsp;`, text with several spaces, `<pre>`, unquoted
values containing `/`, `=` and `?`, a data URL in a style, a style with a quoted
`;`, and SVG presentation attributes. Quote the table in your status.

## Out of scope

Formatting preferences, SVG attribute mapping beyond these cases, component
extraction, the shell.
