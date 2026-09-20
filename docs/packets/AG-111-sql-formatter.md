# AG-111 — SQL formatter package (DU-26)

## Branch

`antigravity/AG-111-sql-formatter` from the latest `origin/main`. Record the
base SHA.

## Allowed files

```text
plugins/sql/**
```

## Required reading

`ARCHITECTURE.md`, `Tool Contract and Document Model.md`,
`packages/plugin-sdk/README.md`, the DU-26 card in
`docs/DEVUTILS_REQUIREMENTS.md`, the "working" rules in
`docs/WORKER_PROTOCOL.md` (a processor uses web platform APIs only), and two
reference packages: `plugins/base64-text/` for layout, README and fixtures,
and `plugins/string-case/` for option validation with kebab-case ids.

## Goal

A new package `plugins/sql/` with plugin id `format.sql` that beautifies or
minifies SQL text with a tokenizer, never a parser: it must format incomplete
or invalid SQL without failing, and never change the meaning of what it
touches.

## Requirements

- Package files as in the reference packages; `tests.requirementIds: ["DU-26"]`.
- One tool `format.sql`, category `converter`, two operations: `beautify` and
  `minify`. Input port `input` (document, text); output port `output`, kind
  `artifact`, representations `["code", "properties"]`, mime `text/x-sql`.
- Options (kebab-case ids, camelCase aliases, structured errors on unknown
  keys or wrong types): `dialect` enum `sql`, `mysql`, `mariadb`, `postgresql`,
  `plsql` (default `sql`); `keyword-case` enum `upper`, `lower`, `preserve`
  (default `upper`); `indent` enum `2`, `4`, `tab` (default `2`);
  `comma-position` enum `end`, `start` (default `end`). `minify` accepts and
  ignores `indent` and `comma-position`.
- Tokenizer, stated in the README: single-quoted strings with `''` escapes
  (and backslash escapes only for `mysql`/`mariadb`); double-quoted and
  backtick identifiers, `[bracket]` identifiers for `sql`; `--` and `#`
  (`mysql`/`mariadb` only) line comments; `/* */` block comments;
  PostgreSQL `$tag$ ... $tag$` dollar-quoted strings and `::` casts;
  numbers including `1e3`, `0x1F`, `.5`; operators up to three characters
  (`<>`, `!=`, `<=`, `>=`, `||`, `->`, `->>`, `::`); parameters `?`, `:name`,
  `$1`, `@name`. Strings, comments and quoted identifiers are emitted
  byte-for-byte, never re-cased.
- Beautify rules, each with a fixture: statements split on `;`, one blank
  line between them; each major clause starts a new line at the statement's
  indentation (`SELECT`, `FROM`, `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY`,
  `LIMIT`, `OFFSET`, `UNION [ALL]`, `INSERT INTO`, `VALUES`, `UPDATE`, `SET`,
  `DELETE FROM`, `CREATE TABLE`, `ALTER TABLE`, `WITH`, every `JOIN` variant,
  `ON`); select-list, set-list and value-list items one per line indented one
  level; `AND`/`OR` at the start of a line indented one level under `WHERE`,
  `ON` and `HAVING`; parenthesised sub-selects open on the line of `(`,
  indent one level, and close `)` on its own line; other parentheses
  (function calls, `IN (...)` lists shorter than 60 characters) stay inline;
  `CASE ... WHEN ... THEN ... ELSE ... END` one branch per line indented under
  `CASE`; keywords recased per `keyword-case`, identifiers never; a single
  space around binary operators and after commas; comments kept where they
  appear, on their own line if they were on their own line.
- Minify: comments removed, every run of whitespace outside strings, quoted
  identifiers and comments collapsed to one space or removed where two
  tokens cannot merge (`a=1`, `f(x)`, `x,y`), keyword case untouched. A
  beautified statement minified and beautified again is byte-identical:
  test it for every fixture.
- Properties: `statements`, `tokens`, `comments`, `keywordCase`, `dialect`,
  `bytes`.
- Limits: `maxInputBytes` 4 MiB, `maxOutputBytes` 8 MiB. Read with
  `readChunks`, tokenize in one pass, poll cancellation every 4096 tokens,
  output written once. Source bytes immutable, asserted per test.
- Fixtures under `fixtures/`: at least 40 `beautify` cases as
  `{ name, dialect, options, input, output }` including the DU-26 screenshot
  query, joins with `ON` conditions, nested sub-selects, `CASE`, `INSERT ...
  VALUES` with several rows, `UPDATE ... SET`, `CREATE TABLE` with column
  definitions, `WITH` CTEs, `UNION ALL`, comments in every position, strings
  containing keywords and semicolons, dollar quoting, MySQL backticks and `#`
  comments, an incomplete statement (`SELECT a, FROM`) that formats without
  error, a lone keyword, empty input; 10 `minify` cases; invalid option
  values.

## Checks

```text
node --experimental-strip-types --test plugins/sql/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin format.sql --operation beautify --input "input=select u.id, u.name, count(o.id) as orders from users u left join orders o on o.user_id = u.id where u.active = 1 and o.created_at > '2024-01-01' group by u.id, u.name having count(o.id) > 3 order by orders desc limit 10;"
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin format.sql --operation minify --input "input=SELECT  a ,  b  FROM   t  -- done
WHERE a = 1"
pnpm --dir apps/desktop build
git diff --check
```

## Evidence

Test counts, fixture counts, both headless outputs, the
`pnpm --dir apps/desktop build` summary line.

## Out of scope

Validation or parsing errors: incomplete SQL formats as far as the tokens
allow. Dialect-specific statement grammar beyond the tokenizer differences
listed. Syntax highlighting and the dialect-driven language identity of the
editors (shell work).
