# JS Formatter

`format.js` provides operations to beautify and minify JavaScript code.

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

The minify operation is purely a comment-and-whitespace removal tokenizer, rather than a full AST parser like Terser. It runs iteratively through the code, matching JavaScript lexical tokens and dropping unneeded whitespace.

### Tokenizer Rules
1. **Strings (`'` and `"`):** Parsed until the closing quote, skipping `\` escaped characters. Emits `js.unterminated-string` on newline.
2. **Template Literals (`` ` ``):** Parsed until the closing backtick. Tracks nested braces (`${}`) to properly resume the template literal parsing when escaping out of JavaScript context. Emits `js.unterminated-template` if unclosed.
3. **Regular Expressions:** Parsed cautiously to avoid confusing division (`/`) with regex boundaries. A `/` starts a regex only if the previous token allows it (start of code, after keywords like `return`, `typeof`, `instanceof`, `new`, `throw`, etc., or after punctuation/operators). Tracks character classes (`[...]`) to avoid false terminations from escaped slashes or `//` within them.
4. **Comments (`//` and `/* */`):** Identified and dropped from the output by default. If `preserve-comments` is `license`, only comments containing `/*!`, `@license`, or `@preserve` are kept. Emits `js.unterminated-comment` if block comment is unclosed.
5. **Identifiers & Keywords:** Characters matching `[a-zA-Z0-9_$]`.
6. **Operators & Punctuation:** Distinguishes mathematical operations and structural characters.

### ASI (Automatic Semicolon Insertion) Newline Rule
Because the minifier removes all unnecessary whitespace (including newlines), it could accidentally break code relying on ASI (where a newline implies a semicolon).

**Rule**: The minifier will preserve a newline if a statement ends with an identifier, number, string, template literal, or specific keywords/punctuation (`return`, `break`, `continue`, `throw`, `++`, `--`, `)`, `]`, `}`) **AND** the next line starts with an identifier, `(`, `[`, `` ` ``, `+`, `-`, or `/`.

**Limitation**: This heuristic covers standard ASI hazards (like `return\nvalue` or `y\n++z`), but complex ASI structures might still be minified incorrectly due to the lack of an AST context. For heavily ASI-dependent code, a full parser-based minifier should be used instead.
