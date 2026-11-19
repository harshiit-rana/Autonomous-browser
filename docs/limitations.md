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
