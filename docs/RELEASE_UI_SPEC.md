# Release UI conventions

Decided 2026-09-27 from the release audit (the owner reviewed the installed build and
asked for everything a user sees to be fixed before launch). This file is the single
source for names, groups, descriptions, operation verbs and option labels. The shell
(`apps/desktop`), the packages (`plugins/*`) and the native tools (`crates`,
`apps/desktop/src/workbench/tools.ts`) all follow it; when they disagree, this file wins.

## Rail groups

Group order is fixed. Inside a group, tools sort by label.

| Group label | Manifest `category` | Native tools placed here |
|---|---|---|
| WORKSPACE | — | Text Editor |
| FORMAT | `format` | JSON Formatter, CSV Inspector |
| CONVERT | `convert` | cURL to Code |
| ENCODE | `encode` | Image to Base64, Base64 to Image, JSON String Escape / Unescape, Hash Generator, URL Encode / Decode, Unicode Escape / Unescape |
| TEXT | `text` | Text Inspector, Find & Replace, Text Diff |
| WEB & SECURITY | `web`, `security` | — |
| GENERATE | `generate` | — |

Legacy categories still map, so nothing falls through to an upper-cased raw category:
`converter`→CONVERT, `encoding`→ENCODE, `structured`→FORMAT, `compare`→TEXT,
`generator`/`identity`/`media`→GENERATE, `time`/`number`→CONVERT, `viewer`→FORMAT.

## Tools: name, group, description, operations

Names are Title Case noun phrases. Two-way tools keep `↔` or `/ Unescape`. The
description is the rail row's tooltip and the tool-header subtitle (≤ 60 characters, no
trailing full stop). Operation titles are the button labels: one short verb.

