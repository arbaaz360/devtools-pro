# Streaming benchmark baseline

Recorded 2026-09-17T22:45Z from a clean checkout of `f04c04f4509d9c0d8c0ce3e92c0844f5c252705c` (`crates/`, `Cargo.toml` and `Cargo.lock` unmodified; the benchmark harness in this change was the only uncommitted work). Raw report: `streaming-20260917T224531885Z.json` (ignored by git; regenerate with the command below).

```powershell
pwsh -NoProfile -File benchmarks/generate-corpus.ps1 -CsvMiB 50
cargo build --release -p devtools-cli
pwsh -NoProfile -File benchmarks/run-streaming.ps1 -Runs 5 -Warmups 1 -IncludeTransform
pwsh -NoProfile -File benchmarks/validate-results.ps1
```

| Item | Value |
|---|---|
| Executable | `target/release/devtools-cli.exe`, SHA-256 `109a149c6a1fc2a06f37de9dc9aaf9a7647fd566d4e779f2c5fd6ef31901b76b` |
| Toolchain | rustc 1.97.1 (8bab26f4f 2026-07-14), cargo 1.97.1, PowerShell 7.6.6 |
| Machine | Intel Core Ultra 7 265K, 20 logical processors, 63.3 GiB RAM, Windows 11 Pro N 10.0.26200 |
| Method | 5 measured fresh-process runs per case after 1 discarded warm-up; warm OS file cache; working set polled from the parent process |
| Background load | 33–39 % CPU from unrelated builds on the same machine during the run |

## Results

Wall time is the parent stopwatch around process launch and exit. Core time is the `elapsed_ms` the CLI reports for the operation itself; the difference (16–20 ms median on this machine) is executable startup, argument parsing, JSON printing and teardown.

| Case | Input bytes | Median wall ms | Min–max wall ms | Median core ms | MiB/s (wall) | Peak working set MiB | Working set ÷ input |
|---|---:|---:|---:|---:|---:|---:|---:|
| fixture-50mb.json inspect | 50,000,707 | 198.8 | 168.9–207.6 | 182 | 239.9 | 4.11 | 0.086 |
| fixture-250mb.json inspect | 250,000,519 | 821.8 | 811.6–865.8 | 807 | 290.1 | 4.17 | 0.017 |
| representative-50mib.csv inspect | 52,428,871 | 65.3 | 62.6–79.0 | 47 | 765.9 | 4.11 | 0.082 |
| representative-50mib.csv text inspect | 52,428,871 | 144.5 | 139.4–155.2 | 123 | 346.0 | 4.23 | 0.085 |
| fixture-50mb.json minify to file | 50,000,707 | 320.1 | 318.6–334.5 | 304 | 149.0 | 4.16 | 0.087 |
| fixture-250mb.json minify to file | 250,000,519 | 1,364.0 | 1,315.7–1,415.7 | 1,338 | 174.8 | 4.21 | 0.018 |

| Cancellation case | Timer ms | Median wall ms | Min–max wall ms | Median overshoot past timer ms | Exit | Output left behind |
|---|---:|---:|---:|---:|---:|---|
| fixture-250mb.json inspect cancel | 50 | 64.4 | 64.2–72.6 | 14.4 | 130 | n/a (inspection) |
| fixture-50mb.json minify cancel during formatting | 232 | 249.9 | 248.1–259.8 | 17.9 | 130 | none (checked) |

The 232 ms minify timer is the measured median validation time for the 50 MB fixture (182 ms) plus 50 ms, chosen so the cancel lands while the formatting pass has a `.partial-` temporary open. The harness verified after every cancelled run that neither the output file nor a `.partial-` file remained.

## Fixtures

All three are produced deterministically from a clean checkout; the harness refuses to run if a fixture's hash differs from `fixtures/manifest.json`.

| Fixture | Bytes | SHA-256 | Generator |
|---|---:|---|---|
| fixture-50mb.json | 50,000,707 | `796a2441da23ac39cece2060440acd0d802b0d57d3b472ba6e444e1e765b5152` | `scripts/generate-fixtures.mjs` |
| fixture-250mb.json | 250,000,519 | `5233e0b14747cfaf2494b7483e271c7c65477076c421c799da2d70174b895cb7` | `scripts/generate-fixtures.mjs` |
| representative-50mib.csv | 52,428,871 | `237e9ddf323857572334292cf3de8ff9993bbc36839eb9a451d7b1974ace1b00` | `benchmarks/generate-corpus.ps1` |

The JSON fixtures are arrays of identical `{"id":1,"payload":…}` records with a 480-byte ASCII payload; the CSV has six fields with Unicode, CRLF, quoted multiline notes and escaped quotes. Neither stands in for heterogeneous real-world documents, deep nesting or long lines.

## What this does and does not show

- **Streaming holds.** Peak working set stays at 4.1–4.3 MiB for every case, including the 250 MB minify: about 0.02× the input, far below the "memory near 2× input" ceiling in the product plan. This is an observation of the current code path, not a guarantee; the core does not enforce a memory limit.
- **Throughput is parser-bound, not I/O-bound.** CSV structure scanning runs at ~770 MiB/s, the full character-decoding text scanner at ~350 MiB/s, and serde-based JSON validation at ~240–290 MiB/s. Minify reads the file twice (validate, then format), so it costs roughly validation plus a formatting pass.
- **Cancellation acknowledgement is bounded, not isolated.** The overshoot past the timer (14–18 ms) includes the ~17 ms of process startup and teardown measured on uncancelled runs, so the core's own acknowledgement latency is a few milliseconds at most. The CLI error `{"code":"cancelled"}` carries no internal timing, so this remains an upper bound.
- **Memory numbers are polled.** `PeakWorkingSet64` is read from the parent every ~20 ms in practice (the 5 ms interval is a lower bound; PowerShell adds overhead), so the shortest case received only 3–4 polls. The peak is monotonic, so a late poll still reports it, but anything allocated after the last poll is missed. Private bytes are sampled maxima (0.9–1.1 MiB), not true peaks.
- **Warm cache only.** Fixtures are hashed immediately before sampling and Windows offers no portable way to drop the file cache. Do not quote these as cold-start numbers.
- **Five runs give a median and a range**, not a p95. The ranges above stay within about 15 % of the median despite background load.
- **Core CLI only.** Nothing here measures WebView startup, first paint, typing latency, tool switching, accessibility or desktop-shell memory, all of which the product plan also targets.

## History

The 2026-09-13 numbers in the previous version of this file (140 ms and 609 ms inspect, 279 ms and 1,180 ms minify, 3 runs) were taken on hand-generated fixtures of different sizes (52,808,891 and 265,288,891 bytes) without recorded hashes, with an older, since-removed generator. They are not comparable to the table above and were superseded rather than carried forward.
