# AG-115 — JavaScript beautifier and minifier package (DU-15)

## Branch

`antigravity/AG-115-js-formatter` from the latest `origin/main`. Record the
base SHA.

## Allowed files

```text
plugins/js/**
```

`packages/vendor/js-beautify/` is read-only for this packet: import it, never
edit it.

## Required reading

`ARCHITECTURE.md`, `Tool Contract and Document Model.md`,
`packages/plugin-sdk/README.md`, the DU-15 card in
`docs/DEVUTILS_REQUIREMENTS.md`, `packages/vendor/js-beautify/README.md`,
the "working" rules in `docs/WORKER_PROTOCOL.md` (a processor uses web
platform APIs only), and two reference packages: `plugins/json/` for a
streaming formatter with diagnostics and `plugins/string-case/` for option
validation.

## Goal

A new package `plugins/js/` with plugin id `format.js` that beautifies
JavaScript with the vendored `js-beautify` and minifies it by removing
comments and collapsing whitespace with a tokenizer that never touches
strings, template literals or regular-expression literals. The README states
plainly that minify is whitespace-and-comment removal, not a compressing
minifier.

## Requirements

- Package files as in the reference packages; `tests.requirementIds: ["DU-15"]`.
- One tool `format.js`, category `converter`, two operations `beautify` and
  `minify`. Input port `input` (document, text); output port `output`, kind
  `artifact`, representations `["code", "properties", "annotations"]`, mime
  `text/javascript`.
- Beautify options mapped onto `js_beautify` and nothing else: `indent` enum
  `2`, `4`, `tab` (default `2`) → `indent_size`/`indent_with_tabs`;
  `brace-style` enum `collapse`, `expand`, `end-expand` (default `collapse`);
  `preserve-newlines` boolean (default `true`) with `max-preserve-newlines`
  integer 0–10 (default `2`); `space-in-parens` boolean (default `false`);
  `end-with-newline` boolean (default `true`). Kebab-case ids, camelCase
  aliases, structured errors for unknown keys and wrong types. `minify`
  accepts only `preserve-comments` enum `none`, `license` (default `license`:
  keep comments starting with `/*!` or containing `@license` or `@preserve`).
- Beautify: `import { js_beautify } from "../../packages/vendor/js-beautify/js-beautify.mjs"`,
  called once on the whole input. js-beautify is tolerant by design;
  incomplete input formats as far as it can and never throws for syntax
  reasons. If it does throw, the error is a structured `format.js-beautify`
  error with the message, nothing written.
- Minify tokenizer, stated in the README with its one documented
  limitation: line and block comments; single- and double-quoted strings
  with escapes; template literals including nested `${ }` expressions to any
  depth; regular-expression literals, recognised when `/` follows the start
  of input, an operator, `(`, `,`, `[`, `{`, `;`, `:`, `!`, `?`, `=`, or one
  of the keywords `return typeof instanceof in of new delete void throw case
  do else`, with character classes `[...]` and escapes inside; everything
  else is code. Output: comments removed per the option, every run of
  whitespace outside strings, templates, regexes and kept comments collapsed
  to one space, and that space dropped when the neighbouring characters can
  never form one token together (punctuation on either side), kept when they
  could (`return x`, `a in b`, `x ++ y` is kept as-is with the space since
  `x++y` is a different program). Newlines are kept only where automatic
  semicolon insertion could otherwise change the program: after a line that
  ends with `return`, `break`, `continue`, `throw`, `++`, `--`, `)`, `]`,
  `}`, an identifier, a number, a string or a template literal when the next
  line starts with `(`, `[`, `` ` ``, `+`, `-`, `/`, or an identifier. The
  README documents this rule and its limitation: minify does not parse, so
  the semicolon rule is conservative and may keep newlines it did not need
  to.
- Diagnostics: an unterminated string, template or regex literal, or an
  unterminated block comment, yields a `severity: "warning"` diagnostic with
  byte offset, line and column, and formatting continues by treating the
  literal as running to end of input. Only an empty document is an error.
- Properties: `lines`, `comments`, `strings`, `templates`, `regexes`,
  `diagnostics` (count), `bytes`.
- Round-trip: minify(beautify(x)) then beautify again equals beautify(x) for
  every fixture without diagnostics; test it. And beautify → minify must keep
  every string, template and regex literal byte-for-byte: test by extracting
  them from input and output with the same tokenizer and comparing lists.
- Limits: `maxInputBytes` 8 MiB, `maxOutputBytes` 16 MiB. Beautify reads
  the whole input (js-beautify needs it); minify reads with `readChunks`
  and polls cancellation every 4096 tokens. Source bytes immutable, asserted
  per test.
- Fixtures under `fixtures/`: at least 30 `beautify` cases (the DU-15
  screenshot sample; ES2020 syntax: classes, arrow functions, async/await,
  optional chaining, destructuring, template literals, generators; each
  option value; incomplete input) whose expected output is what
  js-beautify produces, recorded once and pinned; at least 30 `minify`
  cases covering every tokenizer rule above, including `a = b / c / d`
  versus `a = /b/g`, `x = y\n++z`, `return\nvalue`, nested templates
  `` `a${`b${c}`}` ``, a regex containing `//` in a character class, a
  string containing `/*`, a `/*!` license comment through both option
  values, and each diagnostic case.

## Checks

```text
node --experimental-strip-types --test plugins/js/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin format.js --operation beautify --input "input=const f=async(a,b)=>{if(a?.b){return [1,2].map(x=>x*b)}else throw new Error(\`no \${a}\`)}"
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin format.js --operation minify --input "input=// comment
const re = /a\/b/g; /*! keep */
let s = \"a  b\";
return
value"
pnpm --dir apps/desktop build
git diff --check
```

## Evidence

Test counts, fixture counts, both headless outputs, the
`pnpm --dir apps/desktop build` summary line showing the worker chunk size.

## Out of scope

Real minification (renaming, dead code, constant folding), TypeScript or JSX
syntax, source maps, syntax highlighting (shell work). Editing anything under
`packages/vendor/`.
