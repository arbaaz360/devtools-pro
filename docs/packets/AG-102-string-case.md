# AG-102 — String case converter package (DU-27)

## Branch

`antigravity/AG-102-string-case` from the latest `origin/main`. Record the base
SHA.

## Allowed files

```text
plugins/string-case/**
```

## Required reading

`ARCHITECTURE.md`, `Tool Contract and Document Model.md`,
`packages/plugin-sdk/README.md`, the DU-27 card in
`docs/DEVUTILS_REQUIREMENTS.md`, and two reference packages:
`plugins/base64-text/` for package layout, README and fixture style, and
`plugins/find-replace/` for Unicode-aware word handling and option validation.

## Goal

A new package `plugins/string-case/` with plugin id `text.case` that converts
identifier-style text between cases, line by line, with configurable acronym
preservation.

## Requirements

- `plugin.json`, `manifest.json` (`tests.requirementIds: ["DU-27"]`), `processor.mjs`,
  `test.mjs`, `README.md`, `fixtures/`.
- One operation `text.case`. Input port `input`, kind `document`, `contentKinds: ["text"]`.
  Output port `output`, kind `value`, representations `["text", "properties"]`,
  carrying the converted text and `{ lines, converted, acronymsApplied }`.
- Options: `target` enum with ids `camel`, `pascal`, `snake`, `kebab`,
  `screaming-kebab`, `constant` (default `camel`); `acronyms` string, a
  comma-separated list, default `ID,API,DB,URL,HTTP`; `preserve-acronyms`
  boolean, default `true`. Option ids are kebab-case; accept the camelCase
  aliases the way `plugins/find-replace` does.
- Word splitting, and the README must state these rules: split on whitespace,
  `_`, `-`, and punctuation; on a lowercase-to-uppercase hump; between a run of
  uppercase letters and a following capitalised word (`HTTPServer` → `HTTP`,
  `Server`); at every letter-to-digit and digit-to-letter boundary. Letters are
  `\p{L}` and case is `\p{Lu}`/`\p{Ll}`, so `Ünïcödé` and `Straße` split and
  case correctly; characters with no case pass through unchanged.
- Acronym preservation: a word equal to a listed acronym (case-insensitive)
  keeps its uppercase form in `camel` and `pascal` (`userID`, `UserID`) and is
  lowercased in `snake` and `kebab`. With `preserve-acronyms: false` it is an
  ordinary word (`userId`). The list is trimmed, empty entries ignored.
- Line-oriented: each line converts independently; blank lines and the
  document's line endings (`\n`, `\r\n`) are preserved byte for byte; leading and
  trailing whitespace on a line is preserved.
- Idempotence: converting an output again with the same target returns it
  unchanged. Test it for every target over every fixture.
- Errors: unknown target, unknown option key, non-string acronyms, input over
  the manifest limit. Structured errors with the option name; nothing written.
- Limits in the manifest: `maxInputBytes` 1 MiB, `maxOutputBytes` 2 MiB. Read
  with `readChunks`, poll cancellation between lines, keep source bytes
  immutable (assert it in every test).
- Fixtures: `fixtures/vectors.json` with at least 40 cases covering every
  target, the DU-27 screenshot examples (`ID`, `API`, `DB`, `URL`, `HTTP`),
  digits, Unicode, punctuation, blank and multiple lines, CRLF, acronym toggle;
  `fixtures/invalid.json` for every error.

## Checks

```text
node --experimental-strip-types --test plugins/string-case/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin text.case --input "input=userID_loaderHTTPServer v2Api" --options '{"target":"snake"}'
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin text.case --input "input=user id" --options '{"target":"pascal","acronyms":"ID"}'
cargo run -p devtools-plugin-discovery -- generate plugins <scratch dir>
git diff --check
```

## Evidence

Test counts; the two headless outputs; the discovery generate result showing
`text.case` in the catalog.

## Out of scope

The shell view, the live result editor, and the editable acronym list UI.
Locale-specific casing (Turkish dotted i).
