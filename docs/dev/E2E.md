# Real-app end-to-end tests

Issue #254 (TST-01). These tests launch the **built Electron app** (`dist/`) with Playwright `_electron`, drive it through its
own chrome UI, and check the outcome against an independent witness (the fixture web server, or Electron's own state).
They replace the old `tests/e2e/e2e_harness.ts`, which never started Electron.

```
npm run test:e2e            # build if dist/ is stale, then run every tests/e2e/*.spec.ts
npm run test:e2e:headed     # same, windows visible (they are real windows either way)
npx playwright test smoke   # one spec file
```

On Linux CI use `xvfb-run -a npm run test:e2e` (the CI job itself is owned by #256). Requirements: `npm ci`, and the Electron-ABI
`better-sqlite3` in `.native/` (`npm run rebuild`; global setup fetches it when missing). Windows, macOS and Linux are all
supported by the code; only Windows x64 has been run so far (see `docs/limitations.md`).

## How it works

| Piece | File | What it does |
|---|---|---|
| Config | `playwright.config.ts` | `testDir: tests/e2e`, 1 worker, 1 retry on CI, artifacts in `test-results/` |
| Build | `tests/e2e/global_setup.ts` | runs `npm run build` once when `dist/` is missing or older than `src/`; `AEGIS_E2E_SKIP_BUILD=1` skips it |
| Fixtures | `tests/e2e/fixtures.ts` | `arena` (worker): Web Arena server on an ephemeral port. `app` (per test): a fresh Electron process on a throw-away profile |
| Helpers | `tests/e2e/helpers.ts` | `openUrl`, `startMission`, `waitForStatus`, `approve`/`deny`/`answerQuestion`, `tabs`, `screenshot`, `assertArenaState`, `verifierPasses` |
| Hooks | `src/main/e2e_entry.ts`, `src/main/e2e_hooks.ts` | read-only spies, see below |
| Model modes | `src/models/demo/e2e_scripted.ts` | `scripted`, `replay`, `live` |

### Isolation (per test)

* `AEGIS_USER_DATA=<tmp>/data` (database, vault, logs) and `--user-data-dir=<tmp>/chromium` (cookies, cache, single-instance lock).
  The user's real profile is never touched and a running copy of the app on the same machine does not block the tests.
* Hermetic network: `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost`. The product's first tab
  (`https://duckduckgo.com`) therefore shows its error page; the fixture waits for that to settle before the test starts.
* `--disable-gpu` always, `--no-sandbox` only on Linux CI. These flags are added by the fixture, not by the product.
* API keys are removed from the environment unless the mode is `live`.
* Teardown closes the app, kills the process tree if it does not exit in 15 s (`taskkill /T` on Windows), and deletes the profile.

### Test hooks (never in the product)

The product entry `dist/main/index.js` is unmodified. The fixture starts `dist/main/e2e_entry.js` instead, which refuses to run
unless `AEGIS_E2E=1`, installs the hooks, and then `require`s the product entry. The hooks only **observe**: they wrap
`webContents.send` for the status / worker / evidence / telemetry / presence / question / tab events the product already
emits, spy on `Notification.show`, and publish a snapshot on `globalThis.__AEGIS_E2E__`, which tests read with
`electronApp.evaluate()` (`app.snapshot()`, `waitForStatus`). No IPC channel is added, so nothing is reachable from a renderer.

Why a separate entry and not an `AEGIS_E2E` branch in `index.ts`: nothing in the production entry changes, `package.json`
`build.files` excludes `!dist/main/e2e_*` from the packaged app, and `tests/test_e2e_harness_guard.ts` fails if any product
module names the hooks, if the exclusion disappears, or if the entry starts without `AEGIS_E2E=1`.

Snapshot contents: mission status history, workers, telemetry (tokens, cost), evidence lines, questions and approvals, tab list as
reported to the chrome window, **every live WebContents with its real URL** (ground truth from Electron), notifications, last
presence event, and the model state (scripted steps consumed, deviations, cost).

### Model modes (`AEGIS_E2E_MODEL_MODE`, set by the fixture from `test.use({ modelMode })`)

* `scripted` (default for specs): `test.use({ script: { build: ({ arenaUrl }) => steps }, verifierScript })`. A step is
  `{ expectTools?, expectPageContains?, expectPromptContains?, respond: { tool, args } | { text } }`. The provider fails the mission
  and records a **deviation** when the loop offers different tools, perceives a different page, runs past the script, or when a
  scripted step was never used. The `app` fixture turns recorded deviations and unconsumed steps into test failures
  (`allowDeviations`, `allowUnconsumedScript` opt out for negative tests). The actor and the independent completion verifier
  have separate scripts and are tracked separately. No tokens are used and none are reported.
* `replay`: `test.use({ modelMode: 'replay', replayFile })` serves recorded request-hash to response pairs (hash covers system prompt,
  tool names and messages, with port, timestamps and mission ids normalised). A miss is a deviation. `AEGIS_E2E_RECORD=1` plus
  a real key and `AEGIS_E2E_MAX_COST_USD` records new pairs.
* `live`: real provider, `AEGIS_E2E_MAX_COST_USD` is a hard cap shared by the actor and the verifier (refuses to start without it).
  Excluded from PR CI; no live spec ships yet.

### Artifacts

Per test, under `test-results/<test>/`: `electron.log` (stdout and stderr of the app), `app-logs/` (the product's own `app.log`),
and on failure a Playwright `trace.zip` (screenshots and snapshots), a screenshot of every window, `e2e-snapshot.json` (hook state),
`arena-state.json`, and, with `AEGIS_E2E_VIDEO=on`, a `video/` (needs `npx playwright install ffmpeg`). `preserveOutput` is `always` on CI
and `failures-only` locally. Open a trace with `npx playwright show-trace <trace.zip>`.

## Writing a spec

```ts
import { test, expect } from './fixtures.js';
import { openUrl, startMission, waitForStatus, verifierPasses } from './helpers.js';

test.use({
  script: { build: () => [
    { expectPageContains: ['Web Arena Test Suite'], respond: { tool: 'click', args: { ref: 'e1' } } },
    { respond: { tool: 'done', args: { result: 'Reached the shop', evidence: [] } } }
  ] },
  verifierScript: { build: () => [verifierPasses('Reached the shop')] }
});

test('example', async ({ app }) => {
  await openUrl(app, `${app.arena.baseUrl}/`);
  await startMission(app, 'open the shop');
  expect((await waitForStatus(app, ['completed', 'failed'])).status).toBe('completed');
  expect((await app.arena.state()).pageViews).toEqual(['/', '/shop']);   // the server's view, not the app's
});
```

Rules: assert against something the product cannot fake (the fixture server, the native tab's DOM, `contents` from Electron);
wait on events (`waitForStatus`, web-first `expect(...)`), never sleep; a spec must fail when its feature breaks.
To find element refs for a script, add a step with `expectPageContains: ['__probe__']` and `allowDeviations: true`: the deviation
message prints the page observation the loop sent.

## Specs

| Spec | Proves |
|---|---|
| `smoke.spec.ts` launch | real Electron version, isolated profile and database, chrome renders from `dist/renderer`, native tab exists, startup log line |
| `smoke.spec.ts` scripted mission | a mission started from the omnibar clicks a link in a native tab; the server sees `/` then `/shop`; the verifier passes; the loop saw the scripted page |
| `mission_form.spec.ts` Approve / Deny | typing runs in the page; the irreversible submit waits for the approval card; the server sees nothing before Approve, one submission after it, none after Deny; the honeypot stays empty; the mission is persisted |
| `mission_controls.spec.ts` | Pause parks the loop (the mission does not complete while paused), Resume finishes it |
| `script_guard.spec.ts` | the harness itself: a wrong page observation fails the mission and is recorded, and the scripted action never runs |
