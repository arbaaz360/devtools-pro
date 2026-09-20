# AG-118 — HTML and SVG to JSX package (DU-24)

## Branch

`antigravity/AG-118-html-to-jsx` from the latest `origin/main`. Record the
base SHA.

## Allowed files

```text
plugins/jsx/**
```

## Required reading

`ARCHITECTURE.md`, `Tool Contract and Document Model.md`,
`packages/plugin-sdk/README.md`, the DU-24 card in
`docs/DEVUTILS_REQUIREMENTS.md`, the "working" rules in
`docs/WORKER_PROTOCOL.md` (a processor uses web platform APIs only), and two
reference packages: `plugins/html/` for the HTML tokenizer rules (void
elements, raw-text elements, attribute quoting) and `plugins/string-case/`
for option validation with kebab-case ids.

## Goal

A new package `plugins/jsx/` with plugin id `convert.jsx` that converts an
HTML or SVG fragment into JSX with a tokenizer: attribute renames, `style`
strings into objects, self-closing void elements, comments into JSX
comments, and braces in text escaped. Incomplete markup converts as far as
the tokens allow.

## Requirements

- Package files as in the reference packages; `tests.requirementIds: ["DU-24"]`.
- One tool `convert.jsx`, category `converter`, one operation `convert.jsx`.
  Input port `input` (document, text); output port `output`, kind
  `artifact`, mime `text/javascript`, representations `["code",
  "properties", "annotations"]`.
- Options (kebab-case ids, camelCase aliases, structured errors for unknown
  keys and wrong types): `wrap` enum `none`, `fragment`, `component`
  (default `fragment`: siblings at the top level are wrapped in `<>...</>`;
  `component`: the output is `export default function Component() {\n
  return (\n ...\n );\n}` with the JSX indented); `component-name` string
  (default `Component`, must be a valid identifier); `indent` enum `2`, `4`,
  `tab` (default `2`); `svg-attributes` enum `camel`, `keep` (default
  `camel`).
- Conversion rules, each with a fixture, and the README lists them:
  - `class` → `className`, `for` → `htmlFor`, `tabindex` → `tabIndex`,
    `readonly` → `readOnly`, `maxlength` → `maxLength`, `colspan` →
    `colSpan`, `rowspan` → `rowSpan`, `autocomplete` → `autoComplete`,
    `autofocus` → `autoFocus`, `enctype` → `encType`, `accept-charset` →
    `acceptCharset`, `http-equiv` → `httpEquiv`, `crossorigin` →
    `crossOrigin`, `srcset` → `srcSet`, `contenteditable` →
    `contentEditable`, `spellcheck` → `spellCheck`, `novalidate` →
    `noValidate`, `formnovalidate` → `formNoValidate`, `frameborder` →
    `frameBorder`, `allowfullscreen` → `allowFullScreen`, `datetime` →
    `dateTime`, `accesskey` → `accessKey`, `hreflang` → `hrefLang`,
    `inputmode` → `inputMode`, `minlength` → `minLength`, `playsinline` →
    `playsInline`, `referrerpolicy` → `referrerPolicy`, `usemap` →
    `useMap`; event attributes `onclick` → `onClick` (first letter after
    `on` capitalised); `data-*` and `aria-*` unchanged.
  - SVG attributes with `svg-attributes: camel`: every hyphenated or
    colon-separated name becomes camelCase (`stroke-width` → `strokeWidth`,
    `xlink:href` → `xlinkHref`, `xml:space` → `xmlSpace`), `class` →
    `className`, `viewBox` kept; with `keep` they are left as written.
  - `style="a: b; c-d: e"` → `style={{ a: "b", cD: "e" }}`; vendor
    prefixes `-webkit-x` → `WebkitX`; numeric values kept as strings;
    an empty style attribute is dropped.
  - Boolean attributes (`disabled`, `checked`, `selected`, `hidden`,
    `required`, `readonly`, `multiple`, `autofocus`, `autoplay`,
    `controls`, `loop`, `muted`, `open`, `defer`, `async`, `novalidate`)
    without a value become `attr` alone; with a value they keep it.
  - Void elements (`area base br col embed hr img input link meta source
    track wbr`) and any element written `<x/>` become self-closing `<x />`.
  - `<!-- x -->` → `{/* x */}`; `--` inside a comment body is left as-is
    but `*/` inside becomes `* /`.
  - Text: `{` → `{"{"}`, `}` → `{"}"}`, `>` and `<` in text untouched;
    character references (`&nbsp;`, `&#169;`) are left as written.
  - `<script>` and `<style>` contents are emitted inside `{` `` ` `` ...
    `` ` `` `}` as a template literal with backticks and `${` escaped.
  - Attribute values keep their quotes; a double-quoted value containing
    `"` uses `{"..."}` with JSON escaping.
- Diagnostics: a stray `</x>` with no open element, an unclosed element at
  end of input (closed for the output), and a `<script>`/`<style>` block
  each produce a `severity: "warning"` diagnostic with byte offset, line and
  column. Only an empty document is an error.
- Properties: `elements`, `attributesRenamed`, `stylesConverted`,
  `comments`, `diagnostics` (count), `bytes`.
- Limits: `maxInputBytes` 4 MiB, `maxOutputBytes` 16 MiB. Read with
  `readChunks`, tokenize in one pass, poll cancellation every 4096 tokens.
  Source bytes immutable, asserted per test.
- Fixtures under `fixtures/`: at least 40 cases as `{ name, options, input,
  output, diagnostics }` covering every rule above, the DU-24 screenshot
  sample, an inline SVG icon with `stroke-width` and `xlink:href`, a form
  with `for`/`class`/boolean attributes, nested lists, a `style` with vendor
  prefix and a trailing semicolon, every `wrap` value, a `component-name`
  with an invalid identifier rejected, incomplete markup, and each
  diagnostic case.

## Checks

```text
node --experimental-strip-types --test plugins/jsx/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin convert.jsx --input "input=<div class=\"card\" style=\"margin-top: 4px; -webkit-user-select: none\"><label for=\"x\">Name</label><input id=\"x\" disabled><br><!-- note --></div>"
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin convert.jsx --input "input=<svg viewBox=\"0 0 24 24\"><path d=\"M0 0h24v24H0z\" stroke-width=\"2\"/></svg>" --options '{"wrap":"component","component-name":"Icon"}'
pnpm --dir apps/desktop build
git diff --check
```

## Evidence

Test counts, fixture counts, both headless outputs, the
`pnpm --dir apps/desktop build` summary line.

## Out of scope

TypeScript output, prop extraction, formatting beyond the indentation option
(DU-15 owns beautifying), rendering the JSX (shell work).
