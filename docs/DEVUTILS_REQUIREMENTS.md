# Minimum tool and UX requirements

Reviewed 2026-09-15 from the user's local DevUtils documentation archive. All **27 supplied pages** and **51 non-icon tool screenshots** were inspected. The archive includes different DevUtils versions and both light and dark screenshots. Our required shell remains charcoal/dark with Windows controls; functional options and interaction patterns are the baseline.

Source root: `F:/IDM/Softwares/devutils-local-complete-with-guide/devutils.com/docs/`. Each source below is `<slug>/index.html`. [Source inventory](references/devutils-sources.json) contains absolute paths, original URLs, SHA-256 hashes, headings and image ordinals. `image 0` means the first tool image in the page, excluding website navigation; the repeated 48 px status icon is not a tool screenshot. Images remain in the local archive, not in the product bundle.

Status legend: **partial** means a related implementation exists, not parity; **planned** means no corresponding complete workbench tool is established by this audit. No entry below is marked parity-complete. Each entry's Required, UX, and Acceptance paragraphs are separate acceptance obligations. Cross-cutting UX requirements are in [PLUGIN_SYSTEM_DESIGN.md](PLUGIN_SYSTEM_DESIGN.md#shared-workspace-vocabulary-and-ux-contract).

## Status, verified 2026-09-20

