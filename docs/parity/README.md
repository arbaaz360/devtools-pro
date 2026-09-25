# Parity audit summary

Per-card gap reports against `docs/DEVUTILS_REQUIREMENTS.md`. No code,
manifest, fixture or test changes were made in producing these audits —
see `docs/packets/` for the packet that produced each batch of cards.

| Card | Tool id | Met | Partial | Missing | n/a (shell) | Most significant gap |
|---|---|---|---|---|---|---|
| [DU-01](DU-01.md) Unix Timestamp Converter | `time.unix` | 25 / 0 / 1 / 5 | No common-date parsing beyond ISO 8601 (local time was added in #148). |
| [DU-03](DU-03.md) RegExp Tester | `text.regex` | 19 / 2 / 4 / 4 | Not ICU (plain ECMAScript `RegExp`); no whitespace/comment (`x`) mode and no real Unicode UAX 29 word boundary, which are the two flavor features the card calls out by name. |
| [DU-04](DU-04.md) JWT Debugger, decode/sign/verify | `security.jwt` | 17 / 1 / 3 / 2 | No signing at all — the card is titled "decode/sign/verify" and only decode/verify exist; there is no private-key input or re-signing workflow. |
| [DU-06](DU-06.md) Base64 String Encoder/Decoder | `encoding.base64-text` | 14 / 0 / 1 / 6 | Fixed in #101 (AG-125): the output port declares `useAsInput`. |
| [DU-07](DU-07.md) Query String Parser / URL Parser | `web.url-parser` | 14 / 0 / 0 / 3 | None found — every Required/Acceptance row is `met`; the only non-`met` rows are legitimately presentation or out of processor scope. |
| [DU-09](DU-09.md) Backslash Escaper/Unescaper | `text.backslash` | 14 / 0 / 0 / 1 | None found — every Required/Acceptance row is `met`. |
| [DU-10](DU-10.md) UUID Generator/Decoder | `identity.uuid` | 24 / 1 / 0 / 3 | The operation's shared trigger config declares `inputChange` with no mode-conditional rule, confirmed in the window: typing while generating fails with "UUID must be canonical". AG-126 splits it into two operations. |
| DU-11 HTML Preview | `preview.html` | 5 | 0 | 5 | 6 | No way to ever enable JS/navigation/resource loading — only a permanent "off," not the card's three independent toggles |
| DU-13 HTML beautify/minify | `format.html` | 14 | 0 | 1 | 4 | Cannot format embedded CSS/JS |
| DU-14 CSS beautify/minify | `format.css` | 13 | 0 | 0 | 3 | None |
| DU-15 JavaScript beautify/minify | `format.js` | 8 | 1 | 0 | 1 | Tokenizer misses structural syntax errors |
| DU-16 XML beautify/minify | `format.xml` | 9 | 0 | 0 | 2 | None |
| DU-17 YAML to JSON | `convert.yaml-json` | 15 | 0 | 0 | 2 | None found; aliases/tags/multi-doc are deliberately rejected per the card's own stated policy |
| DU-18 JSON to YAML | `convert.json-yaml` | 12 | 0 | 0 | 2 | None found; every acceptance scenario passed |
| DU-19 Number base converter | `number.base` | 7 | 0 | 0 | 4 | None |
| DU-20 Example string generator | `generate.examples` | 2 | 0 | 0 | 8 | None |
| DU-21 QR Code | `media.qr` | 5 | 1 | 7 | 7 | Fixed in #102 (AG-124): non-ASCII round-trips. A reader exists since #96; templates and watermark remain unbuilt |
| DU-24 HTML/SVG to JSX | `convert.jsx` | 21 | 0 | 0 | 2 | None found; every acceptance scenario passed |
| DU-25 Markdown Preview | `preview.markdown` | 10 | 1 | 1 | 7 | Inherits DU-11's missing JS/navigation/resource-loading toggles; no CSS-free "HTML source" view distinct from "HTML+CSS source" |
| DU-26 SQL Formatter | `format.sql` | 15 | 1 | 3 | 2 | Fixed in #101 (AG-125): `space-4` indents four spaces; PL/SQL `BEGIN`/`IF`/`END` blocks are not restructured |
| DU-27 String Case Converter | `text.case` | 18 | 1 | 0 | 2 | Acronym list is a plain text option, not a structured, resettable list widget |
| **Total** | | **101** | **4** | **16** | **30** | 151 rows across 8 cards |

## Three most significant gaps, packet-wide

1. **`media.qr` corrupts Unicode input.** The vendored encoder takes each
   UTF-16 code unit modulo 256 instead of real UTF-8 bytes, so any
   non-ASCII input (even plain accented Latin text) produces a QR code
   that an independent decoder cannot read back as the original text —
   verified by decoding the processor's own SVG output with the
   repository's vendored `jsQR`.
2. **`format.sql`'s "4 spaces" indent option is a silent no-op.** Selecting
   the manifest's own `space-4` choice produces 2-space output because the
   code only recognizes the undocumented alias `"4"`, not `"space-4"`.
3. **`preview.html`/`preview.markdown` have no script/navigation/resource
   toggle at all.** The card asks for three independently settable,
   default-disabled policies; the actual design is a single permanent
   "always off," so there is no way to exercise the "enabled" half of any
   of the three acceptance scenarios.
