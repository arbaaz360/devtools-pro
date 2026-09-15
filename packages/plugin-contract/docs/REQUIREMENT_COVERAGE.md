# Requirement coverage map

The contract records requirement IDs in `TestDeclaration.requirementIds`; this is the foundation mapping used by package discovery and conformance tooling. It does not claim that the 27 processors are implemented.

| Cards | Contract feature exercised |
| --- | --- |
| DU-01, DU-19 | linked fields, exact decimal-integer options, guarded trigger origin/revision vectors |
| DU-02, DU-05, DU-06, DU-08, DU-09, DU-13–DU-18, DU-24, DU-26, DU-27 | transform workspace, named document/value ports, typed options, code/text representations, diagnostics and complete exports |
| DU-03, DU-22 | selection refs with UTF-8 byte spans/epochs, annotation and property representations, bounded limits |
| DU-04 | sensitive secret handles, linked fields, origin/revision vectors, independent report outputs, nonpersistent secret state |
| DU-07 | named query/document ports and table/tree/property output representations |
| DU-10, DU-20 | zero-input and explicit/held-repeat triggers, many output cardinality, deterministic/randomness context |
| DU-11, DU-25 | preview document representation, independent scripts/network/navigation capabilities, external-browser export |
| DU-12 | two named document ports, diff representation and selection diagnostics |
| DU-21 | value/template/image inputs, image output, MIME and pixel limits, typed image export |
| DU-23 | complete text outputs, streaming/chunk limits, engine/provenance and presentation-only settings |

All cards are included in the representative manifest's `TestDeclaration`. Gaps such as ICU regex semantics, SQL/Markdown dialect versions, QR watermark placement, exact date bounds, JSX details, and minimal-diff encoding are intentionally carried as engine/version/fixture decisions for later tool packets.
