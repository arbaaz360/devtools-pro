# UUID generator and decoder

This bundled plugin implements the DU-10 proof using only the public
`ProcessorContext` boundary. The operation has no required inputs: an explicit
request generates v1, v3, v4 or v5 UUIDs, with bounded batches (1–100) and
lower/uppercase presentation. DNS, URL, OID and X500 namespace presets are
accepted for v3/v5; a canonical UUID may be supplied on the optional `uuid`
port or selected with `mode: "decode"` to emit version, variant, bytes and
v1 clock/node properties.

The processor reads `request.options` (`mode`, `version`, `namespace`, `name`,
`count`, `case`) and writes a complete newline-delimited artifact to `uuid`,
plus structured properties through the same output port. v4 and v1 use the
injected SDK randomness and clock, so headless fixtures are deterministic.

Run from the repository root:

```text
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins/uuid
node plugins/uuid/test.mjs
```
