# Bundled plugin discovery

`devtools-plugin-discovery` is the build-time scanner for the trusted
repository `plugins/` directory. It sorts package directories and catalog IDs,
validates each descriptor and canonical `devtools.plugin/v2` manifest through
`devtools-plugin-contract`, rejects traversal and symlink escapes, and reports
the package, field, and reason for every failure. Duplicate IDs are fatal so a
release cannot silently omit a first-party package.

Generate disposable composition artifacts before frontend/native builds:

```text
cargo run -p devtools-plugin-discovery -- generate plugins target/generated/plugins
```

The command writes a catalog, frontend registration source, native executor
descriptors, and a processor import map. It never installs or downloads code;
adding a bundled package means adding its folder and rerunning this build step.
