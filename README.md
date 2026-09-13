# Developer Workbench

The repository starts with the shell-agnostic core from [DevTools Product Plan.md](DevTools%20Product%20Plan.md) and the versioned boundary in [Tool Contract and Document Model.md](Tool%20Contract%20and%20Document%20Model.md).

Technology choices, module boundaries, extension guidance, and current limitations are documented in [ARCHITECTURE.md](ARCHITECTURE.md).

The first measurable vertical slice provides immutable `Document` envelopes with encoding/newline detection, a versionable `Tool` contract with diagnostics, and JSON detection/formatting behind a CLI harness. Run `cargo test --workspace` or `cargo run -p devtools-cli -- '{"hello":"world"}'`.

The static interaction prototype is in [prototype/](prototype/). The Tauri desktop shell is in [apps/desktop/](apps/desktop/); run `pnpm install` and `pnpm tauri dev` there from a Visual Studio Developer PowerShell. The streaming core is benchmarked with `pwsh -NoProfile -File benchmarks/run-streaming.ps1` after `cargo build --release -p devtools-cli`.
