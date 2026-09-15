# Bundled example plugin

This package is the smallest discovery and headless execution proof. Its
`plugin.json` points to the canonical manifest, processor, and optional
frontend entrypoint. The processor uses only the SDK context and can be run
without Tauri:

```text
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins
```

The equivalent pnpm command is `pnpm --dir packages/plugin-sdk headless ../../plugins`.

Adding a bundled package follows the same shape: add a directory under
`plugins/`, provide the descriptor and v2 manifest, and run the discovery
generation command documented in `packages/plugin-discovery/README.md`.