Kept current by the integrator when a packet merges. "Usable" means the tool
runs in the desktop app; it is not a parity sign-off against the card below.
Engine: **rust** is a native executor in the host, **js** is a v2 package on
the webview worker engine (see
[PLUGIN_HOST_IMPLEMENTATION.md](PLUGIN_HOST_IMPLEMENTATION.md#the-webview-worker-engine)).

| ID | Tool | Tool id | Engine | State |
|---|---|---|---|---|
| DU-01 | Unix timestamp converter | `time.unix` | js | usable |
| DU-02 | JSON formatter/validator | `structured.json` | rust | usable |
| DU-03 | RegExp tester | `text.regex` | — | planned, needs shell work |
| DU-04 | JWT decode/verify | `security.jwt` | js | usable |
| DU-05 | URL encode/decode | `text.url` | rust | usable |
| DU-06 | Base64 text | `encoding.base64-text` | js | usable |
| DU-07 | URL / query parser | `web.url-parser` | js | usable |
| DU-08 | HTML entities | `text.html` | rust | usable |
| DU-09 | Backslash escaping | `text.backslash` | js | usable |
| DU-10 | UUID generate/decode | `identity.uuid` | js | in review (AG-106, PR #56) makes it browser-safe |
| DU-11 | HTML preview | — | — | planned, needs shell work |
| DU-12 | Text diff | `text.compare` | rust | usable |
| DU-13 | HTML beautify/minify | `format.html` | js | usable |
| DU-14 | CSS beautify/minify | `format.css` | js | packet ready (AG-113) |
| DU-15 | JavaScript beautify/minify | `format.js` | js | packet ready (AG-115); beautify via vendored `js-beautify` 2.0.3 (`packages/vendor/`), minify is comment and whitespace removal |
| DU-16 | XML beautify/minify | `format.xml` | js | packet ready (AG-112) |
| DU-17 | YAML to JSON | `convert.yaml-json` | js | usable |
| DU-18 | JSON to YAML | `convert.json-yaml` | js | usable |
| DU-19 | Number base converter | `number.base` | js | usable |
| DU-20 | Example string generator | `generate.examples` | js | usable |
| DU-21 | QR code | — | — | planned, needs shell work |
| DU-22 | String inspector | `text.inspect` | rust | usable, parity gaps unaudited |
| DU-23 | Hash generator | `encoding.hash` | rust | usable (SHA-256/512; MD5, SHA-1, SHA-224, SHA-384 only in the package) |
| DU-24 | HTML/SVG to JSX | — | — | planned, needs shell work |
| DU-25 | Markdown preview | — | — | planned, needs shell work |
| DU-26 | SQL formatter | `format.sql` | js | packet ready (AG-111) |
| DU-27 | String case converter | `text.case` | js | usable |

Usable: 16 of 27. In review: 1. Packets ready: 4. Needs shell
work: 5. Beyond these 27, the wider catalogue is in
[PARITY_AND_BUILDING_BLOCKS.md](PARITY_AND_BUILDING_BLOCKS.md).

## DU-01 — Unix Timestamp Converter

Source: `unix-timestamp-converter`; images 0, 2. Status: planned. Workspace: linked fields/property list. Proposed tool: `time.unix`.

**Required:** seconds and milliseconds since epoch, ISO date input, documented common-date parsing; Now; local and UTC/ISO representations, relative time, epoch value, day/week of year, leap-year status. The main screenshot also advertises arithmetic `+ - * /`; support a bounded arithmetic grammar for numeric timestamps, never evaluation of arbitrary code.

**UX:** single input with explicit interpretation selector; individually copyable output rows. Configurable auto-detection range and reset. Relative time may tick while visible; a captured clock makes conversions testable. Tab activation must not overwrite input with Now.

**Acceptance:** epoch zero, negative values, millisecond precision, leap days, timezone/DST boundaries, ambiguous dates, invalid arithmetic and out-of-range values. Explicit units override heuristics. The description's calendar dates disagree with the displayed default bounds; use literal configured values and calculated labels, not copied prose.

## DU-02 — JSON Formatter/Validator

Source: `json-formatter-validator`; images 0, 2, 3. Status: partial (`structured.json`). Workspace: transform with annotations.

**Required:** validate, format with 2 spaces/4 spaces/one tab, minify; optional comments and trailing commas; highlighted code. Earlier user reference also showed JSONPath: retain it as an additional requirement with its own query/match output and limits.

**UX:** editable input and immediate formatted output, Clipboard/Sample/Open/Clear, per-tool detection setting, output formatting controls, clickable diagnostics selecting source errors. Format/Minify/Validate commands should not be duplicated in an operation dropdown. Indentation selection is a distinct setting.

**Acceptance:** valid and malformed input, comments/trailing commas independently of strict mode, large numbers/lexemes, Unicode offsets, incomplete edits, bounded previews, full copy/save. JSONPath must have explicit dialect and error behavior before parity is claimed.

## DU-03 — RegExp Tester

Source: `regexp-tester`; images 0, 2, 3. Status: planned. Workspace: annotated editor plus capture tree and report. Proposed tool: `text.regex`.

**Required:** ICU behavior; pattern and sample document inputs; live matches and capture groups; case-insensitive, whitespace/comments, dot-all, multiline anchors and Unicode UAX 29 word-boundary flags. Report expression supports a delimiter, `$0`/`$&`, `$1`–`$9`, named captures, newline and tab substitutions.

**UX:** load/paste sample text, inline highlights, previous/next match and count, expandable searchable match/group tree, copyable generated report. Empty/no matches is a useful normal result.

**Acceptance:** Unicode, named/unmatched groups, zero-width matches, substitutions, malformed patterns, stale selections and adversarial backtracking. Engine name/version and syntax differences are visible. A platform-default or Rust regex engine is not accepted as ICU parity without conformance evidence. Timeout must be enforceable by the selected runner.

## DU-04 — JWT Debugger, decode/sign/verify

Source: `jwt-debugger-decode-sign-verify`; images 0, 2. Status: planned. Workspace: linked code editors and sensitive fields. Proposed tool: `security.jwt`.

**Required:** HS256/384/512, RS256/384/512, ES256/384/512, PS256/384/512; decode token/header/payload; symmetric secret or public/private keys according to algorithm; signing and verification offline.

**UX:** segmented token highlighting, editable header/payload/key fields, samples and separate copy actions, prominent signature status and detection preference. The reference re-signs edited fields: implement a clear signing workflow with derived-update origin tracking. Pasting a token must verify that incoming token without silently re-signing it.

**Acceptance:** each algorithm family, wrong key, mismatched algorithm, malformed segments/JSON, unsupported algorithms, expired claims distinct from signature validity, rapid token/field edits. Secrets never appear in logs, persistence or ordinary provenance. The guide's opening reference to detecting JSON is contradicted by its JWT-specific settings; use well-formed JWT detection.

## DU-05 — URL Encoder/Decoder

Source: `url-encoder-decoder`; images 0, 2. Status: partial (`text.url`). Workspace: transform, stacked or side-by-side.

**Required:** encode/decode; RFC3986 and form-data modes; form spaces may use `+` (visible in settings image). Keep mode-specific reserved-character behavior explicit.

**UX:** immediate output, Clipboard/Sample/Clear, Copy and Use as input, detection of decodable text with disable/reset setting. Use as input is one undoable document transaction, not a disk write.

**Acceptance:** spaces, literal plus, reserved symbols, Unicode/UTF-8, repeated encoding and malformed percent sequences. Form and URI modes must differ where intended; no accidental double decode.

## DU-06 — Base64 String Encoder/Decoder

Source: `base64-encoder-decoder`; images 0, 2. Status: planned as a string tool; existing image codecs do not satisfy it. Proposed tool: `encoding.base64`.

**Required:** text encode/decode, UTF-8 output validation, complete copying. Settings image restricts detection to Base64 that decodes to UTF-8. Binary output should be identified and offered to compatible tools/export instead of displayed as junk.

**UX:** Encode/Decode selector, input above output or remembered split; Clipboard/Clear/Copy/Use as input, detection disable/reset. Image/Base64 tools remain separately discoverable.

**Acceptance:** ASCII, Unicode, empty and multiline inputs, padding/alphabet errors, non-text bytes, full payload beyond 64 KiB, and explicit policy for whitespace/unpadded/URL-safe variants. Those variants must not be silently inferred as reference behavior where unspecified.

## DU-07 — Query String Parser / URL Parser

Source: `query-string-parser`; images 0, 2. Status: planned. Proposed tool: `web.url-parser` with Query String Parser search alias.

**Required:** query or full URL input, JSON output, repeated keys represented as arrays, array parameter support. Reference says detection requires at least two query variables; manual selection must still parse one.

**UX:** paste/sample/clear, highlighted JSON with Copy and detection/reset preference. URL Parser is the renamed label; do not confuse it with URL encoding.

**Acceptance:** duplicate keys preserving order, blank values, encoded delimiters/plus, fragments, malformed escaping, bracketed names and array notation. Establish fixtures for ambiguous nesting/bracket semantics instead of inventing reference behavior. The screenshot alone does not establish a full URL-components editor; track extra component parsing separately.

## DU-08 — HTML Entity Encoder/Decoder

Source: `html-entity-encoder-decoder`; images 0, 2. Status: partial (`text.html`). Workspace: transform.

**Required:** encode/decode named and numeric references; unsafe-symbol handling, decimal versus hex numeric escapes, encode-everything, prefer named references, strict HTML5 decoding. Conditional option precedence is visible: encode-everything overrides skip-unsafe behavior; named references supersede numeric choice where available.

**UX:** immediate copyable output and Use as input; settings explain each switch; detection preference/reset. A settings panel must not display contradictory active controls.

**Acceptance:** non-ASCII, astral characters, named/numeric references, invalid numeric values, strict versus permissive input, option combinations and literal ampersands. Encoding is not an HTML renderer operation.

## DU-09 — Backslash Escaper/Unescaper

Source: `backslash-escaper-unescaper`; image 0. Status: partial related Unicode/JSON escaping, dedicated parity unverified. Proposed tool: `text.backslash`.

**Required:** escape/unescape special characters such as newline and tab in logs and strings; define exact grammar independently of HTML entities or a quoted JSON string literal.

**UX:** operation selector, clipboard/sample/clear, immediate output, Copy and repeated Use as input. User-requested JSON escape/unescape remains a distinct capability.

**Acceptance:** backslashes, quotes, control characters, Unicode escapes, incomplete escape and literal versus interpreted sequences. Confirm unspecified escape grammar with a fixture investigation; do not implement by evaluating source code.

## DU-10 — UUID Generator/Decoder

Source: `uuid-generator-decoder`; images 0, 2, 3. Status: planned. Proposed tool: `identity.uuid`.

**Required:** decode canonical string, raw bytes, version and variant; time, clock ID and node for time-based UUIDs. Generate v1/v3/v4/v5, batch count, lower/uppercase. v3/v5 require namespace/name and yield identical IDs for identical inputs. Namespace presets DNS/URL/OID/X500 and Random are visible in the screenshots.

**UX:** decoder property list alongside generation form; conditional namespace/name fields, Generate/Copy/Clear, per-field copy, sample random UUID, detection/reset. Generation occurs only on explicit action.

**Acceptance:** version/variant fields, known v3/v5 vectors, duplicate deterministic batches, output count/case, invalid namespace/count, bounded batches, randomness/clock injection. Later ULID/newer UUID versions extend this baseline rather than replace v1/v3/v4/v5.

## DU-11 — HTML Preview

Source: `html-preview`; images 0, 2. Status: planned. Proposed tool: `preview.html`.

**Required:** live HTML/CSS rendering; optional JavaScript, navigation and outgoing-resource loading as three independent settings, default disabled. Reload and reset. Reference mentions inspect-element behavior: provide preview-scoped developer inspection when the host supports it.

**UX:** source editor beside rendered page, clipboard/sample/clear, clear policy controls; content fills preview area. Rendered content cannot style the application shell.

**Acceptance:** static styles, malformed markup, scripts disabled/enabled, blocked remote images/CSS/fetch/navigation, revocation, frame teardown, no app bridge/storage/source-file access. Enabling scripts does not automatically enable network or native privileges.

## DU-12 — Text Diff Checker

Source: `text-diff-checker`; image 0. Status: partial (`text.compare`). Workspace: two input editors above a result drawer or remembered alternate split.

**Required:** character/word/line modes; Swap Inputs; visual rich-text diff, HTML export and Minimal diff representation; previous/next change and count.

**UX:** each input has its own file/clipboard/sample/clear actions. Result views are purposeful; raw internal JSON is not the default. Formatted copy supplies rich HTML and a plain-text fallback. Source editors are not squeezed into one of two generic source/result halves.

**Acceptance:** insertion/deletion/replacement, identical and newline-only inputs, Unicode, swapping labels/parents, every granularity, rich clipboard/export, navigation and bounded large/high-change inputs. Minimal diff is described as only similar to UniDiff; exact encoding requires additional fixtures. Do not label ordinary unified patch as exact reference parity.

## DU-13 — HTML Beautifier/Minifier

Source: `html-beautifier-minifier`; image 0. Status: planned. Proposed tool: `format.html`.

**Required:** 2 spaces, 4 spaces, one tab, minification; incomplete HTML support, embedded CSS/JS, syntax highlighting.

**UX:** editable source, file/clipboard/sample/clear, immediate formatted code, output formatting selector and Copy. This is distinct from HTML Preview.

**Acceptance:** fragments, incomplete tags, embedded scripts/styles, whitespace-sensitive content, comments and encoding. Tolerant beautification must not be advertised as successful validation. Minification must not silently discard meaningful text.

## DU-14 — CSS Beautifier/Minifier

Source: `css-beautifier-minifier`; image 0. Status: planned. Proposed tool: `format.css`.

**Required:** 2/4 spaces, one tab, minify; incomplete CSS and highlighting.

**UX:** source/result editors, Open/Clipboard/Sample/Clear and output Copy. Shared formatter controls with a CSS-specific language identity.

**Acceptance:** incomplete rules, at-rules, custom properties, strings/URLs, comments and whitespace-sensitive expressions. Output is text; no CSS is applied to the workbench.

## DU-15 — JavaScript Beautifier/Minifier

Source: `js-beautifier-minifier`; image 0. Status: planned. Proposed tool: `format.javascript`.

**Required:** 2/4 spaces, one tab, minify; incomplete JavaScript and syntax highlighting.

**UX:** same formatter affordances; indicate recoverable parse problems during incomplete edits. Processor runs off the UI thread.

**Acceptance:** modern supported syntax with explicit version, comments, regex literals, template literals, automatic-semicolon edge cases and incomplete fragments. No input execution; no claim of lossless minification unless semantic fixtures pass.

## DU-16 — XML Beautifier/Minifier

Source: `xml-beautifier-minifier`; image 0. Status: planned. Proposed tool: `format.xml`.

**Required:** 2/4 spaces, one tab, minify; incomplete XML and highlighting.

**UX:** source/result format workflow; diagnostics distinguish tolerant formatting from well-formedness validation.

**Acceptance:** namespaces, declarations, comments, CDATA, mixed content and malformed markup. No external entity/resource fetch. Formatting must preserve meaningful mixed-content whitespace or explain an unsupported operation.

## DU-17 — YAML to JSON

Source: `yaml-to-json-converter`; image 0. Status: planned. Proposed tool: `convert.yaml-json`.

**Required:** valid YAML document to highlighted JSON, 2-space and minified output.

**UX:** YAML source language and JSON result language; Clipboard/Sample/Clear/Copy; switching result formatting preserves the source.

**Acceptance:** nested collections, quoted scalar types, aliases, numeric precision, non-JSON YAML values, duplicate keys and multiple documents. Declare YAML schema/version and conversion policy; limit alias expansion and reject unsupported custom tags rather than constructing arbitrary objects.

## DU-18 — JSON to YAML

Source: `json-to-yaml-converter`; image 0. Status: planned. Proposed tool: `convert.json-yaml`.

**Required:** JSON document to highlighted YAML with appropriate scalar quoting.

**UX:** JSON input and YAML output, clipboard/sample/clear/copy. The guide reuses the opposite converter's screenshot; the written conversion direction governs this tool.

**Acceptance:** null/bool/number/string distinctions, multiline strings, precision and malformed JSON. Test semantic round trip for values representable in both formats; loss of JSON lexical layout is an expected conversion property, not a source edit.

## DU-19 — Number Base Converter

Source: `number-base-converter`; images 0, 2, 3. Status: planned. Proposed tool: `number.base`.

**Required:** simultaneously editable binary/octal/decimal/hex and custom-base fields. The screenshots show base 36 and selectable bases including 6; use 2–36 as the proposed first range and verify unsupported edge semantics.

**UX:** edit any field to update all others, with per-field Clipboard/Clear/Copy. Preserve the active field's caret and intermediate input. No cascading edit loop.

**Acceptance:** exact integers above 2^53, negatives, zero, invalid digits and base changes. Specify signed/fractional/prefix handling rather than guessing it from screenshots. First implementation targets arbitrary-precision integers; any fractional parity requirement needs evidence and explicit design.

## DU-20 — Lorem Ipsum / Example String Generator

Source: `lorem-ipsum-generator`; images 0, 2. Status: planned. Proposed tool: `generate.examples`.

**Required:** paragraph, sentence, word, title, first/last/full name, email, URL, short tweet and long tweet. Click generates once; holding repeats. Append, append-as-line and replace modes; Copy/Clear.

**UX:** compact generator action strip and full-height editable generated text. No mandatory blank source pane. Provide keyboard equivalent for repeat and stop on release/blur/tab close.

**Acceptance:** every category and append mode, deterministic seeded fixtures where applicable, bounded repeated output and undo. Existing text is not erased by a category change; only an explicit generate in Replace mode replaces it.

## DU-21 — QR Code Reader/Generator

Source: `qr-code-generator`; images 0, 2, 3, 4. Status: planned. Proposed tool: `media.qr`.

**Required:** encode text or URL/phone/SMS/email/vCard/event/Wi-Fi templates; typed file/drop/clipboard text input; generate image, dimensions and watermark/icon/logo customization (including scale mode visible in screenshots). Read QR from image file or image clipboard. Save and Copy image.

**UX:** content/form controls and a top-aligned image result; reader action accepts an image without replacing unrelated text implicitly. Remove watermark/icon controls, decoded text output, file actions and image clipboard are available through shared SDK services.

**Acceptance:** template escaping, Unicode, QR capacity errors, malformed/no-code images, output dimensions, logo/watermark removal, read-after-generate and copy/save/reopen. Independently decode generated/customized fixtures; a successful encode call alone does not establish readability. Pixel limits prevent excessive image allocation. Exact watermark placement/scale options need full interaction fixtures where screenshots are ambiguous.

## DU-22 — String Inspector

Source: `string-inspector`; images 0, 2. Status: partial related `text.inspect`; selection/statistical parity is missing.

**Required:** character, byte, word and line counts; word distribution; statistics update for the selected range; ASCII/Unicode details for one character; selection location, line and column. Filter excluded words and case-sensitive distribution (visible in screenshot).

**UX:** editor plus compact property/distribution view. Clearly state whole-document versus selection scope; no empty output editor saying only “valid text.” Filter dialog with reset and per-tab overrides.

**Acceptance:** combining marks, emoji sequences, UTF-8/UTF-16 offsets, CRLF, empty selection, mixed scripts and case/filter changes. Define “character” as grapheme and expose code-point/code-unit counts where useful; single grapheme may yield multiple code points. Chunked large-document statistics and paged distribution must remain bounded.

## DU-23 — Hash Generator

Source: `hash-generator`; image 0. Status: partial (`encoding.hash`, SHA-256/SHA-512 currently).

**Required:** MD2, MD4, MD5, SHA1, SHA224, SHA256, SHA384 and SHA512, with upper/lowercase presentation.

**UX:** results for all eight algorithms visible together as labeled copyable fields. Text/file/drop input; byte count. No separate rerun button per algorithm; changing case is presentation only.

**Acceptance:** known vectors including empty bytes, file versus text byte identity, CRLF, Unicode, full-file streaming, cancellation and individual copy. Legacy algorithms are compatibility/checksum features, not recommendations for password storage or secure signatures.

## DU-24 — HTML/SVG to JSX

Source: `html-to-jsx-converter`; image 0. Status: planned. Proposed tool: `convert.markup-jsx`.

**Required:** HTML and SVG input to JSX, syntax highlighting and folding. Preserve source semantics while mapping JSX-specific attributes, styles and text escaping.

**UX:** source/result editors with Sample/Clipboard/Clear/Copy and language-aware folding. The guide does not enumerate an output-options menu; do not invent exact options from the phrase “change the format.”

**Acceptance:** `class`/`for`, inline style objects, SVG attributes, comments, multiple roots, quotes, braces and malformed input. JSX output is code, never executed as part of conversion.

## DU-25 — Markdown Preview

Source: `markdown-preview`; images 0, 2. Status: planned. Proposed tool: `preview.markdown`.

**Required:** rendered preview, HTML source, HTML+CSS source; syntax highlighting. Open in Browser and refresh-to-see-updates for the generated page.

**UX:** editable Markdown and view selector over the same generated artifact; direct clipboard/sample/clear actions. Export/browser opening is explicit; retain current edits when changing output mode.

**Acceptance:** supported Markdown dialect with fixtures, raw HTML, fenced code, links/images, script attempts, export containing appropriate CSS, updated external preview after refresh. Apply preview policies from DU-11. The guide's JSX sentence is a copy error; it does not change this tool into a JSX converter.

## DU-26 — SQL Formatter

Source: `sql-formatter`; images 0, 2. Status: planned. Proposed tool: `format.sql`.

**Required:** SQL, MySQL, MariaDB, PostgreSQL and PL/SQL; uppercase or original keyword case. Main screenshot also shows indentation (2 spaces); retain shared indentation controls.

**UX:** source/result with dialect, keyword-case, indentation and Copy on output. Language identity follows the chosen dialect; no database connection is needed.

**Acceptance:** dialect-specific quoting/operators/procedural blocks, comments, multiple statements, incomplete queries and case preservation. “Original” must not lowercase identifiers. Explicit engine/dialect versions are part of implementation compatibility.

## DU-27 — String Case Converter

Source: `string-case-converter`; images 0, 2, 3. Status: planned. Proposed tool: `text.case`.

**Required:** camelCase, snake_case, PascalCase, kebab-case, SCREAM-KEBAB, CONSTANT_CASE; configurable preservation of uppercase acronyms/unique names. Screenshot examples: ID, API, DB, URL, HTTP.

**UX:** live result, one output-case selector, copy, editable/resettable acronym list. Preserve line-oriented multiple-name workflow illustrated in the screenshot.

**Acceptance:** acronym/word boundaries, digits, Unicode, punctuation, blank and multiple lines, each target case and acronym toggle. Do not interpret the guide's “snakeCase” typo as a separate convention.

## Existing user requirements beyond these pages

- Image↔Base64 for PNG/JPEG, a real image viewer, complete clipboard round trip, top-aligned media and no text-only input actions on image ports.
- Blank editable tabs, Ctrl+N, per-tab tool state, undo/redo, find/replace, JSON escaping, open/save, multi-file drop and future side-by-side editor mode.
- JSONPath from the earlier requested screenshot; cURL generation and CSV capabilities already present must not disappear during migration.
- Neutral dark theme, accessible Windows shortcuts, future macOS bindings, shared shell UX and progress that does not flash or move the editor.
- Earlier broader DevUtils catalogue in [PARITY_AND_BUILDING_BLOCKS.md](PARITY_AND_BUILDING_BLOCKS.md) remains expansion scope. These 27 pages are the current evidenced minimum, not a reduction of the product ambition.

## Compatibility questions that do not block architecture

Resolve via engine spikes/fixtures before marking the respective tool complete: ICU version/semantics; Minimal diff encoding; the reference's full URL/bracket parser behavior; tolerating incomplete formatters without changing semantics; exact numeric/date ranges; JSX conversion details; Markdown dialect/CSS theme; QR scale/watermark options. The contracts explicitly carry engine versions, options, named outputs and diagnostics so these choices will not require shell redesign.

## Release evidence per requirement

Every tool packet must include reference ID(s), valid and invalid fixtures, boundary/cancellation cases, a per-tab state scenario, complete copy/save tests where relevant, keyboard flow and rendered UI evidence at normal Windows DPI plus scaled/ultrawide layout. Record any deviation and status. A manifest entry, working core function, or screenshot of an empty shell is not sufficient to claim feature/UX parity.
