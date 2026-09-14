# Quality checks

Run the repository gate from the checkout root:

```powershell
node scripts/quality-gate.mjs
```

It runs Rust workspace library tests (integration acceptance tests require generated large fixtures), builds the desktop TypeScript/Vite bundle, checks that the built `index.html` has only relative and existing CSS/JavaScript asset references, verifies the shell's required flex layout declarations in the emitted stylesheet, runs an inspect/minify/reopen CLI smoke with source immutability, and runs `git diff --check`. Every failed command exits nonzero.

The layout check protects the native Tauri window from rendering as an unstyled document. It requires `.app-shell`, `.app-body`, `.sidebar`, and `.workspace` to retain their built flex declarations; checking the built output catches asset pipeline and packaging regressions as well as stylesheet edits.

The current Rust baseline has not been reformatted as a dedicated change. The gate reports whether `rustfmt` is installed but does not treat formatting as passing or failing until that baseline work is completed, so it does not hide existing formatting debt or add unrelated formatting churn to worker changes.

To inspect the native package locally after dependencies are installed:

```powershell
pnpm --dir apps/desktop tauri build --debug --no-bundle
```

The executable is produced under `apps/desktop/src-tauri/target/debug/`. For an iterative native preview, run `pnpm tauri dev` from `apps/desktop`.
