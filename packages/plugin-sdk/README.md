# Bundled plugin SDK

`@devtools/plugin-sdk` provides the processor boundary used by trusted,
build-time bundled packages. Processors receive named readers and output sinks
through `ProcessorContext`; limits, cancellation, clock, randomness, and secret
handles are injected per invocation. The Rust crate exposes the same boundary
for native processors and includes memory test doubles.

Input and output byte/chunk limits are enforced by the context and sinks.
Deadline enforcement belongs to the injected host scheduler; processors should
check cancellation between bounded operations.

Discovery only reads direct child packages under a trusted `plugins/` directory.
Every package has a `plugin.json` descriptor with `apiVersion`, a canonical
contract `manifest`, and a required `processor` entrypoint. Paths are relative
to that package and traversal/symlink escapes are rejected. Manifests are
validated with `packages/plugin-contract`; package IDs and catalog order are
deterministic. This is bundled/build-time discovery; it never downloads or
installs code.

Run the headless proof from the repository root with Node directly:

```text
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins
```

If pnpm is installed, the equivalent package-script command is:

```text
pnpm --dir packages/plugin-sdk headless ../../plugins
```

It discovers `examples.echo`, invokes its processor, and prints the complete
output artifact handle. Generate native/frontend composition before a build with
`cargo run -p devtools-plugin-discovery -- generate plugins target/generated/plugins`.
The generated files are disposable build outputs and must not be hand edited.
