# Known limitations

This file records what the product does not do (yet) and why. Entries are added by the issue that discovers them and removed when a test proves the limitation is gone.

## Persistence (Issue #239, PST-01)

| Area | Status | Reason / next step |
|---|---|---|
| Corruption dialog (restore / start fresh / quit) | Logic covered by `tests/test_db.ts` (`openWithRecovery` with all three choices). The native message box itself was not driven in the running app. | Native dialogs cannot be clicked through Playwright without stubbing; the real-app e2e (#254) should script a corrupted profile. |
| Antivirus locking the database file | Transient `EBUSY`/`EPERM`/`EACCES` on open, backup and restore are retried with exponential backoff (tested with injected errors). A real AV lock was not reproduced. | Needs a Windows soak run with a real scanner (#257). |
| Disk full | Simulated with `PRAGMA max_page_count` (real `SQLITE_FULL`); the app surfaces a typed `disk-full` error and the database stays consistent. A genuinely full volume was not tested. The runtime swallows persistence errors on the event path (the mission keeps running) and exposes `MissionRecorder.lastError`; there is no UI banner yet. | UI surfacing belongs with #235 (timeline). |
| Read-only profile | A read-only database file is reported as a typed `read-only` error (tested). A read-only *directory* with a writable file is not distinguished. On startup any unopenable database shows an error box and the app exits. | Acceptable: the app cannot run without its database. |
| Two app instances | `app.requestSingleInstanceLock()` stops a second instance (verified in the real app by `scripts/e2e_persistence.mjs`). Independent processes sharing one file (CLI, tests) are safe via WAL + `busy_timeout`; tested with two writer processes. | |
| Very large event tables | Keyset pagination on `(mission_id, seq)`; 50,000 events paged at ~2 ms/page in `tests/test_db.ts`. The history UI renders at most 5,000 events per mission. | Virtualised list in #235. |
| Clock changes | Ordering uses `seq`; timestamps are stored as observed. | |
| Export / import | Zip is built in memory (fflate), so very large databases need RAM roughly equal to their size. Import replaces the database and restarts the app; it is refused while a mission is running. Secrets (API keys, `vault.enc`, legacy `settings.json`) are never exported, so keys must be re-entered after restoring on another machine. | Streaming zip if databases grow beyond a few hundred MB. |
| Legacy JSON import | `settings.json` and `missions/*.json` are imported once (markers `settings.json.migrated`, `missions/.migrated`); originals are never deleted, so a legacy `settings.json` that held plain-text API keys stays on disk until the user removes it. | Per the issue, originals are not deleted automatically. |
| Workspace JSON stores | `workspace/*` modules (threads, drafts, templates, instructions) are not wired into the product, so no user data exists in their JSON format. Their tables and repositories exist (`threads`, `messages`, `prompts`, `prompt_versions`, `instructions`) and are exercised by tests, but have no UI or runtime caller until #241-#244. | Wiring is tracked in those issues. |
| Tables without product callers yet | `schedules`, `inbox_items`, `memories`, `memory_chunks`, `approvals`, `action_ledger` have repositories and tests but are not written by the running app yet (#246, #240, #238). | |
| Memory store | `MemoryStore` runs on the new layer but is still not reachable from the product (`memory/memory_store.ts` is allowlisted for #240). | |
| Platforms | Verified on Windows x64 (Node 22 tests and Electron 33.4.11 ABI 130 in the running app). macOS, Linux and the packaged installer were not run. | #256, #258, #261. |

## Swarm worker isolation (Issue #229, SWX-03)

| Area | Status | Reason / next step |
|---|---|---|
| Storage path of worker sessions | Ephemeral workers use in-memory partitions `agent-<missionId>-<workerId>`, so `session.getStoragePath()` is `null` (the run asserts this). Distinctness is proven by partition names, distinct `Session` objects and cookie/localStorage isolation. The persistent `agent-profile` partition (shared login, #252) was not exercised in the running app because it writes into Electron's default user-data directory. | Account profiles arrive with #252. |
| In-memory sessions are never freed | Electron has no API to dispose a session. Teardown clears the worker's storage and cache and destroys its `WebContents`, so heap growth over 20 workers was +0.17 MB, but whole-process RSS rose 19 MB in the same run. A partition name is never reused within a process (`allocatePartitionName`). | Watch in the soak tests (#257). |
| Downloads | Cancelled and reported as a `download-cancelled` worker event; not routed to a mission folder. | #252. |
| Popups | Denied by policy (`window.open` returns `null`); a popup is not adopted as a new agent tab of the same worker. | Revisit with #252 if a task needs OAuth popups. |
| Crash recovery | After `render-process-gone` the worker reloads its last URL, at most twice (`MAX_CRASH_RECOVERIES`), then stays `crashed`. The call that was in flight when the renderer died fails with its own error; nothing re-queues it. A real supervisor restart policy is #231. | #231. |
| Memory pressure with 8 workers | `ResourceGovernor` hibernation is not wired to workers; no 8-worker memory test was run (the leak test runs 4 at a time). | #231. |
| Settle heuristic | Load finished + no request in flight for 500 ms (measured with `session.webRequest` on the worker's own session; WebSocket and EventSource requests are ignored) + DOM quiet for 150 ms with no running CSS animations, under a 10 s deadline. A page that never goes quiet returns `settled: false` (recorded in `WorkerHost.lastSettle`) and the worker continues. It uses `perception/settle_detector.ts`; the perception implementation decision belongs to #225. | #225. |
| User tabs | The guards in `swarm/agent_tab_guards.ts` apply to worker tabs only. User tabs in `ViewManager` still rely on the default session's permission handler set in `main/index.ts`. A `user-profile` worker gets the web-contents guards but never has handlers installed on the user's default session. | Browser hardening pass (#247). |
| Worker views in the UI | Worker views are created hidden by default (`attachToWindow` is false in the runtime); the grid/stage that shows them is #232. | #232. |
| Cancel | `AgentRuntime.cancel()` shuts the swarm down, so in-flight worker calls fail; the coordinator is not told to stop scheduling. | #226, #227. |
| Platforms | The run was on Windows x64 only. | #256. |


## Packaging and release (#258 PKG-01)

| Area | Limitation | Reason / follow-up |
|---|---|---|
| Fuses | `GrantFileProtocolExtraPrivileges` is **enabled**, not disabled. | The chrome window is loaded with `loadFile()` from inside `app.asar`. With the fuse off, Electron 33 answers that load with `ERR_FILE_NOT_FOUND` and the window is blank (observed with the packaged smoke test). Disabling it needs the renderer served from a custom protocol, a change in `src/main/index.ts`. Tracked as a follow-up under #237/#256. |
| Fuses | `EnableEmbeddedAsarIntegrityValidation` is only set on Windows and macOS. | Electron does not support asar integrity validation on Linux. |
| Preload | The chrome preload is bundled into one file by `scripts/bundle_preload.mjs` (added with #239). | The window uses `sandbox: true`; a sandboxed preload cannot `require` relative modules, so the raw tsc output never exposed `window.aegis` (also seen in the Step 0 packaged run: no tabs, no IPC). `npm run prepack:check` now fails if `dist/main/preload.js` still contains a relative `require`. |
| Signing | All installers are unsigned. | Certificates and notarisation are #259. Expect SmartScreen / Gatekeeper warnings; antivirus products may flag unsigned Electron installers as false positives, and signing is the mitigation. |
| macOS | Per-architecture builds (x64 and arm64 are built on matching hosts); no universal binary. | A universal build doubles the download and requires lipo-merging native modules (#239 will add one). Revisit when the native module set is final. |
| macOS | Hardened runtime is on, but without a Developer ID certificate the app is only ad hoc signed. | #259. |
| Linux | AppImage does not bundle `libsecret`. | The `.deb` declares `libsecret-1-0`. Without a keyring, `safeStorage` is unavailable and `CredentialVault` keeps keys in memory for the session only. |
| Windows | Builds from deep directories can exceed MAX_PATH. | `npm run prepack:check` fails early with the offending path when the budget (240 chars including install dir) is exceeded; enable `LongPathsEnabled` or build from a shorter path. |
| Windows | `dist:win` was run here but the installer was not tested on a clean Windows VM. | #261 tracks clean-machine installs; this PR installs per-user into a temp directory on the build machine and launches the installed app. |
| Native modules | `asarUnpack` only globs `**/*.node`. | There are no native modules until #239 picks a database; that issue must extend the config and re-run `npm run smoke:packaged`. |
| Auto-updater | Not wired into releases. | #259. |
