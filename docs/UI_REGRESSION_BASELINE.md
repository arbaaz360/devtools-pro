# UI regression baseline

Status: initial browser-rendered baseline, 2026-09-15. This is a test harness, not a claim that native Windows dialogs and the Rust engine have been exercised.

Run from the repository root:

```text
pnpm --dir apps/desktop build
pnpm --dir apps/desktop test:ui
```

The Playwright suite builds and serves the actual Vite bundle. It runs the same eight scenarios at 1440×900, 1024×720 with 1.5× scale, and 3440×1400:

- blank tab typing, full editor surface, command palette focus return and save flow;
- JSON format/minify/validate, exclusive result surfaces and no duplicate operation controls;
- PNG → Base64 → complete clipboard → PNG, including an output larger than the 64 KiB preview;
- three independent tabs with different tools and drafts;
- fast-job progress delay, slow-job Cancel, caret/scroll preservation and pane geometry;
- invalid JSON diagnostics without an empty result editor;
- native drag/drop event routing without replacing a dirty tab;
- image-only actions, top-aligned media, neutral dark surfaces and control bounds.

The harness mocks only the Tauri invoke/event/dialog/clipboard boundary. Its app code, reducer, controller, DOM, CSS and result renderers are real. `apps/desktop/tests/native-mock.mjs` deliberately records the boundary distinction so a passing browser test cannot be mistaken for host or codec validation.

## Native bundle guard

`tauri build` embeds `apps/desktop/dist` into the executable. If the generated `index.html` points at an asset the package does not contain, or the emitted stylesheet loses the shell's flex layout, the native window shows an unstyled fallback document and no build step fails. `scripts/check-desktop-bundle.mjs` guards that seam; the quality gate in [QUALITY_CHECKS.md](QUALITY_CHECKS.md) runs it after the Vite build.

Run from the repository root:

```text
pnpm --dir apps/desktop build
node scripts/check-desktop-bundle.mjs
node --test scripts/check-desktop-bundle.test.mjs
```

The script reads `apps/desktop/src-tauri/tauri.conf.json`, resolves `build.frontendDist` (the directory Tauri actually embeds) and exits nonzero when:

- `index.html` is missing, loads no script or links no stylesheet;
- a `<script src>`, `<link href>` or `<base href>` is absolute (`/assets/…`), protocol-relative, a scheme URL, or resolves outside the bundle directory;
- a referenced asset is missing, is a directory, or matches the file on disk only case-insensitively (Tauri's embedded asset lookup is case-sensitive even on Windows);
- the linked stylesheet lacks a top-level `[hidden] { display: none !important }`, or `.app-shell`, `.app-body`, `.sidebar` and `.workspace` lack their flex declarations outside every at-rule (`@media`, `@layer`, `@supports`) — a narrow-width override cannot stand in for the base layout;
- the CSP is removed, or its effective `script-src` or `style-src` no longer allows `'self'`.

The tests build throwaway bundles shaped like the Vite output and break one property each, so every failure is deterministic: absolute, protocol-relative and scheme URLs, a `../` escape, a deleted script, a stale stylesheet hash, a case-only match, a layout rule that survives only inside a media query, a blocked CSP, and the command-line exit codes. `--dist <dir>` and `--tauri-config <file>` point the script at another bundle for such checks.

## Windows native build and launch

The bundle guard checks files; only the packaged executable proves the webview loads them. Run from the repository root in PowerShell:

```powershell
pnpm --dir apps/desktop install --frozen-lockfile
pnpm --dir apps/desktop build
node scripts/check-desktop-bundle.mjs
pnpm --dir apps/desktop tauri build --debug --no-bundle
.\target\debug\devtools-desktop.exe
```

`tauri build` runs `pnpm build` itself (`build.beforeBuildCommand`), compiles the Rust host, embeds `apps/desktop/dist` and writes `target\debug\devtools-desktop.exe`; `--no-bundle` skips installer packaging. The window must open titled "The DevTools Pro · Native preview" with the dark shell: tool rail on the left, tab bar and workspace on the right, nothing stacked or scrolling as a document. If it renders as plain text, the guard has missed a case — record the index and asset names and add a failure case to the tests.

`pnpm --dir apps/desktop tauri dev` loads the UI from the Vite dev server at `http://127.0.0.1:1420`, not from the packaged bundle, so it cannot reproduce a packaging regression and is not launch evidence. To build while an executable from `target\debug` is still running, set `$env:CARGO_TARGET_DIR = "apps\desktop\src-tauri\target-native-check"` for that build; the directory is ignored by git.

Native Windows follow-up remains required before P00 is closed:

1. In a fresh app profile, open a real JSON file, format it, cancel a deliberately slow job, and confirm the source hash is unchanged.
2. Drop a real file on the native window and verify a new tab opens without changing a dirty tab.
3. Use the Windows clipboard with the generated `benchmarks/fixtures/clipboard-roundtrip.png` through both image/Base64 directions and save/reopen the result.
4. Repeat at ordinary Windows DPI, scaled display and ultrawide layout. Record OS/build, fixture hash, result, and screenshot path.

Any native failure becomes a focused P00 fix. Do not mark the browser mock as native evidence.
