# AG-107 — Escaping package follow-ups

## Branch

`antigravity/AG-107-escaping-followups` from the latest `origin/main`. Record
the base SHA.

## Allowed files

```text
plugins/escaping/**
```

## Required reading

`plugins/escaping/README.md`, `plugins/escaping/processor.mjs`,
`plugins/escaping/test.mjs`, the WHATWG HTML section "named character
reference state" (the rule for legacy names without a semicolon in attribute
values), and the review on https://github.com/arbaaz360/devtools-pro/pull/11.

## Goal

Close the three non-blocking items from the CL-011 review without changing any
existing output for existing inputs and options.

## Requirements

1. `text.html` unescape gains an option `context` enum `text` (default),
   `attribute`. In `attribute` context a legacy semicolon-less named reference
   is left as written when the next character is `=` or an ASCII alphanumeric,
   exactly as the WHATWG rule states (`?a=1&copy=2` stays `&copy=2`; `&copy;`
   still decodes; `&copy ` still decodes). `text` context is unchanged.
2. Each `html-escape`, `json-string-escape` and `backslash-escape` fixture file
   gains at least one vector with combining marks (`é`, `\u{1F600}⃣`)
   proving code-point handling.
3. The README documents that `sequences` counts a surrogate-pair `\u` escape as
   two.

Every existing fixture stays byte-identical. Add fixtures for the new context
in `html-unescape.json` and `html-errors.json` as needed.

## Checks

```text
node --experimental-strip-types --test plugins/escaping/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin text.escaping --operation text.html --input "input=?a=1&copy=2&lt;" --options '{"mode":"unescape","strict":false,"context":"attribute"}'
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin text.escaping --operation text.html --input "input=?a=1&copy=2&lt;" --options '{"mode":"unescape","strict":false}'
git diff --check
```

## Evidence

Test counts and both headless outputs, which must differ only in `&copy=2`.

## Out of scope

Regenerating `html-entities.mjs`, the manifest `version`, any other operation.
