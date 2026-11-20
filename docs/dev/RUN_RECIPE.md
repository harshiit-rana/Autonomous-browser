# Run recipe: build, launch, attach and drive the real app

Written for issue #223 (RUN-01). Every command below was run on the machine named in `docs/audits/RUNNING_APP_BASELINE.md`
(Windows 11, Node 22, Electron 33.4.11). Use it to reproduce a defect or to demonstrate a fix in the running app
until the Playwright `_electron` harness (#254, see `docs/dev/E2E.md`) replaces it. Prefer `npm run test:e2e`; this recipe stays for manual looks and OS-level screenshots.

## 1. Environment

```
node -v                      # 20 or 22
npm ci
npm run rebuild              # fetches the Electron-ABI better-sqlite3 into .native/ (see scripts/sqlite_native.mjs)
npm run rebuild:verify       # loads it inside the real Electron runtime; must print OK before you launch
```

`npm ci` alone is not enough: without `npm run rebuild` the app cannot open its database and exits at startup.
The baseline run used a copy of an existing `node_modules` and `.native/` from a sibling worktree, so `npm ci` itself was
not re-run for #223.

## 2. Build

```
npm run build                # tsc -b && copy_assets && bundle_preload (esbuild) && vite build
```

Check that `dist/main/index.js`, `dist/main/preload.js` (self-contained, no relative `require`) and
`dist/renderer/index.html` exist. The preload must be bundled: the chrome window runs with `sandbox: true`, and an unbundled
preload leaves `window.aegis` undefined.

## 3. Launch

```
npm start                                                   # = electron dist/main/index.js
npm start -- --remote-debugging-port=9333                   # with a CDP port for Playwright
```

`--remote-debugging-port` is a plain Chromium switch; the app needs no code to forward it (the log prints
`DevTools listening on ws://127.0.0.1:9333/...`).

Things that bite:

* **Port in use.** If the port is taken the app still starts, logs `Cannot start http server for devtools`, and nothing
  is listening. On the baseline machine the user's own Chrome held 9222. Pick a free port and confirm the endpoint
  answers (`curl http://127.0.0.1:9333/json/version`).
* **Isolated profile.** `AEGIS_USER_DATA=<dir>` moves the app's own files (database, vault, logs, deliverables) only. Chromium's
  profile (cookies, cache, local storage, the single-instance lock) stays in `%APPDATA%\autonomous-browser` unless you also
  pass `--user-data-dir=<dir>\chromium`. Always pass both for a reproducible run.
  `ELECTRON_RUN_AS_NODE` must be absent from the environment (not just empty).
* **Logs.** `ELECTRON_ENABLE_LOGGING=1` makes Electron write renderer console output to stderr; redirect stdout and
  stderr of the launch to a file.

## 4. Attach and drive

`scripts/dev/drive_baseline.mjs` does all of this and writes the evidence folder:

```
node scripts/dev/drive_baseline.mjs [--out docs/audits/evidence/run01] [--port 9333] [--only 1,2,3]
```

It spawns Electron as above, attaches with `chromium.connectOverCDP`, finds the chrome renderer page
(`file:///.../renderer/index.html`) and the native tab pages (every other page target), and drives the UI through DOM
events and the `window.aegis` bridge.

Manual attach from your own script:

```js
const { chromium } = require('playwright-core');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const pages = browser.contexts()[0].pages();
const chrome = pages.find(p => p.url().includes('renderer/index.html'));  // the chrome UI
const tabs   = pages.filter(p => !p.url().startsWith('file://'));        // WebContentsView pages
```

### Screenshots: CDP is not enough

`page.screenshot()` on the chrome page captures only the chrome renderer. The native `WebContentsView` that shows the
website is a separate child window and is **not in that image**. To see what the user sees use the OS capture helper:

```
powershell -NoProfile -File scripts/dev/os_screenshot.ps1 -ProcessId <electron main pid> -Out shot.png
powershell -NoProfile -File scripts/dev/os_screenshot.ps1 -ProcessId <pid> -Children        # native view geometry (Win32 child HWNDs)
powershell -NoProfile -File scripts/dev/os_screenshot.ps1 -ProcessId <pid> -SetSize 1000x700  # resize the window (DIP)
powershell -NoProfile -File scripts/dev/png_diff.ps1 -PathA a.png -PathB b.png -Region x,y,w,h  # changed pixels
```

The helper brings the window to the foreground and copies the screen, so keep other windows off it and look at each image.
`document.innerWidth` inside a native view does **not** follow `setBounds(0,0,0,0)`; use `-Children` for real geometry.

### Model

* With a key: set it through Settings in the UI (never commit it, never put it in a script).
* Without a key or a local Ollama: `drive_baseline.mjs` starts a scripted OpenAI-compatible stub on a local port and points
  the Ollama provider at it. **It is not a model.** It lets the agent loop, step feed, counters and controls run; it proves
  nothing about answer quality. Scenarios that use it say so.

## 5. Output

`docs/audits/evidence/run01/`: `electron.log`, `build.log`, `os_*.png` (real window), `cdp_*.png` (chrome renderer only),
`scenario_results.json` (checks, observations and raw measurements; `RUNNING_APP_BASELINE.md` is written from it).

## 6. Clean up

Kill the process tree (`taskkill /PID <pid> /T /F`); delete the temp profile directories the driver printed.
