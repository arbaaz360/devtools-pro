# Parity audit summary

Per-card gap reports against `docs/DEVUTILS_REQUIREMENTS.md`. No code,
manifest, fixture or test changes were made in producing these audits —
see `docs/packets/` for the packet that produced each batch of cards.

| Card | Tool id | Met | Partial | Missing | n/a (shell) | Most significant gap |
|---|---|---|---|---|---|---|
| DU-11 HTML Preview | `preview.html` | 5 | 0 | 5 | 6 | No way to ever enable JS/navigation/resource loading — only a permanent "off," not the card's three independent toggles |
| DU-17 YAML to JSON | `convert.yaml-json` | 15 | 0 | 0 | 2 | None found; aliases/tags/multi-doc are deliberately rejected per the card's own stated policy |
| DU-18 JSON to YAML | `convert.json-yaml` | 12 | 0 | 0 | 2 | None found; every acceptance scenario passed |
| DU-21 QR Code | `media.qr` | 5 | 1 | 7 | 7 | Generator silently corrupts non-ASCII text (no real UTF-8 encoding); no reader, templates or watermark exist yet |
| DU-24 HTML/SVG to JSX | `convert.jsx` | 21 | 0 | 0 | 2 | None found; every acceptance scenario passed |
| DU-25 Markdown Preview | `preview.markdown` | 10 | 1 | 1 | 7 | Inherits DU-11's missing JS/navigation/resource-loading toggles; no CSS-free "HTML source" view distinct from "HTML+CSS source" |
| DU-26 SQL Formatter | `format.sql` | 14 | 1 | 3 | 2 | The manifest's own "4 spaces" indent choice (`space-4`) silently no-ops to 2 spaces; PL/SQL `BEGIN`/`IF`/`END` blocks are not restructured |
| DU-27 String Case Converter | `text.case` | 18 | 1 | 0 | 2 | Acronym list is a plain text option, not a structured, resettable list widget |
| **Total** | | **100** | **4** | **16** | **30** | 150 rows across 8 cards |

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
