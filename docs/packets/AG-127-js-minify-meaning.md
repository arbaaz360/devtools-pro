# AG-127 — JavaScript minify must not change what the program does (DU-15)

## Branch

`antigravity/AG-127-js-minify-meaning` from the latest `origin/main`. Record the base SHA.

## Allowed files

```text
plugins/js/**
```

## Required reading

"Owner decisions → Transforms preserve meaning" in `docs/DEVUTILS_REQUIREMENTS.md`;
the DU-15 card there; `docs/parity/DU-15.md`; `plugins/js/README.md`; and
`docs/WORKER_PROTOCOL.md`, including "Where an expected value comes from".

## Goal

An independent review (finding AST-001, reproduced by the integrator) found that
**Minify JavaScript** turns valid programs into different ones and reports success.
Each case below was judged by node's own JavaScript engine, not by this package:

```text
input                                   minified                                   node:vm says
(()=>{function f(){return               (()=>{function f(){return{a:1}};           source -> undefined
{a:1}};return f()})()                   return f()})()                             minified -> {"a":1}

// @license MIT                         // @license MIT globalThis.answer=42      the assignment is now
globalThis.answer=42                                                               inside the comment

(1 .toString())                         (1.toString())                             SyntaxError

a=1<CR>b=2      (CR-only line end)      joined without a separator                 changes the program
```

The review traced these to `plugins/js/processor.mjs` near lines 219, 262, 319 and
325 (at `5866a49`): whitespace containing a line terminator is dropped whenever the
neighbouring tokens "look" joinable. JavaScript's automatic semicolon insertion,
line comments and number lexing all depend on exactly those line terminators.

## Requirements

- **A line terminator that separated two tokens survives minification unless
  removing it is provably harmless.** The conservative rule is acceptable and
  preferred: where one or more line terminators stood between two tokens with no
  `;` between them, emit one `\n`. A few hundred bytes of newlines cost less than a
  changed program.
- It must hold at least for the restricted productions (`return`, `throw`,
  `break`, `continue`, `yield`, `async` before an arrow, postfix `++`/`--` on the
  next line) and for the end of every retained line comment, which always ends with
  `\n`.
- **CR, CRLF, U+2028 and U+2029 are line terminators** everywhere LF is.
- A decimal integer literal followed by `.` keeps a separator (`1 .toString()`),
  so the output never re-lexes as a different number.
- **Beautify meets the same bar.** It adds line breaks; it must never add one where
  ASI would change the program (between `return` and its operand, for instance).
- A case the minifier cannot decide safely keeps its newline. Nothing is refused
  that parses.

## Checks

```text
node --experimental-strip-types --test plugins/js/test.mjs
node scripts/test-plugins.mjs
pnpm --dir apps/desktop build
git diff --check
```

## Evidence

**The oracle is node's `vm`, not this package.** For every program in the corpus:

1. `new vm.Script(source)` and `new vm.Script(output)` both compile.
2. `vm.runInNewContext(source, {})` and `vm.runInNewContext(output, {})`, each in a
   fresh context, give the same result (compare `JSON.stringify` of the value and of
   the context's own properties, so side effects such as `globalThis.answer` count).
3. Both hold for Minify and for Beautify.

The corpus holds the four reproductions above plus at least twenty programs you
write to break a naive minifier: each restricted production; `a\n++b`; `a\n(b)`
(no ASI, so joining is correct and must still evaluate the same); a regular
expression after `)` and after `return`; a template literal containing `//` and
`/*`; a string containing `*/`; division next to a regex-looking token; a line
comment at end of file; CRLF, CR-only, U+2028 and U+2029 variants of the ASI cases.

Quote the corpus table (program, minified output, both results) in your status.
The existing fixtures that pin exact minified bytes may stay as stability pins,
but they are not evidence of correctness and do not count toward this packet.

## Out of scope

Identifier mangling or any other size optimisation; the known DU-15 gap that the
tokenizer misses structural syntax errors in *invalid* input; the shell.
