# Releasing Autonomous Browser

The version is single-sourced from the `version` field of `package.json`. electron-builder reads it for installer
names and metadata and `app.getVersion()` returns it at runtime. Do not hard-code it anywhere else, and do not
set `build.extraMetadata.version` or `buildVersion`.

## One-time prerequisites

- Node 22 and `npm ci`.
- Windows: if electron-builder fails extracting its signing toolchain with a symlink privilege error, enable Developer
  Mode or run the shell as administrator. Build from a short directory such as `C:\src\ab`: `npm run prepack:check`
  fails early if the longest path would exceed the Windows budget.
- macOS: build on a Mac. Linux: build on a Linux box with `fakeroot` and `dpkg` for the `.deb`.
- No signing certificates are configured yet (see #259), so every artifact is unsigned. Windows SmartScreen and
  macOS Gatekeeper will warn; see `docs/limitations.md`.

## Build locally

```bash
npm ci
npm run build            # tsc -b && vite build (renderer) && vite build (sandbox-safe preload bundle)
npm run prepack:check    # fails early if dist/main, dist/renderer or build/icon.* is missing
npm run pack:dir         # unpacked app in release/<os>-unpacked, fuses flipped by scripts/after-pack.mjs
npm run verify:fuses     # reads the fuses back from the packaged binary; exit 1 if RunAsNode is enabled
npm run smoke:packaged   # launches the packaged binary, attaches over CDP, checks title + "Electron app ready"
```

Installers for the host OS (each runs `build` and `prepack:check` first, and never publishes):

```bash
npm run dist:win     # NSIS installer (per-user or per-machine choice) + portable exe
npm run dist:mac     # dmg + zip for the host architecture
npm run dist:linux   # AppImage + deb
```

Artifacts land in `release/`. The icon set under `build/` is generated from `build/icon.svg` with `npm run icons`.

## Cut a release

1. Bump `version` in `package.json` and merge to `main`.
2. Tag and push: `git tag v<version>` then `git push origin v<version>`.
3. The `Release Desktop Packager` workflow builds on Windows, macOS and Linux, runs `npm run gate`, verifies the
   fuses, runs the packaged-app smoke test and uploads the installers. A final job creates a **draft** GitHub
   release with `gh release create --draft`. Nothing is published automatically.
4. Review the draft, install it on a clean machine of each OS (#261), then publish it by hand in the GitHub UI.

The workflow can also be started from the Actions tab (`workflow_dispatch`) as a dry run; dry runs never create a
release.

## Troubleshooting

- `Pre-pack check failed: dist/renderer/index.html is missing` means only `build:ts` was run. Use `npm run build`.
- Fuse verification failure after packaging: `node scripts/verify_fuses.mjs <path-to-binary>` prints the expected
  and actual value of every fuse.
- Linux without `libsecret`: the `.deb` declares the dependency; with the AppImage the OS keyring may be missing and
  `safeStorage` reports encryption as unavailable. `CredentialVault` then keeps API keys in memory only for that
  session (they are not written to disk, so they must be re-entered after a restart).
