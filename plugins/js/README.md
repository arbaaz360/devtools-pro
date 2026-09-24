# JS Formatter

`format.js` provides operations to beautify and minify JavaScript code.

## How the code is read

Both operations read the program with **acorn** (vendored in `packages/vendor/acorn`),
a real ECMAScript parser, as a script first and then as a module. A CommonJS top-level
`return` and a `#!` line are accepted. Both then **check their own output**: it must
parse to the same syntax tree as the input, positions aside (`sameTree` in
`processor.mjs`). Output that fails the check is never written. This is the owner's
rule that transforms preserve meaning or refuse (`docs/DEVUTILS_REQUIREMENTS.md`,
§ Owner decisions).

A hand-written tokenizer did this job until the third independent review (AST-001). It
failed on a regex after `)` (`if (x) /a  b/`), a template after `return`, and Unicode
names (`let π`). Each input class had to be found before it could be fixed, and until
then it was changed without a word.

| The input… | Minify | Beautify |
|---|---|---|
| parses, and the output parses the same | written, `verified: true` | written, `verified: true` |
| parses, but js-beautify's output parses differently (e.g. a line break after `return`, or js-beautify splitting a `${…}` inside a template) | — | refused, `js.beautify.changes-meaning` |
| does not parse (a fragment, JSX, TypeScript, a syntax error, nesting deeper than the parser follows) | refused, `js.syntax-error` with line and column | written as js-beautify lays it out, `verified: false` and a `note` saying it was not checked |

## Beautifier

The beautifier integrates `js-beautify`. The plugin SDK streams the input, buffering it entirely into memory (limited to 4 MiB) and executes the beautification. The beautifier options map closely to `js-beautify`:

| Option | Choices | Default | js-beautify option |
|---|---|---|---|
| `indent` | `space-2`, `space-4`, `tab` | `space-2` | `indent_size` / `indent_with_tabs` |
| `brace-style` | `collapse`, `expand`, `end-expand` | `collapse` | `brace_style` |
| `preserve-newlines` | `true`, `false` | `true` | `preserve_newlines` |
| `max-preserve-newlines` | `0` to `10` | `2` | `max_preserve_newlines` |
| `space-in-parens` | `true`, `false` | `false` | `space_in_empty_paren`, `space_in_paren` |
| `end-with-newline` | `true`, `false` | `true` | `end_with_newline` |

## Minifier

Minify removes comments and whitespace. It does not rename or restructure anything: it
prints acorn's tokens, each as its own source text, with the least separation that
still reads as the same tokens:

- Nothing between tokens that touched in the source. This also keeps a template's own
  text whole.
- A space where two tokens would merge: two words (`let x`, `1 in a`, `/a/g in b`),
  `+ +`, `- -`, `/` beside `/` or `*`, `<` before `!--`, and a number before `.`.
- A line break where the source had one, but only after `return`, `throw`, `break`,
  `continue`, `yield`, `async` or `let`, or before `++`/`--` that follows an expression.

Then the output is checked. If the compact form parses to a different tree, Minify
prints again keeping every line break the source had. If that also differs, it refuses
(`js.minify.changes-meaning`) rather than write a different program.

With `preserve-comments` set to `license` (the default), comments containing `/*!`,
`@license` or `@preserve` are kept, in the same kind of gap they had: on their own lines
when a line break surrounded them, since that line break may be one the grammar reads.

The result's properties count the input's `comments`, `strings`, `templates` and
`regexes`, and give the output's `lines` and `bytes`, and whether it was `verified`.
