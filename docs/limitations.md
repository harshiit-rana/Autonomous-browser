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
| Settle heuristic | Load finished + no request in flight for 500 ms (measured with `session.webRequest` on the worker's own session; WebSocket and EventSource requests are ignored) + DOM quiet for 150 ms with no running CSS animations, under a 10 s deadline. A page that never goes quiet returns `settled: false` (recorded in `WorkerHost.lastSettle`) and the worker continues. It uses `perception/settle_detector.ts`. #225 chose `agent/perception.ts` for the single-agent loop; workers keep this settle heuristic. | |
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

## Running-app baseline (#223 RUN-01)

Measured in the real app on Windows 11 / Electron 33.4.11; details and evidence in `docs/audits/RUNNING_APP_BASELINE.md`.

| Area | Limitation | Owner |
|---|---|---|
| Model | No real-key mission has been run in the real app; the single-agent loop was exercised only against a scripted stub. | #225, #254 |
| Swarm Grid | Fixed by #232: `getSwarmPreviews()` is deleted; the live Grid is described below. | #232 |
| Overlays | Chrome-DOM overlays (agent cursor, approvals) are invisible over the page in Stage layout; modals work only because the page view is hidden. Nothing emits presence events. | #233, #237 |
| Swarm | Workers make no model calls; evidence is the page title of a search engine. | #227, #230 |
| Approvals | Since #225 a policy `ask` (e.g. navigation to a new origin) is shown in the drawer's question card with Approve / Deny; there is still no approval inbox or history. | #238 |
| Credentials | The vault is encrypted at rest, but `getSettings()` returns the decrypted key to the renderer. | #248 |
| Window | At the declared minimum size 800x600 the chrome overflows horizontally and the Theatre button is clipped. | #237 |

## Live Swarm Grid (#232 LIV-01)

Real-app evidence: `docs/audits/evidence/232/` (`scripts/dev/drive_live_grid.mjs`, Windows 11, 125 %, Electron 33.4.11). Unit tests: `tests/test_frame_hub.ts`. Edge cases not covered there are recorded here.

| Area | Limitation | Reason / owner |
|---|---|---|
| Platforms / DPI | Measured on Windows 11 at 125 % only. macOS, Linux, real 100 % / 150 % settings, moving the window between monitors were not run. | Only machine available; #254/#255 e2e on other OSes. |
| Many workers | Tiles are DOM cards in a scrolling grid; only tiles whose frame is fully on screen get a live native view (a native view cannot be clipped by the DOM). Others are parked (frozen) and show a still refreshed at most every 10 s. Measured up to 6 workers + 3 tabs (9 tiles); 20+ was not run. | Virtualising the DOM cards is not needed below ~100 tiles; not measured. |
| Parked workers | A worker that is not on screen (Stage mode, scrolled out, overlay open) is frozen by Chromium (rAF 0, ADR 0010). There is no Theatre strip to keep workers running while the Stage shows something else. | Theatre strip / scheduler policy: #237 and later. |
| Tile zoom | Worker tiles use `setZoomFactor(tileWidth / 1280)`; the run confirmed the page keeps a 1280 px layout viewport and an executor CDP click lands under zoom, but the page sees `devicePixelRatio` ~0.32 (a detectable tell, #250) and model screenshots under zoom were not checked. User tabs are never zoomed (shared default session, zoom persists per host), so they lay out at tile size in the Grid. | `Emulation.setDeviceMetricsOverride` not evaluated. |
| Clicks in tiles | A tile's page area is the live page: clicking it interacts with the worker page. Promote uses the tile header / Stage button. | Native view above the DOM (ADR 0012). |
| Pop-out, blur | "Pop-out to own window" and the "blur sensitive" toggle are not implemented: CSS `filter` cannot affect native views, and blurring the canvas would require hiding (freezing) the view. | Follow-up; frames are never persisted or sent to a model. |
| Tile metadata | Tiles show identity, status ring, current task and progress from `worker:event`. Per-worker step count, cost and last evidence line are not shown because the runtime does not emit them per worker. | #230 / #241. |
| Not exercised | GPU-process crash, sleep/wake, video/WebGL pages, fullscreen requests, other windows occluding the app (driver passes `--disable-features=CalculateNativeWinOcclusion`), glass-to-glass latency. Window minimise/restore, renderer crash with auto-recovery, worker retire, renderer reload and resize were exercised. | Not measured; do not infer. |

## Model setup and replay demo (#224 RUN-02)

`tests/test_provider_factory.ts` covers: no key for each provider, a stale `demoMode` value, a key for a different provider than the selected one, an invalid env-var key (401 from a local stub and `CREDENTIALS_TEST`), Ollama not running (error names the base URL), Ollama model not installed, and Ollama serving only `/v1/chat/completions`. The rest is recorded here.

| Area | Limitation | Reason / owner |
|---|---|---|
| Replay demo | The shipped transcript `fixtures/demo/shop_cheapest_in_stock.json` is hand-written, not recorded from a live model run, and is labelled as such. The player shows its steps and opens the local test shop in a tab; it does not execute the recorded actions in the page. | A transcript from a real run needs a real key and the e2e harness (#254, #255). Replacing the file needs no code change. |
| Replay demo | "Never saved to memory" holds today because no mission result is written to the memory store (`memory/memory_store.ts` is not wired, #240). The player also bypasses mission persistence and deliverables. | When #240 wires memory, it must skip anything tagged `source: "demo"`. |
| Key rotated mid-mission | The next model call fails and the mission ends with `Model error: ...`; there is no pause-and-ask-for-a-new-key flow. | Mission lifecycle and error pausing belong to #226. |
| Offline | Saving a key validates it first; offline the check fails and the user must press Save a second time to store it unverified. No separate offline mode. | Accepted trade-off; the second Save is deliberate. |
| Invalid env-var key for Gemini/Anthropic | An env-var key counts as configured. If it is wrong the first model call fails with the provider's error. Only the OpenAI-compatible path is tested against a local 401 stub. | Gemini and Anthropic SDKs do not take a base URL override here; no network calls to real providers in CI. |
| Model name the provider does not serve | Ollama: checked against `/api/tags` before a mission (message tells the user to `ollama pull`). Cloud providers: the provider's own error is shown. No model list is validated for cloud providers before the first call. | Provider model lists change; revisit with #225. |
| Provider vs model picker | The model picker decides the provider for a known cloud model prefix (`gemini`, `claude-`, `gpt-`); the saved provider only applies to unknown names, and Ollama wins when selected. Saving settings moves the picker to a model of the saved provider. | Keeps one rule; a per-provider model field is future work. |
| Cost estimate | Rough per-step figure from `models/pricing.ts` with stated assumptions (6000 prompt + 400 completion tokens); models without a pricing entry show "no pricing data". | Estimate only; real cost is tracked by the usage ledger. |

## Single-agent loop (#225 RUN-03)

`tests/test_agent_loop.ts` drives `AgentLoop` in a real Electron `WebContentsView` against the `/agent/*` arena fixtures with a scripted model (25 scenarios). The rest is recorded here.

| Area | Limitation | Reason / owner |
|---|---|---|
| Real model | No mission was run with a real model key. The verifier pass/fail/retry paths, `ask_user`, budgets and stuck detection were exercised only with the scripted provider (`AEGIS_E2E_MODEL_MODE=scripted`). Whether a real model reaches `verifier: pass` on the acceptance tasks is **not verified**. | No key on this machine; #254. |
| PDF reading | There is no `read_pdf` tool. | No PDF fixture or viewer integration yet; Chromium's PDF viewer is a plugin frame the extractor cannot enter. |
| JS dialogs | `alert` and `beforeunload` are accepted; `confirm` and `prompt` are always dismissed and the text is reported to the model. The agent cannot choose OK or type into a prompt. | Choosing would need a policy decision per dialog; dismissing is the safe default. |
| Cross-origin iframes | Listed in the snapshot as opaque frames (origin + rect) but not entered; elements inside them have no refs. Same-origin frames and open shadow roots are entered. | Needs per-frame CDP sessions (OOPIF). |
| Mission brief | `successCriteria`, `maxSteps` and `maxCostUSD` per mission exist in `MissionBrief`, but the UI has no form for them; `/do` passes only the goal. | #241. |
| Approvals | A policy `ask` decision is shown in the drawer's question card (Approve / Deny). There is no approval inbox or history. | #238. |
| Extraction | `extract` collects tables and lists from the scoped element itself; it does not use the structured extractor planned in #251. Every `record_extraction` value must be backed by a quote that occurs in the extracted text. | #251. |
| Old perception modules | `perception/axtree_extractor.ts`, `som_overlay.ts`, `spatial_reasoner.ts` moved to `attic/`. Measured against the new extractor on the fixtures (`docs/audits/evidence/225/step0/`): no shadow DOM, iframe or occlusion handling, and `som_overlay` draws marks into the page DOM. | Replaced by `agent/perception.ts` and `agent/som_bitmap.ts`. |