| Tool id | Name | Group | Description | Operations (id → title) |
|---|---|---|---|---|
| editor.text | Text Editor | WORKSPACE | A plain text document with no tool attached | — |
| structured.json | JSON Formatter | FORMAT | Format, minify or validate JSON | format → Format · minify → Minify · inspect → Validate |
| structured.csv | CSV Inspector | FORMAT | Rows, columns and delimiter of a CSV document | inspect → Inspect |
| format.css | CSS Formatter | FORMAT | Beautify or minify CSS | beautify → Format · minify → Minify |
| format.html | HTML Formatter | FORMAT | Beautify or minify HTML | beautify → Format · minify → Minify |
| format.js | JavaScript Formatter | FORMAT | Beautify or minify JavaScript | beautify → Format · minify → Minify |
| format.sql | SQL Formatter | FORMAT | Beautify or minify SQL | beautify → Format · minify → Minify |
| format.xml | XML Formatter | FORMAT | Beautify or minify XML | beautify → Format · minify → Minify |
| preview.documents | Markdown & HTML Preview | FORMAT | Markdown or HTML rendered as a page | preview.markdown → Markdown · preview.html → HTML |
| convert.yaml | YAML ↔ JSON | CONVERT | YAML to JSON, or JSON to YAML | convert.yaml-json → YAML to JSON · convert.json-yaml → JSON to YAML |
| convert.jsx | HTML/SVG to JSX | CONVERT | HTML or SVG markup as a JSX fragment or component | convert.jsx → Convert |
| number.base | Number Base Converter | CONVERT | Integers between binary, octal, decimal, hex and more | number.base → Convert |
| time.unix | Unix Timestamp Converter | CONVERT | Unix time, ISO 8601 and RFC dates, in UTC and local time | time.unix → Convert |
| text.case | String Case Converter | CONVERT | camelCase, snake_case, kebab-case and more | text.case → Convert |
| web.curl-code | cURL to Code | CONVERT | A cURL command as JavaScript fetch or Python requests | fetch → JavaScript fetch · python → Python requests |
| encoding.base64-text | Base64 Text | ENCODE | Encode text as Base64, or decode Base64 to text | encoding.base64-text → Convert |
| encoding.image-base64 | Image to Base64 | ENCODE | A PNG or JPEG as a Base64 string or data URI | encode → Encode |
| encoding.base64-image | Base64 to Image | ENCODE | A Base64 string or data URI back to an image | decode → Decode |
| encoding.hex | Hex ↔ Text | ENCODE | Bytes as hexadecimal, and back | encoding.hex → Convert |
| text.url | URL Encode / Decode | ENCODE | Percent-encode text, or decode it | encode → Encode · decode → Decode |
| text.html | HTML Escape / Unescape | ENCODE | HTML character references such as &amp; and &#233;, and back | text.html → Convert |
| text.json-string | JSON String Escape / Unescape | ENCODE | Text as a JSON string literal, and back | escape → Escape · unescape → Unescape |
| text.backslash | Backslash Escape / Unescape | ENCODE | Backslash sequences such as \n and \", and back | text.backslash → Convert |
| text.unicode | Unicode Escape / Unescape | ENCODE | \uXXXX escapes for non-ASCII text, and back | encode → Escape · decode → Unescape |
| encoding.hash | Hash Generator | ENCODE | SHA-256 and SHA-512 digests of text or a file | sha256 → SHA-256 · sha512 → SHA-512 |
| text.inspect | Text Inspector | TEXT | Bytes, characters, lines, words and line endings | inspect → Inspect |
| text.find-replace | Find & Replace | TEXT | Find text in the document and replace it | (in-editor; no result pane) |
| text.lines | Line Tools | TEXT | Sort, de-duplicate, reverse or clean up lines | text.lines → Apply |
| text.regex | Regular Expression Tester | TEXT | Matches and replacements for a JavaScript regex | text.regex → Run |
| text.compare | Text Diff | TEXT | Line-by-line differences between two texts | compare → Compare |
| web.url-parser | URL Parser | WEB & SECURITY | The query parameters of a URL, as JSON | url.parse-query → Parse |
| security.jwt | JWT Decoder & Verifier | WEB & SECURITY | Header, payload and signature of a JSON Web Token | security.jwt → Decode |
| identity.uuid | UUID Generator | GENERATE | UUID v1, v3, v4 and v5, or decode one | identity.uuid.generate → Generate · identity.uuid.decode → Decode |
| media.qr | QR Code Generator | GENERATE | A QR code image for any text | media.qr → Generate |
| media.qr-reader | QR Code Reader | GENERATE | The text inside a QR code image | media.qr-reader → Read |
| generate.examples | Example String Generator | GENERATE | Sample names, emails, URLs, words and paragraphs | generate.examples → Generate |

The escaping package's `text.json-string` and `text.url` are served by the native engine
and never shown from the package; their manifest entries still follow the table.

## Operation buttons

The shell shows operation buttons only when the tool has two or more operations, or
its single operation runs only on request (`explicit` without `inputChange`). A single
operation that already runs as you type gets no button.

## Options

- Labels are sentence case ("Ignore case", "Preserve comments"). Choice labels too,
  except identifiers that are themselves the value (camelCase, PascalCase, UPPERCASE).
- A label says what the value does when the name alone does not:
  - `time.unix` `milliseconds-from-digits` → "Milliseconds when at least N digits"
  - `media.qr-reader` `try-harder` → "Try harder (slower)"
  - `media.qr` `version` → "Version (0 = automatic)", `cell-size` → "Cell size (px)"
  - `text.regex` flags → "All matches (g)", "Ignore case (i)", "Multiline (m)", "Dot matches newline (s)", "Unicode (u)", "Sticky (y)"
  - `text.html` `context` choices → "In text", "In an attribute"
  - `time.unix` `interpretation` choice `rfc` → "RFC 5322 / HTTP date"
  - `encoding.hex` `case` choices → "Lowercase", "Uppercase"
  - `text.lines` `ignore-whitespace` → "Ignore surrounding whitespace"
  - `convert.jsx` `svg-attributes` choices → "camelCase", "As written"
