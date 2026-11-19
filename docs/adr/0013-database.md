# ADR 0013: Database for the Electron app

- Status: accepted
- Issue: #239 (PST-01)
- Date: 2026-11-19

## Context

`src/memory/memory_store.ts` and `src/swarm/blackboard.ts` used `node:sqlite`. That module exists only from Node 22.5; Electron 33 embeds Node 20.18, so in the shipped app the store threw "not supported in the active Node runtime" and the blackboard silently fell back to a JSON file. Missions, events, threads and templates had no durable store at all (settings and mission checkpoints were ad-hoc JSON files).

## Options considered

| Option | Native build | WAL / real file | FTS5 | Verdict |
|---|---|---|---|---|
| `better-sqlite3` | yes (prebuilt binaries exist for Electron ABI 130 on win/mac/linux) | yes | yes (compiled in) | chosen |
| `sql.js` | no (WASM) | no: whole database lives in memory and must be exported to persist; a crash loses everything since the last export | yes | rejected: durability |
| `node-sqlite3-wasm` | no (WASM) | file-backed through a JS VFS, no WAL and no cross-process locking guarantees | limited | rejected: two app instances / WAL requirement |

## Decision

Use **better-sqlite3 pinned to `12.11.1`** (exact, no caret).

Why not the current 13.x: its `engines` field is `node >= 22`, and Electron 33 runs Node 20. 12.11.1 declares `20.x || 22.x || ...` and ships `electron-v130` prebuilds for darwin/linux/win32 (arm64, x64, ia32 on win32). Evidence (release asset list of `WiseLibs/better-sqlite3` tag `v12.11.1`):

```
better-sqlite3-v12.11.1-electron-v130-darwin-arm64.tar.gz
better-sqlite3-v12.11.1-electron-v130-darwin-x64.tar.gz
better-sqlite3-v12.11.1-electron-v130-linux-arm64.tar.gz
better-sqlite3-v12.11.1-electron-v130-linux-x64.tar.gz
better-sqlite3-v12.11.1-electron-v130-win32-arm64.tar.gz
better-sqlite3-v12.11.1-electron-v130-win32-ia32.tar.gz
better-sqlite3-v12.11.1-electron-v130-win32-x64.tar.gz
```

Revisit when the app moves to an Electron release that bundles Node >= 22.

### One native binary per ABI

`node_modules` holds the binary for the Node that runs tests and CI (ABI 127 on Node 22). Electron needs ABI 130. We never rebuild in place and have no `postinstall` hook, so `npm ci` always yields a working test environment.

- **Development**: `npm run rebuild` runs `scripts/sqlite_native.mjs electron`, which downloads the Electron prebuild with `prebuild-install` into `.native/electron-abi130-<platform>-<arch>/` (git-ignored) and restores the Node binary. `src/infrastructure/db.ts` picks that file through better-sqlite3's `nativeBinding` option when `process.versions.electron` is set. `npm run rebuild:verify` loads it inside the real Electron runtime (`ELECTRON_RUN_AS_NODE`) and runs SQL including FTS5.
- **Packaged app**: `electron-builder` (`npmRebuild: true`) rebuilds/fetches the Electron ABI binary for the production dependency and `asarUnpack: ["node_modules/better-sqlite3/**/*"]` keeps the `.node` file outside `app.asar`, where it can be loaded. There is no `.native/` directory in a packaged app, so the default binding is used.

### Storage layout

- File: `<userData>/aegis.sqlite` (`AEGIS_USER_DATA` overrides `userData`), `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`, `quick_check` on every open.
- Migrations: `src/infrastructure/migrations/NNNN_name.sql`, forward-only, contiguous, each applied in its own transaction together with its `schema_migrations` row (version, name, SHA-256 of the file with LF endings). `tsc` does not copy `.sql`, so `scripts/copy_assets.mjs` copies them to `dist/` as part of `npm run build`.
- Before applying any migration to a non-empty database the runner writes a consistent snapshot with `VACUUM INTO` to `aegis.sqlite.bak-<version>` (never `fs.copyFile`: in WAL mode part of the data lives in `-wal`). If a migration fails, the whole run is rolled back to that snapshot and a typed error is raised.
- A database whose schema is newer than the app, or whose applied migration no longer matches the shipped file, is refused untouched.
- Ordering key for events is the per-mission `seq` allocated inside an `IMMEDIATE` transaction, not the wall clock.
- SQL lives only in `src/infrastructure/db.ts` (migration runner) and `src/infrastructure/repos/*.ts`. `MemoryStore` was ported to `PagesRepo`; its retrieval logic is unchanged and is reworked in #240.
- API keys are not stored in SQLite. They stay in the Electron `safeStorage`-backed credential vault (`vault.enc`); see #248 for the full secrets work.

## Consequences

- Positive: one durable, transactional store that works in the real app; FTS5 available; cross-process safe through SQLite locking.
- Negative: a native dependency. Contributors who run the Electron app must run `npm run rebuild` once per Electron upgrade. Mixing ABIs in `node_modules` is avoided by design.
- Packaging on macOS/Linux and in CI (#256, #258) is **not yet verified**; only Windows x64 was exercised (see PR for exactly what was run).
