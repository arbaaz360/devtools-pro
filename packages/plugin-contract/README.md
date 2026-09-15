# DevTools plugin contract v2

This package is the canonical, versioned wire contract for bundled DevTools plugins. The machine-readable source is [`schema/contract.v2.schema.json`](schema/contract.v2.schema.json). `scripts/generate.mjs` emits the Serde types in [`src/generated.rs`](src/generated.rs) and TypeScript types/schema in [`ts/generated.ts`](ts/generated.ts); generated files are checked with `npm run check:generated` and must never be edited by hand.

The wire validator is schema-driven in both languages. `validateManifest`/`parse_manifest` then apply semantic checks that JSON Schema cannot express: unique IDs, dangling operation/workspace/command/option references, conditional-option references, defaults within exact-string constraints, and sensitive persistence rules. Requested capabilities are an enum and therefore fail closed. Requests contain host-scoped document/artifact/secret handles and requested limits only; effective grants are deliberately absent from the plugin payload.

Lengths, byte offsets, revisions, generations, counters, and arbitrary-precision integers are decimal strings. Presentation settings live under a workspace and are separate from operation options. Secret options and secret handles are session-only and are never represented as persisted values, diagnostics, or provenance material. Outputs identify complete artifacts separately from bounded previews and carry representation, export, sensitivity, diagnostics, event identity, and provenance metadata.

`normalize_v1`/`normalizeV1` accepts the existing v1 manifest shape and emits v2 with the original tool and operation IDs unchanged, a single `input` document port, and a single `output` text artifact. It is a compatibility adapter, not a second catalog. New required-field or semantic incompatibilities require a new API major (`devtools.plugin/v3`); optional extension metadata may be added under `extensions` and unknown extension keys are intentionally opaque. Removing or changing a required field, changing a port kind/cardinality, changing option value representation, or changing event identity requires a major version. Additive optional fields remain v2-compatible.

The fixture set includes JSON formatting, two-source diff and selection, no-input UUID generation, linked JWT/number fields with sensitive key handles and large decimal values, QR image/template inputs, HTML preview permissions, completed events, and v1 normalization. `representative.json` is a request fixture; `manifest-comprehensive.json` declares all 27 requirement IDs and maps them to the contract's port, option, workspace, capability, representation, lifecycle and provenance fields. Engine-specific choices remain explicit in executor `engine`, `engineVersion`, `syntax`, limits and diagnostics; this package does not claim algorithm or renderer parity.

Run the checks from this directory:

```text
npm run check:generated
npm test
cargo test -p devtools-plugin-contract
```

`cargo fmt --check` could not be run on the development host because the installed Rust toolchain does not include `rustfmt`; this does not affect compilation or tests.
