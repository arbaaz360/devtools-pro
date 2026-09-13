# Performance spike

The first benchmark gate measures the Rust core before selecting a desktop shell. The harness launches a fresh executable for each sample, captures stdout/stderr without a shell pipeline, samples the child process working set, verifies the CLI's reported input size, and writes raw per-run data to `benchmarks/results/` (ignored by git).

Generate the deterministic corpus (the existing `fixture-50mb.json` and `fixture-250mb.json` files are preserved):

```powershell
pwsh -NoProfile -File benchmarks/generate-corpus.ps1 -CsvMiB 50
```

After building the release CLI, run five measured samples after one discarded warm-up:

```powershell
cargo build --release -p devtools-cli
pwsh -NoProfile -File benchmarks/run-streaming.ps1 -Runs 5 -Warmups 1
```

Add `-IncludeTransform` to measure minification to a file. The command reports median, minimum, maximum, and observed memory; the JSON report retains every sample and fixture hash. The results are warm-cache fresh-process measurements. Windows does not provide a reliable portable way to clear the file cache, so they must not be described as cold-start numbers. `PeakWorkingSet64` is the OS-reported peak; sampled private bytes can miss short-lived allocations. Five runs are deliberately reported as median and range rather than a misleading p95.

The acceptance targets are documented in `DevTools Product Plan.md`. This harness measures the core CLI only; it says nothing about WebView startup, first paint, typing latency, accessibility, or desktop-shell memory.

## Offline acceptance checks

Run the repeatable core and shell checks after building the CLI:

```powershell
cargo test -p devtools-core --test acceptance
pwsh -NoProfile -File benchmarks/smoke-shell.ps1
```

The acceptance test reads the checked-in valid/invalid JSON and 50/250 MiB
fixtures, verifies malformed UTF-8 and cancellation, caps previews at 64 KiB,
checks progress, confirms temporary-result cleanup, and verifies source-byte
immutability. The smoke script covers open/automatic inspect, minify to a saved
copy, reopen, and invalid-input failure. Both checks are offline and report
failure rather than making performance claims.

`generate-corpus.ps1` also writes a manifest with SHA-256 hashes and adversarial fixtures (deep nesting, long strings, malformed JSON, BOM and invalid UTF-8, quoted multiline CSV, ragged rows, and mixed newline text). Use those fixtures in parser tests as well as the large-file benchmark.
