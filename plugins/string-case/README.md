# String Case Converter

Converts identifier-style text between cases, line by line, with configurable acronym preservation.

## Features

- Supported targets: `camelCase`, `PascalCase`, `snake_case`, `kebab-case`, `SCREAMING-KEBAB`, `CONSTANT_CASE`.
- Configurable acronym preservation (e.g. `ID`, `API`, `DB`, `URL`, `HTTP`).
- Acronyms keep their uppercase form in `camel` and `pascal` (`userID`, `UserID`), and are lowercased in `snake` and `kebab`.
- When acronym preservation is disabled, acronyms are treated as ordinary words (`userId`).
- Converts line by line independently, preserving leading and trailing whitespace exactly.
- Preserves line endings (`\n` and `\r\n`) and blank lines byte-for-byte.

## Word Splitting Rules

A word is composed of letters and digits. Splitting rules:
- Split on whitespace, `_`, `-`, and punctuation.
- Split on a lowercase-to-uppercase hump (e.g. `aB` → `a`, `B`).
- Split between a run of uppercase letters and a following capitalised word (e.g. `HTTPServer` → `HTTP`, `Server`).
- Split at every letter-to-digit and digit-to-letter boundary (e.g. `v2Api` → `v`, `2`, `Api`).
- Characters with no case pass through unchanged.
