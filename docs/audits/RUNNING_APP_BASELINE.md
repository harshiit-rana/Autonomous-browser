# Running-app baseline (issue #223, RUN-01)

What the real Electron app does when it is built, launched and driven on a real machine, with the evidence kept in
`docs/audits/evidence/run01/`. Everything below was measured in one scripted run (`scripts/dev/drive_baseline.mjs`) unless it
says "code reading". Where a measurement was flaky or could not be made it is listed under "Not measured" and is not counted
either way. The file name differs from the one in the issue text (`BASELINE_RUN.md`) because the coordinator asked for this
name.

## 1. Environment

| | |
|---|---|
| OS | Windows 11 Home Single Language 10.0.26300 |
| Hardware | AMD Ryzen 7 7735HS (16 threads), 15 GB RAM, AMD Radeon + NVIDIA RTX 4050 Laptop GPU |
| Display | 1920x1080 at 125% (dpi 120); the default window opens at 1400x816 DIP |
| Software | Node v22.19.0, Electron 33.4.11 |
| Commit | `7d723c15f62f17d7dc3844f126207b94b66bb455` (main after #268-#271) |
| Build | `npm run build` succeeded, see `evidence/run01/build.log`. `node_modules` and `.native/` were copied from a sibling worktree; `npm ci` itself was not re-run. |
| Launch | `electron dist/main/index.js --remote-debugging-port=9333 --user-data-dir=<tmp>/chromium`, `AEGIS_USER_DATA=<tmp>`. Port 9222 was held by the owner's Chrome, so 9333 was used. Log: `evidence/run01/electron.log` |
| Driver | `scripts/dev/drive_baseline.mjs` (Playwright `connectOverCDP`), `scripts/dev/os_screenshot.ps1`, `scripts/dev/png_diff.ps1`. How to run it: `docs/dev/RUN_RECIPE.md` |

## 2. Harness caveats (read before trusting any "works")

* **There was no real model.** No API key exists in this environment and no Ollama is installed, so scenarios 5 and 7 ran the
  Ollama provider against a scripted OpenAI-compatible stub started by the driver (it answers `click`, then `done`, or `wait`
  forever, or a navigate). It exercises the agent loop, step feed, counters and controls. It says nothing about answer quality
  or real tool-calling. **A real-key mission was not run; that part of the issue is NOT VERIFIED.** Token counts in the UI are
  the stub's invented usage figures.
* The only real network model call was the invalid-key test against Google (scenario 3), which returned the expected 400.
* Screenshots named `os_*.png` are an OS screen copy of the real window (they include the native page view); `cdp_*.png` are
  the chrome renderer alone and never contain the native page view. The script refuses to save a frame unless every sampled
  point belongs to the Aegis process (another application's window can cover it on a shared desktop).
* The machine was shared and under memory pressure during the run (another process held about 5 GB). Earlier runs were
  discarded for harness faults (the window being covered or minimised during capture), not product faults.
* Windows only. No macOS or Linux, no packaged installer, no clean-VM install.
* "Native view size" from Win32 child windows is **not** a reliable hidden/visible signal (the child window keeps its size
  after the app calls `setBounds(0,0,0,0)`). Hidden/visible below is decided from pixels.

## 3. The two questions asked

### 3.1 Are DOM modals, overlays and the agent cursor hidden behind the native page view?

**Modals: no, because the app removes the page.** While the Settings modal is open the app shrinks the active
`WebContentsView` to 0x0 (the #138 workaround in `ViewManager.relayout`). The modal card is painted unobstructed in the real
window (0 of 320,400 pixels differ from the chrome-only frame, `os_03a_settings_modal_open.png` vs
`cdp_03a_settings_modal_open.png`), and the page area is blank (2,259 of 1,223,040 pixels, 0.18%, differ from the
chrome-only frame). Cost: the page vanishes behind
every modal instead of being dimmed, and the page view comes back on Escape (`os_03c_after_close.png`).

**Overlays and the agent cursor in Stage layout: yes, hidden.** A probe element placed in the chrome DOM at `z-index:
2147483647` over the page area changes **0 of 2,850** pixels in the real window in Stage layout, while the same element in the
titlebar (no native view there) changes 2,250 of 2,250 (control) and the noise between two identical captures is 0. A
probe built from the real `.__presence_cursor__` markup inside `#presence-overlay` also changes 0 of 9,328 pixels. The same
cursor probe is visible in Grid layout (1,505 of 9,328 changed) only because Grid hides the page view. Independently of the
pixels, nothing ever creates a cursor: `ViewManager.broadcastPresence` has no caller (`git grep` in the evidence), and no
`.__presence_cursor__` element appeared during the stub-driven mission. So a visible agent cursor needs both a producer
and a different compositing approach. Evidence: `os_09_stage_probe.png`, `os_09_grid_probe.png`,
`cdp_09_*_probe_in_chrome_dom.png`.

### 3.2 Are credentials stored in plaintext?

**At rest: no.** `vault.enc` is written and contains `safeStorage`-encrypted values (`v10...` blobs), not the key. The test
key was searched for in every profile file (SQLite database and WAL, vault, logs) and in `electron.log`: not found. Clearing
the key removes it from the vault.

**In memory and over IPC: yes, the decrypted key reaches the renderer.** `window.aegis.getSettings()` returns the
decrypted API key to the chrome renderer, and reopening Settings pre-fills the (password-type) input with the real key. Any
script that runs in the chrome renderer can read it. A legacy `settings.json` that predates the vault is a separate on-disk
plaintext risk already listed in `docs/limitations.md` (PST-01). Owner: #248.

## 4. Scenarios

Status is computed from the checks in `evidence/run01/scenario_results.json`. PASS means every check passed.

| # | Scenario | Result | What was measured | Evidence |
|---|---|---|---|---|
| 1 | Open, titlebar, console | PASS 7/7 | Window, titlebar, tab strip, controls and `window.aegis` bridge present. No chrome-renderer console errors, no ERROR lines in the log at startup. The first tab loads `https://duckduckgo.com` on every launch (a network request at startup). | `os_01_app_open.png`, `cdp_01_chrome_renderer_only.png` |
| 2 | Tabs and navigation | PARTIAL 5/6 | New tab, navigation to example.com, title update, Back and Reload work (reload gets a new document). **Forward did not return to example.com** in this run; the cause was not investigated (see Not measured). | `os_02a_example_com.png`, `os_02b_after_back_forward_reload.png` |
| 3 | Settings modal and invalid key | PASS 5/5 | Modal visible in the real window (see 3.1). "Test Key" with an invalid key shows a clear error from Google after about 0.4 s. Escape closes it and the page returns. | `os_03a`, `os_03b_invalid_key_error.png`, `os_03c_after_close.png` |
| 4 | No key, demoMode=false | PARTIAL 7/8 | A `/do` mission is refused with "Google Gemini API key is not configured", Settings opens, no mission row, the main process stays up. **The issue's example phrase (a plain sentence) is not a mission:** it was treated as a web search and navigated the active tab to Google (which in later attempts showed Google's captcha page). With demoMode on and still no key, the mission "succeeds" with the canned text "Mock task finished". | `os_04a_plan_preview.png`, `os_04b_no_key_error.png` |
| 3b | Key storage | PARTIAL 5/6 | See 3.2. | none (data in JSON) |
| 5 | Single-agent mission (stub model, see 2) | PARTIAL 6/9 | With the form defaults (Ollama URL `http://localhost:11434`, model dropdown `gemini-2.0-flash`) the first model call goes to `/chat/completions` and fails with a 404 against an Ollama-shaped server (Ollama serves `/v1/chat/completions`). When the agent's first step is a navigation to a different origin the mission pauses on "Human Approval Required: navigate-out-of-scope" naming the origin `'0.1'` (for `127.0.0.1`); no UI element can answer it, only Cancel works. With the page pre-opened the stub's click reached the page, the step feed showed the actions, the token counter moved and the mission completed. Cost stays `$0.0000` for a local model. | `os_05a_navigate_needs_approval.png`, `os_05b_mission_finished.png` |
| 9 | Agent cursor | PARTIAL 2/5 | See 3.1: never emitted, invisible over the page in Stage, visible in Grid only because the page is hidden. | `os_09_stage_probe.png`, `os_09_grid_probe.png` |
| 6 | `/swarm compare prices of laptops across stores` | PARTIAL 2/4 | Completes in about 12 s, spawns three `researcher` workers (Ada, Bram, Cleo) as real hidden views (peak page targets 5 against 2 before) and tears them down. **No model call was made** (0 requests to the stub). Every worker visited `https://duckduckgo.com`; the plan preview is a fixed template ("primary vendor / alternative / benchmark"); the one evidence row is the DuckDuckGo page title at 95% confidence; the report on disk lists "Steps Executed: 0". Each worker logged "page did not settle before the deadline" (10 s). | `os_06a_swarm_plan_preview.png`, `os_06b_swarm_running.png`, `os_06c_swarm_finished.png` |
| 7 | Pause, Takeover, Hand back, Cancel, Undo, Steer | PARTIAL 6/12 | **Honest:** Pause on a running mission sets state `paused` and the agent stops calling the model; Takeover pauses; Cancel sets `cancelled`, aborts the in-flight request and no further model calls follow; Cancel on a swarm stops all feed activity (56 items at cancel, 56 fifteen seconds later). **Not honest:** pressing Pause with no mission flips the label to "Resume"; the Pause label does not change after Takeover; Undo says "No reversible local actions found in the ledger". **Unclear (see Not measured):** Resume, Hand back and Steer. Cancelling a swarm also logs `Unhandled error in agent execution loop: Swarm is shut down` and the mission card shows "Mission failed: Swarm is shut down" while the persisted state is `cancelled`. | `os_07a_paused.png`, `os_07b_cancelled.png`, `os_07c_swarm_cancel_after.png` |
| 8 | Swarm Grid | PARTIAL 2/5 | **`getSwarmPreviews()` never returns when more than one tab is open** (timed out at 8 s with 3 tabs; also reproduced separately with 2 tabs; returns in 32 ms with exactly one active tab). `ViewManager.getSwarmPreviews` awaits `capturePage()` on every tab, and a background tab's view is not attached, so the promise does not settle. The renderer awaits it before drawing, so the Grid shows an empty dark pane (no tiles, not even the "No open tabs" text). With one tab the API returns a single `capturePage()` thumbnail (10.5 kB data URL); the tile itself was only seen in an
exploratory run, not in the committed evidence. Because there are no tiles, tile liveness and frame rate could not be measured. CPU, all Electron processes: 26% of one core in Stage with an animated page, 2.6% in Grid (the page view is hidden in Grid). | `os_08a_grid.png`, `os_10c_grid.png` |
| 10 | Layouts, resize, minimum size, scaling | PARTIAL 3/6 | Theatre differs from Stage; the window cannot be sized below 800x600; no horizontal overflow at 1000x700. **At 800x600 (the declared minimum) the chrome has horizontal overflow** (a horizontal scrollbar, and the layout buttons are clipped, `os_10d_800x600.png`). The measured native view in Stage was 1060 wide against a DOM viewport of 1075 (15 px unexplained). 150% scaling (`--force-device-scale-factor=1.5`, not the Windows setting): chrome renders, no overflow, Run and Settings visible. | `os_10a_stage.png`, `os_10b_theatre.png`, `os_10d_*.png`, `os_10b_scale150.png` |
| E | Edge cases | PASS 3/3 | A second instance on the same profile exits (single-instance lock) and the first keeps answering. A second instance with a different `AEGIS_USER_DATA` and a different `--user-data-dir` keeps running (two independent instances are possible). Port 9222: when the port is taken the app still starts and no endpoint exists. | `electron.log` |
| E2 | `--disable-gpu` | PASS 2/2 | The app launches and lays out normally, no GPU error lines. | `os_E2_disablegpu.png` |

Console and log: 22 console lines and 21 WARN/ERROR lines over the whole run. The ERROR lines come from the injected stub failure
(404), the aborted requests on Cancel, the circuit breaker opening after four aborts, and the `Swarm is shut down` error
above. Twelve Electron "Insecure Content-Security-Policy" warnings (the chrome renderer has no CSP; they disappear only when
packaged) and two `Cannot read properties of null (reading 'appendChild')` page errors of unknown origin are also present.

User data location: `src/infrastructure/paths.ts` defaults to the Electron `userData` directory
(`%APPDATA%\autonomous-browser`), not `.aegis-user-data/` as the issue text says. `AEGIS_USER_DATA` moves only the app's own
files (SQLite, vault, logs, deliverables). By code reading no `app.setPath` call exists, so Chromium's own profile and the
single-instance lock stay in the default directory unless `--user-data-dir` is also passed (a scripted launch without it
found no modified entries in the final run, so this is not confirmed by measurement).

## 5. Defects

Severity: **High** blocks a promised feature, **Medium** wrong or misleading behaviour, **Low** cosmetic or minor. Each is
owned by an existing program issue; no new issue was needed.

| # | Defect | Severity | Repro (all on a fresh profile, no key) | Owner |
|---|---|---|---|---|
| D1 | Swarm Grid is blank whenever more than one tab is open (`getSwarmPreviews` hangs on background tabs) | High | Open two tabs, click Grid | #232 |
| D2 | Chrome-DOM overlays, the agent cursor and approval UI are invisible over the page in Stage layout; nothing emits presence events | High | Run `drive_baseline.mjs --only 9`, or see `os_09_stage_probe.png` | #233, #237 |
| D3 | Swarm workers make no model call; workers all open the same search engine; evidence is a page title at 95% confidence | High | `/swarm compare prices of laptops across stores` | #227, #230 |
| D4 | Navigation to a new origin pauses the mission awaiting an approval that has no UI, with a wrong origin (`0.1`) | High | Mission whose first step navigates to a different host (stub `NAVFIRST`) | #238, #247 |
| D5 | Demo mode with no key silently "succeeds" with "Mock task finished" | Medium | Settings, tick Demo Mode, run any `/do` | #224 |
| D6 | Default Ollama URL (no `/v1`) plus default Gemini model name cannot run a mission against Ollama | Medium | Choose the Ollama provider, keep the defaults, run `/do` | #224 |
| D7 | Decrypted API key returned to the renderer and pre-filled in Settings | Medium | `window.aegis.getSettings()` in the chrome renderer | #248 |
| D8 | Pause with no mission toggles its label; Pause label ignores Takeover; Undo has nothing to undo | Medium | Click Pause on an idle app; click Takeover during a mission | #226, #238 |
| D9 | Cancelling a swarm raises `Unhandled error ... Swarm is shut down` and shows "Mission failed" while persisted state is `cancelled` | Medium | `/swarm ...`, press Cancel during stage 1 | #226 |
| D10 | A plain sentence is a web search, not a mission, and automated Google searches reach Google's captcha page | Medium | Type the sentence from the issue into the omnibar | #228, #250 |
| D11 | Chrome horizontal overflow and clipped layout buttons at the declared minimum size 800x600 | Medium | Resize to 800x600 | #237 |
| D12 | Page view is removed (blank) behind every modal instead of dimmed | Low | Open Settings | #237 |
| D13 | The first tab loads `duckduckgo.com` on every start (network request before the user acts) | Low | Launch | #248, #252 |
| D14 | Cost counter stays `$0.0000` for local models, no price entry | Low | Scenario 5 | #224 |
| D15 | Chrome renderer has no CSP (Electron security warning) | Low | Launch unpackaged | #247 |

## 6. Not measured or inconclusive

* **Real-key mission:** no key available. NOT VERIFIED.
* **Forward navigation (scenario 2):** one check failed with no explanation recorded; not investigated.
* **Resume, Hand back, Steer (scenario 7):** the precondition "the slow mission is making at least two model calls" failed
  (1 call seen), so the later call counts are not valid evidence; the state labels did change as expected. Not scored.
* **Maximise button:** `after #max-btn` reported a chrome width of 1536 DIP but the OS capture showed an unmaximised window;
  not resolved (`os_10e_maximised.png` should not be read as a maximised window).
* **Grid tile liveness and frame rate:** impossible while D1 stands.
* **Unisolated user-data launch:** see section 4 note; the final scripted check found no writes to the default directory,
  which contradicts code reading, so it is inconclusive. The default directory also holds data from earlier use of the app on
  this machine.
* Antivirus interference, a GPU crash, 125%/150% via the Windows display setting (only Chromium's scale factor was
  forced), other OSes and the packaged app.
* Horizontal overflow at 1000x700 appeared in one earlier run and not in the committed one; 800x600 overflowed in both.

## 7. Reproduce

`docs/dev/RUN_RECIPE.md`. Then `node scripts/dev/drive_baseline.mjs`; it rewrites `docs/audits/evidence/run01/` (about
15 minutes, needs a free CDP port and the desktop not otherwise in use).
