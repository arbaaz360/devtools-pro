# Parity audit summary

One row per audited card. `Rows` is `met / partial / missing / n/a (shell)`
from that card's own table. See each `DU-xx.md` for the full row-by-row
evidence, gaps and "Not covered" sections.

| Card | Tool id | Rows (met/partial/missing/n-a) | Most significant gap |
|---|---|---|---|
| [DU-01](DU-01.md) Unix Timestamp Converter | `time.unix` | 24 / 1 / 2 / 5 | No local-time representation at all — every output is UTC-only, despite the card asking for "local and UTC/ISO representations." |
| [DU-03](DU-03.md) RegExp Tester | `text.regex` | 19 / 2 / 4 / 4 | Not ICU (plain ECMAScript `RegExp`); no whitespace/comment (`x`) mode and no real Unicode UAX 29 word boundary, which are the two flavor features the card calls out by name. |
| [DU-04](DU-04.md) JWT Debugger, decode/sign/verify | `security.jwt` | 17 / 1 / 3 / 2 | No signing at all — the card is titled "decode/sign/verify" and only decode/verify exist; there is no private-key input or re-signing workflow. |
| [DU-06](DU-06.md) Base64 String Encoder/Decoder | `encoding.base64-text` | 14 / 0 / 1 / 6 | The output port has no `useAsInput` export, so the card's "Use as input" action has nothing to bind to (Copy/Save both exist). |
| [DU-07](DU-07.md) Query String Parser / URL Parser | `web.url-parser` | 14 / 0 / 0 / 3 | None found — every Required/Acceptance row is `met`; the only non-`met` rows are legitimately presentation or out of processor scope. |
| [DU-09](DU-09.md) Backslash Escaper/Unescaper | `text.backslash` | 14 / 0 / 0 / 1 | None found — every Required/Acceptance row is `met`. |
| [DU-10](DU-10.md) UUID Generator/Decoder | `identity.uuid` | 24 / 1 / 0 / 3 | The operation's shared trigger config declares `inputChange` with no mode-conditional rule, so whether generate mode is actually explicit-action-only (as the card requires) versus decode's live-port detection is unproven from the manifest alone. |
| **Total** | | **126 / 5 / 10 / 24** (165 rows) | |
