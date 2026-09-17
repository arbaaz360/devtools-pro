# Native acceptance record — 2026-09-18

This record captures the first acceptance pass against the rebuilt Windows Tauri executable. Browser tests use a mocked native bridge, so these checks are kept separately as evidence from the real host and webview.

## Build under test

- Command: `pnpm --dir apps/desktop tauri build --debug --no-bundle`
- Isolated target: `apps/desktop/src-tauri/target-native-check`
- Build result: passed
- The normal target was already running, so the isolated target avoided replacing the live executable.

## Verified workflows

1. **Native catalog startup** — after the manifest request completes, the sidebar renders the full catalog (editor, JSON, CSV, text, image/Base64, escaping, hashing, URL/HTML/Unicode, diff, and cURL tools). The fix is manifest-aware cache invalidation in `apps/desktop/src/main.ts`.
2. **New document and editing** — Ctrl+N creates an editable tab and text can be entered without opening a file.
3. **JSON** — selecting JSON runs the native path, shows `Format`, `Minify`, and `Validate` once, and renders formatted output in the result pane.
4. **Image to Base64** — opening `benchmarks/fixtures/clipboard-roundtrip.png` shows an image preview instead of binary garbage. The operation completes and exposes a complete-result copy action.
5. **Base64 to Image** — copying the complete Base64 result and using the decoder's Clipboard action automatically imports and decodes it. The result pane displays the image preview and reports success.
6. **Per-tab state** — switching between the JSON, image encoder, and image decoder tabs preserves each tab's selected tool and result.
7. **Invalid JSON** — malformed input reports a precise line/column error, leaves the output empty, and does not show a false success state.

## Remaining acceptance work

- Native drag/drop, save dialogs and overwrite/collision behavior still need a dedicated pass.
- Diff/compare needs a native two-document interaction pass.
- Large-file limits, cancellation, and progress behavior need a timed pass with the benchmark fixtures.
- Visual flicker should be checked during those interactions with a screen recording; this pass confirms final layout/state but is not a frame-by-frame performance measurement.