- **Options that the current mode ignores are hidden**, with the contract's
  `rules: [{ "effect": "visible", "when": { "kind": "predicate", "optionId": …, "operator": "equals" | "in", "value": … } }]`:
  - `encoding.hex`: case, separator, bytes-per-line when mode = encode
  - `encoding.base64-text`: error-policy when mode = decode
  - `text.lines`: order, compare when action = sort; ignore-case, ignore-whitespace when action = dedupe
  - `text.regex`: replacement when mode = replace
  - `identity.uuid`: namespace, name when version in [v3, v5]
  - `text.html`: numeric, prefer-named, encode-everything, allow-unsafe-symbols when mode = escape; strict, context when mode = unescape
  - `time.unix`: milliseconds-from-digits when interpretation = auto
  - `text.case`: acronyms when preserve-acronyms = true
  - `convert.jsx`: component-name when wrap = component
- A minify operation declares only the options minifying uses: `preserve-comments` for
  CSS, HTML and XML (XML keeps `collapse-empty` and `trim-text` too); JavaScript already
  has only `preserve-comments`. Indentation and wrapping options belong to beautify only.

## Result pane

- Subtitle: "Updates as you type" for a tool that runs on input; "Press Format or Minify
  to run" (the operation titles) for one that runs on request.
- One metrics line: `In 29 B · Out 40 B · 1 ms`. Whether a file's bytes or the text
  was read goes into Operation details, not the metrics.
- Inspect-style results (Text Inspector, CSV Inspector, JSON Validate) show their
  findings as a key/value list in the OUTPUT area, never "review the operation details".
- One OUTPUT label (the section label); the badge in the header goes.
- Actions: "Copy" (or "Copy SVG" / "Copy image"), "Open as tab", "Save…".
- A tool gated by validation (cURL to Code with non-cURL text) shows the reason as the
  result state and drops the stale result; nothing stays marked "Updating…".

## Shell chrome

- No ⌘ anywhere: the brand is the wordmark "DevTools Pro"; the command button reads
  "Commands" with the kbd "Ctrl K".
- One privacy statement: the "Local only" pill in the top bar. Remove "Files stay on your
  computer", "Editable documents · Local processing", "Separate result · Source stays
  intact", "Processed locally", "Each tab keeps its own tool and result".
- Empty document: heading "No document open", text "Create a document or open a file,
  then choose a tool." Empty result: "No result yet" / "Choose a tool to see its result
  here."
- Status bar: "Ready" once the engine is connected; with no document, "Ready · Ctrl+N
  for a new document". Engine indicator text: "Local".
- Tool header: eyebrow = group, title = name, subtitle = description. The centre of the
  top bar shows the active document's name, or "DevTools Pro".
- Tab names count per tool ("UUID Generator 2" only when a second UUID tab exists).
- Generators whose active operation reads no document (UUID Generate, Example Strings)
  show no editor: an input message says "Generated from the options above; there is no
  input.", with Clipboard and Clear hidden. Operations that read the document (UUID
  Decode, QR Code Generator, Unix Timestamp) keep the editor.
- An image tool is one whose input port declares image content (`media.qr-reader`,
  `encoding.image-base64`), decided from the manifest, never from the label. With no
  document open it opens the file picker; in a text tab it shows "This tab does not
  contain an image. Open a PNG or JPEG image to use <tool>." with the Open compatible
  file… button, and its operation button is disabled.
- Command palette: New document, Open file, Save, Save as…; "Switch to <tab>" per open
  tab; each tool once (applied to the active tab, or a new tab when none is open).
- Text Diff: no Word/Character granularity buttons until the engine has them.
- Find & Replace: the match-case checkbox is labelled "Match case".
- Document info: Size shows the byte length of an unsaved document's text.

## Native results

- Hash Generator: the output document is the digest in hex, nothing else. No temp path
  anywhere in the result or summary. Summary: "SHA-256 · 3 bytes".
- CSV Inspector: summary lists rows, columns, delimiter and whether a header row was
  assumed, as key: value lines. JSON Validate: "valid JSON" plus size and depth.
- JSON errors read "invalid JSON at line L, column C: <what was expected>" with the
  position once.
