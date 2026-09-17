# Developer Workbench

The repository starts with the shell-agnostic core from [DevTools Product Plan.md](DevTools%20Product%20Plan.md) and the versioned boundary in [Tool Contract and Document Model.md](Tool%20Contract%20and%20Document%20Model.md).

Technology choices, module boundaries, extension guidance, and current limitations are documented in [ARCHITECTURE.md](ARCHITECTURE.md).

The next architecture milestone is a plugin system. Its [design](docs/PLUGIN_SYSTEM_DESIGN.md), [27-tool DevUtils reference baseline](docs/DEVUTILS_REQUIREMENTS.md), and [implementation/worker packets](docs/PLUGIN_IMPLEMENTATION_TASKS.md) distinguish the current static integration from the planned SDK, bundled discovery, and later runtime installation.

The first measurable vertical slice provides immutable `Document` envelopes with encoding/newline detection, a versionable `Tool` contract with diagnostics, and JSON detection/formatting behind a CLI harness. Run `cargo test --workspace` or `cargo run -p devtools-cli -- '{"hello":"world"}'`.

The static interaction prototype is in [prototype/](prototype/). The Tauri desktop shell is in [apps/desktop/](apps/desktop/); run `pnpm install` and `pnpm tauri dev` there from a Visual Studio Developer PowerShell. The streaming core is benchmarked offline from a clean checkout with the four commands in [benchmarks/README.md](benchmarks/README.md); the committed numbers, fixture hashes and caveats are in [benchmarks/baseline.md](benchmarks/baseline.md).
