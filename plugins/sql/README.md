# SQL Formatter

`format.sql` provides operations to beautify and minify SQL text. It includes a custom SQL tokenizer that supports standard SQL as well as dialect-specific syntax (e.g. MySQL, PostgreSQL, PL/SQL). The processor uses only the public plugin SDK (`ProcessorContext`).

## Tokenizer

The tokenizer parses the input text into semantic tokens: `whitespace`, `comment` (single-line `--` or `#`, multi-line `/* */`), `string` (single-quoted, and dialect-specific double-quoted or backtick-quoted literals), `keyword`, `operator`, `punctuation` (like commas and parentheses), and `identifier`. It gracefully handles unterminated strings and comments, emitting `sql.unterminated-string` and `sql.unterminated-comment` warnings. It periodically checks for cancellation to prevent blocking on massive files.

### What each dialect changes

The `dialect` option decides how comments and quotes are read, because the same
text means different things in different databases:

| Dialect | Comments | Strings |
|---|---|---|
| `sql` (default) | `--` always starts a comment; `/* */` does not nest | `'...'` with `''` doubling; a backslash is plain text. `"..."` and `[...]` are identifiers |
| `mysql`, `mariadb` | `--` starts a comment only when whitespace or a control character follows (`1--1` is 2); `#` starts one; `/*! ... */` (executed) and `/*+ ... */` (optimizer hints) are **kept by Minify** | `'...'` and `"..."` are strings with backslash escapes, as in the default SQL mode. ANSI_QUOTES is not modelled |
| `postgresql` | block comments nest | `E'...'` takes backslash escapes, `'...'` does not; `$$...$$` and `$tag$...$tag$` are opaque (`$1` is a parameter) |
| `plsql` | `/*+ ... */` hints are kept by Minify | `q'[...]'`, `q'{...}'`, `q'<...>'`, `q'(...)'` and `q'X...X'` are opaque |

## Beautify and Minify Rules

**Beautify** restructures the token stream:
- Trims redundant whitespace while preserving required spacing around keywords and operators.
- Enforces consistent casing for SQL keywords (e.g., `UPPERCASE` or `lowercase`).
- Structures queries with newlines after major clauses (`SELECT`, `FROM`, `WHERE`, etc.).
- Applies indentation based on parentheses nesting and clause depth.
- Formats comma-separated lists with commas positioned at either the end of the previous line or the start of the next line.

**Minify** strips the SQL text down to the smallest possible byte size:
- Removes all comments (unless they contain specific directives).
- Collapses all unnecessary whitespace, replacing sequences of spaces or newlines with a single space where syntactically required, or removing them entirely around punctuation.
- Preserves the original casing of strings and identifiers.
- Omits all indentation and formatting newlines.

## Options

| Option | Choices | Default | Meaning |
|---|---|---|---|
| `dialect` | `sql`, `mysql`, `mariadb`, `postgresql`, `plsql` | `sql` | SQL dialect for parsing quotes and comments. |
| `keyword-case` | `upper`, `lower`, `preserve` | `upper` | Casing applied to identified SQL keywords. |
| `indent` | `space-2`, `space-4`, `tab` | `space-2` | Indentation style. (Accepts `2` or `4` as aliases for backwards compatibility). |
| `comma-position` | `end`, `start` | `end` | Comma placement in lists (after previous item or before next item). |

## Output

Both operations yield an artifact of MIME type `text/x-sql`. They also return a properties value with `lines`, `comments`, `strings`, `keywords`, `diagnostics`, and `bytes`.

## Limits

- `maxInputBytes`: 4 MiB. Enforced before tokenizing.
- `maxOutputBytes`: 8 MiB. Output is bounded to prevent unbounded scaling.
- `maxChunkBytes`: 8 MiB.
- `deadlineMs`: 2000. Cancellation is checked every 4096 tokens.

## Out of scope

- Abstract Syntax Tree (AST) parsing: The formatter is purely token-based and doesn't construct a full AST or perform deep semantic validation.
- Complex dialect-specific query restructuring or re-ordering.
- Syntax highlighting or IDE integration.
