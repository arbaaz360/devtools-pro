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

Native Windows follow-up remains required before P00 is closed:

1. In a fresh app profile, open a real JSON file, format it, cancel a deliberately slow job, and confirm the source hash is unchanged.
2. Drop a real file on the native window and verify a new tab opens without changing a dirty tab.
3. Use the Windows clipboard with the generated `benchmarks/fixtures/clipboard-roundtrip.png` through both image/Base64 directions and save/reopen the result.
4. Repeat at ordinary Windows DPI, scaled display and ultrawide layout. Record OS/build, fixture hash, result, and screenshot path.

Any native failure becomes a focused P00 fix. Do not mark the browser mock as native evidence.
