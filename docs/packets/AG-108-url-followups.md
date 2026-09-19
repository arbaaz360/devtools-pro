# AG-108 — URL package follow-ups

## Branch

`antigravity/AG-108-url-followups` from the latest `origin/main`. Record the
base SHA.

## Allowed files

```text
plugins/url/**
```

## Required reading

`plugins/url/README.md`, `plugins/url/processor.mjs`, `plugins/url/test.mjs`,
and the review on https://github.com/arbaaz360/devtools-pro/pull/7.

## Goal

Close the non-blocking items from the CL-009 review without changing any
existing output for valid input.

## Requirements

1. The error token for a malformed percent escape never cuts a UTF-8 sequence:
   when `%` is followed by a multi-byte character, extend the token past the
   continuation bytes so `%€x` reports `"%€"`, not a replacement character. The
   reported byte offset stays the same. Add an invalid fixture.
2. README: the output-limit sentence says the check happens before writing;
   only encode checks before allocating. State both precisely.
3. README, under the parse-query section: interior newlines in the query are
   kept as data, while the `href` component follows WHATWG and strips them.
   Add one fixture demonstrating it.
4. Rename the fixture files and the manifest's `tests.fixtures` entries to the
   `url-` prefix used by sibling packages (`url-transform`, `url-parse-query`,
   `url-invalid`), updating `test.mjs` paths.

Every existing valid-input output stays byte-identical.

## Checks

```text
node --experimental-strip-types --test plugins/url/test.mjs
MSYS_NO_PATHCONV=1 node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin web.url --operation transform --input "input=%€x" --options '{"mode":"decode"}'
cargo run -p devtools-plugin-discovery -- generate plugins <scratch dir>
git diff --check
```

The headless run must fail with a structured error whose token is `"%€"`.

## Evidence

Test counts, the headless error output, and the discovery generate result
(the catalog must be unchanged apart from nothing: fixture names are not
embedded).

## Out of scope

The manifest `version`, any encoding behaviour, the `emit` write order.
