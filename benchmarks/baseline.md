# Baseline benchmark

Measured locally on 2026-09-13 with the optimized Rust CLI and the generated fixtures in `benchmarks/fixtures/`. Output was redirected to the null device; timings include process launch, file read and the requested operation.

| Fixture | Bytes | Operation | Elapsed |
|---|---:|---|---:|
| fixture-50mb.json | 52,808,891 | streaming inspect | 140 ms median (3 runs) |
| fixture-250mb.json | 265,288,891 | streaming inspect | 609 ms median (3 runs) |
| fixture-50mb.json | 52,808,891 | streaming minify to new file | 279 ms (1 run) |
| fixture-250mb.json | 265,288,891 | streaming minify to new file | 1,180 ms (1 run) |
| fixture-250mb.json | 265,288,891 | cancellation requested at 50 ms | 66 ms median (3 runs) |

This is a useful core baseline, not a product claim about GUI responsiveness. The earlier full-materialization prototype measured 829 ms and 3,389 ms for parse plus minify; the streaming path reduces memory pressure and remains responsive at 250 MB. The desktop shell still needs first-paint, typing, WebView memory and accessibility measurements.
