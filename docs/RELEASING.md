# Releasing

The app ships as two Windows installers built from the same executable:

| File | What it is | Who it suits |
|---|---|---|
| `The DevTools Pro_<version>_x64_en-US.msi` | Windows Installer package | managed machines, Group Policy, `msiexec /i` |
| `The DevTools Pro_<version>_x64-setup.exe` | NSIS installer, per-user | ordinary installs; no administrator needed |

Both install the same binary and the same bundled tools. The NSIS build installs
under the current user's profile, which is why it needs no elevation.

## Cutting a release

1. Bump the version in `apps/desktop/src-tauri/Cargo.toml` and
   `apps/desktop/src-tauri/tauri.conf.json` — they must match, and the release
   workflow fails the build if the tag disagrees with them.
2. Merge that to `main` with the quality gate green.
3. Tag and push:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

4. The **Release** workflow builds on `windows-latest`, checks an installer was
   actually produced, and opens a **draft** release with both files attached.
   Open the draft, read the generated notes, edit them into something a person
   would want to read, and publish.

`workflow_dispatch` rebuilds an existing tag if a run needs repeating.

## Building one locally

```bash
pnpm --dir apps/desktop tauri build
```

Output lands in `target/release/bundle/msi/` and `target/release/bundle/nsis/`.
The first run downloads the WiX and NSIS toolchains into
`%LOCALAPPDATA%\tauri`; later runs reuse them. A release build takes several
minutes — `pnpm --dir apps/desktop tauri build --debug --no-bundle` is the fast
path when you only want the executable.

## What is not signed

Nothing in the release is code-signed. Windows SmartScreen will warn on first
run of the NSIS installer ("Windows protected your PC"), and the user has to
choose *More info* → *Run anyway*. That is the honest state of things, and it
is worth saying plainly wherever the download is offered.

Signing needs a certificate the project does not have. An EV certificate buys
immediate SmartScreen reputation; a standard OV certificate builds reputation
over downloads and still warns at first. When one exists, Tauri signs during
`tauri build` from `bundle.windows.certificateThumbprint` (plus
`signCommand` for a cloud HSM) — the workflow needs the secret and no other
change.

## Updates

There is no in-app updater. A new version is a new download. Tauri's updater
plugin would need three decisions first: where the update manifest is hosted,
a signing key pair whose private half lives in the repository's secrets, and
whether the app may reach the network at all — today it never does, and that
is a property worth keeping deliberately rather than losing by default.

## The icon

`apps/desktop/src-tauri/icons/` is generated, not hand-drawn:

```bash
node scripts/make-icons.mjs
```

The mark is geometry in the shell's own palette, so it is reproducible from
source and stays legible at 16 px — below 64 px the slash is dropped, because
three strokes that close together read as a blob at tray size. Re-run the
script after changing the palette, and commit what it writes.
