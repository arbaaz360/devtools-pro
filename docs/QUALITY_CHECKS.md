# Quality checks

Run the repository gate from the checkout root:

```powershell
node scripts/quality-gate.mjs
```

It generates missing acceptance fixtures (preserving existing files), runs the full Rust workspace tests including native host and large-file acceptance tests, builds the desktop TypeScript/Vite bundle, runs the shell registry/lifecycle tests, checks that the built `index.html` has only relative and existing CSS/JavaScript asset references, verifies the shell's required flex layout declarations in the emitted stylesheet, builds the CLI, runs an inspect/minify/reopen CLI smoke with source immutability, builds the desktop executable and runs the native suite (`scripts/native-suite.mjs`), and runs `git diff --check`. Every failed command exits nonzero. The Windows CI runner matches the currently supported native build.

## The native suite

`scripts/native-suite.mjs` launches the built executable, connects to its webview over
WebView2's debugging port and drives the shipped window: about 40 checks covering
start-up and the catalog, the editor and the result pane, and one end-to-end run per
tool. It is the only layer where a package manifest meets the UI — where an option a
manifest declares becomes a control, and a trigger policy becomes the difference
between running as you type and waiting for a button.

```powershell
node scripts/native-suite.mjs             # every check (about a minute)
node scripts/native-suite.mjs --smoke     # start-up subset
node scripts/native-suite.mjs --only TL-  # by id
```

Check ids match [MANUAL_TEST_PLAN.md](MANUAL_TEST_PLAN.md), so a failure names the case
a human would otherwise run by hand. Expected values are computed independently — node's
crypto, an RFC constant, a second parse — never recorded from the app's own output: a
golden taken from the thing under test proves it is stable, not that it is right.
`apps/desktop/test-results/native-suite.json` holds the run; on CI the workflow keeps it
with the executable's log and a screenshot when the suite fails.

The gate also runs every plugin package's own tests (`plugins/*/test.mjs`, JavaScript processors on the plugin SDK) one package at a time, so a merged package cannot regress unnoticed. To run them standalone, optionally against another plugins root:

```powershell
node scripts/test-plugins.mjs
node scripts/test-plugins.mjs <plugins root>
```

The layout check protects the native Tauri window from rendering as an unstyled document. It requires `.app-shell`, `.app-body`, `.sidebar`, and `.workspace` to retain their built flex declarations; checking the built output catches asset pipeline and packaging regressions as well as stylesheet edits.

The current Rust baseline has not been reformatted as a dedicated change. The gate reports whether `rustfmt` is installed but does not treat formatting as passing or failing until that baseline work is completed, so it does not hide existing formatting debt or add unrelated formatting churn to worker changes.

To inspect the native package locally after dependencies are installed:

```powershell
pnpm --dir apps/desktop tauri build --debug --no-bundle
```

The Cargo workspace executable is produced at `target/debug/devtools-desktop.exe` on Windows. For an iterative native preview, run `pnpm tauri dev` from `apps/desktop`.

## Performance baseline

The streaming benchmark is not part of the gate; it is run by hand when the core changes and its committed result lives in [benchmarks/baseline.md](../benchmarks/baseline.md). It needs no network access and uses the same fixture generator as the gate, so a clean checkout can run it after the gate's own prerequisites are installed:

```powershell
pwsh -NoProfile -File benchmarks/generate-corpus.ps1 -CsvMiB 50
cargo build --release -p devtools-cli
pwsh -NoProfile -File benchmarks/run-streaming.ps1 -Runs 5 -Warmups 1 -IncludeTransform
pwsh -NoProfile -File benchmarks/validate-results.ps1
```

The harness fails instead of reporting when the CLI stops matching its documented output contract (summary keys, exit codes, JSON error codes), when a fixture's SHA-256 differs from `benchmarks/fixtures/manifest.json`, or when a cancelled transform leaves an output or `.partial-` file behind. Generated fixtures and reports stay ignored by git. Refresh `benchmarks/baseline.md` from the Markdown summary the run writes, and keep its caveats: warm cache, polled memory, startup-inclusive cancellation overshoot, and core-only scope. See [benchmarks/README.md](../benchmarks/README.md) for the cases, contract and report schema.
