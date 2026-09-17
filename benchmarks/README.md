# Streaming benchmark

Measures the Rust core through the release `devtools-cli` executable on large files, without the desktop shell. The committed numbers are in [baseline.md](baseline.md); every run writes its own raw report to `results/` (ignored by git). The harness needs no network access: fixtures are generated locally and the only tools are `pwsh` 7, `cargo`, and `node` (already required by the repository quality gate).

## Run from a clean checkout

```powershell
pwsh -NoProfile -File benchmarks/generate-corpus.ps1 -CsvMiB 50
cargo build --release -p devtools-cli
pwsh -NoProfile -File benchmarks/run-streaming.ps1 -Runs 5 -Warmups 1 -IncludeTransform
pwsh -NoProfile -File benchmarks/validate-results.ps1
```

`generate-corpus.ps1` runs `scripts/generate-fixtures.mjs` for every JSON and text fixture, including `fixture-50mb.json` and `fixture-250mb.json`, so the benchmark measures exactly the bytes the cargo acceptance tests and the quality gate use. That generator never rewrites an existing file; delete a fixture to regenerate it. The script then writes the representative CSV and `fixtures/manifest.json` with the SHA-256 of every fixture. Generation takes about twenty seconds and 350 MB of disk.

`run-streaming.ps1` measures, per case, `-Runs` fresh processes after `-Warmups` discarded runs. Without `-IncludeTransform` it covers inspection and one cancellation; with it, minify-to-file and a cancellation during formatting are added. `-CancelAfterMs` (default 50) sets the cancellation timer, `-SampleIntervalMs` the memory-poll cadence, and `-Executable` another CLI build. It prints one line per case and saves `results/streaming-<utc stamp>.json` plus a Markdown summary with the same stamp.

`validate-results.ps1` checks the newest report (or `-Path`) against the schema described below and exits nonzero on the first violation.

## Cases

| Case | Fixture | CLI arguments | Expected |
|---|---|---|---|
| JSON inspect | `fixture-50mb.json`, `fixture-250mb.json` | `--inspect --format json` | exit 0, `valid: true` |
| CSV inspect | `representative-<n>mib.csv` | `--inspect --format csv` | exit 0 |
| Text inspect | `representative-<n>mib.csv` | `--inspect --format text` | exit 0; the only path that decodes every character |
| Inspect cancel | `fixture-250mb.json` | `--inspect --format json --cancel-after-ms 50` | exit 130, stderr `{"code":"cancelled"}` |
| Minify (`-IncludeTransform`) | both JSON fixtures | `--minify --output <results>/transform-<guid>.json` | exit 0, `output_bytes` equals the file written |
| Minify cancel (`-IncludeTransform`) | `fixture-50mb.json` | `--minify --output … --cancel-after-ms <validation median + 50>` | exit 130; no output and no `.partial-` file left |

The minify cancellation timer is derived from the measured JSON inspect median so the cancel is expected, not guaranteed, to land in the formatting pass, when a `.partial-` temporary exists next to the output. The scratch output is a fresh GUID-named file in `results/` that the harness deletes after every run.

## CLI contract the harness checks

The harness is reconciled with `crates/devtools-cli/src/main.rs` and `devtools_core::Inspection`. A drift fails the run before any samples are taken (preflight) and again on every sample:

- No arguments: exit 2 and a `usage:` line on stderr.
- Success: exit 0 and one JSON object on stdout with exactly the keys `input_bytes`, `output_bytes`, `elapsed_ms`, `valid`, `summary`; `valid` must be `true`, `input_bytes` must equal the fixture size, `output_bytes` must be `null` for inspections and equal the written file size for minify.
- Failure: exit 1 and a JSON object on stderr with a `code` field (the preflight expects `invalid_utf8` for `invalid-utf8.json`).
- Cancellation: exit 130 and `{"code":"cancelled"}` on stderr.
- Fixtures: the SHA-256 of every measured file must match `fixtures/manifest.json` when the manifest has an entry for it.

## Report schema (`schema_version` 2)

Top level: `recorded_at_utc`, `git` (`commit`, `dirty`, and `core_dirty` for `crates/` and `Cargo.*` only; `null` without git), `executable`, `executable_sha256`, `rustc`, `cargo`, `powershell`, `machine`, `parameters`, `contract`, `contract_preflight`, `methodology` (the caveats as text), `fixtures` (file, bytes, sha256, manifest hash and match), and `cases`.

Each case records `name`, `fixture`, `operation`, `format`, `expected_exit`, `cancel_timer_ms` (`null` unless cancelled), `fixture_bytes`, `fixture_sha256`, `arguments`, an `aggregate`, and every `run`. A run has `elapsed_ms` (parent stopwatch), `cli_elapsed_ms` (the core's own integer `elapsed_ms`), `launch_overhead_ms` (their difference) or `cancel_overshoot_ms` (wall time minus the timer), `peak_working_set_bytes`, `peak_private_bytes_sampled`, `memory_samples`, `exit_code`, `error_code`, the parsed `summary`, and trimmed `stderr`. The aggregate holds the median, minimum and maximum wall time, median core time, median launch overhead or cancel overshoot, `throughput_mib_per_s`, the maximum working set and sampled private bytes, and `working_set_to_input_ratio`.

## What the numbers mean

- **Wall time** includes executable startup, argument parsing, file I/O, JSON printing and teardown, plus up to one poll interval of measurement slack. **Core time** is what the CLI itself reports and excludes startup. Both are worth reading: the difference is the fixed per-process cost.
- **Warm cache.** Every fixture is hashed, and therefore read, right before it is sampled, and Windows has no portable way to drop the file cache. These are never cold-start numbers.
- **Memory.** `PeakWorkingSet64` is read from the parent while polling; it includes shared pages such as loaded DLLs, and anything after the last poll is missed. The interval is a lower bound: PowerShell overhead makes the real cadence closer to 20 ms, and `memory_samples` records what actually happened. Private bytes are sampled maxima, not peaks. Nothing here proves a memory bound; the core does not enforce one.
- **Cancellation.** The timer runs inside the CLI and sets the cooperative token; the core checks it between 64 KiB reads. The overshoot includes process startup and teardown, so it is an upper bound on acknowledgement latency, not a measurement of it. The cancellation error carries no internal timing.
- **Distribution.** Five runs give a median and a range, not a p95 or p99.
- **Scope.** The core CLI only, on synthetic ASCII-heavy fixtures. It says nothing about WebView startup, first paint, typing latency, tool switching, accessibility, desktop-shell memory, or heterogeneous real-world documents. The product-plan targets that need those measurements remain open.

## Offline acceptance checks

Run the repeatable core and shell checks after building the debug CLI:

```powershell
cargo test -p devtools-core --test acceptance
pwsh -NoProfile -File benchmarks/smoke-shell.ps1
```

The acceptance test reads the checked-in valid/invalid JSON and the 50/250 MB fixtures, verifies malformed UTF-8 and cancellation, caps previews at 64 KiB, checks progress, confirms temporary-result cleanup, and verifies source-byte immutability. The smoke script covers open/automatic inspect, minify to a saved copy, reopen, and invalid-input failure. Both checks are offline and report failure rather than making performance claims.

`manifest.json` also describes the adversarial fixtures (deep nesting, a long string, malformed JSON, trailing content, BOM and invalid UTF-8, an unclosed CSV quote, ragged rows, and mixed newlines). Use those in parser tests as well as the large-file benchmark.
