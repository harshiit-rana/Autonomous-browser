/**
 * Real-app e2e fixtures (#254): a Playwright `test` whose `app` fixture launches the built Electron app.
 *
 *   arena (worker)  one Web Arena server on an ephemeral loopback port, state reset before every test
 *   app   (test)    a fresh Electron process per test with its own throw-away profile:
 *                     AEGIS_USER_DATA=<tmp>/data  (database, vault, logs, deliverables)
 *                     --user-data-dir=<tmp>/chromium  (cookies, cache, single-instance lock)
 *                   model mode scripted | replay | live (see src/models/demo/e2e_scripted.ts)
 *
 * The app under test is `dist/main/index.js`, started through `dist/main/e2e_entry.js`, which only installs read-only
 * observation hooks. On failure the fixture keeps: a trace, a screenshot of every window, the Electron log, the app's
 * own log folder, the hook snapshot and (opt-in) a video, all under `test-results/`.
 */
import { test as base, expect, _electron, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebArenaServer } from '../../src/testing/arena_server.js';
import type { E2EScriptStep } from '../../src/models/demo/e2e_scripted.js';
import type { E2ESnapshot } from '../../src/main/e2e_hooks.js';

export const ROOT = path.resolve(__dirname, '..', '..');
const ENTRY = path.join(ROOT, 'dist', 'main', 'e2e_entry.js');

export type ModelMode = 'scripted' | 'replay' | 'live';
/** An object, not a bare function: Playwright treats a function-valued test.use() option as a fixture definition. */
export interface ScriptSpec {
  build(ctx: { arenaUrl: string }): E2EScriptStep[];
}

export interface ArenaState {
  orders: Array<{ orderId: string; item: string; price: number; address: string }>;
  loginAttempts: Array<{ username: string; success: boolean }>;
  submittedForms: Array<{ formId: string; fields: Record<string, string>; honeypotTriggered: boolean }>;
  flaggedAttacks: Array<{ attackType: string; payload: string; blocked: boolean }>;
  pageViews: string[];
  activeSessionsCount: number;
}

export interface ArenaHandle {
  /** Origin the app is pointed at: the server binds 127.0.0.1 on an ephemeral port. */
  baseUrl: string;
  /** What the fixture server itself recorded (GET /__state), independent of anything the app reports. */
  state(): Promise<ArenaState>;
  reset(): Promise<void>;
}

export interface AppHandle {
  electronApp: ElectronApplication;
  /** The chrome (renderer) window: omnibar, tab strip, mission control. Native tab views are separate pages. */
  chromePage: Page;
  arena: ArenaHandle;
  modelMode: ModelMode;
  userDataDir: string;
  logFile: string;
  /** Read-only snapshot published by the main-process hooks (src/main/e2e_hooks.ts). */
  snapshot(): Promise<E2ESnapshot>;
}

interface TestOptions {
  modelMode: ModelMode;
  /** Scripted mode: the model's answers, built once the arena port is known. */
  script: ScriptSpec | undefined;
  /** Scripted mode: the orchestrator's `submit_plan` answers (`AEGIS_E2E_ORCHESTRATOR_SCRIPT`). Omit for default single-agent plan. */
  orchestratorScript: ScriptSpec | undefined;
  /** Scripted mode: the independent completion verifier's answers (`report_verdict`). Empty means any verifier call is a deviation. */
  verifierScript: ScriptSpec | undefined;
  /** Replay mode: path of a recording (record new misses with AEGIS_E2E_RECORD=1 and a live key). */
  replayFile: string | undefined;
  /** Negative tests only: the script is expected to be violated, so recorded deviations do not fail the test. */
  allowDeviations: boolean;
  /** Tests that stop a mission early: do not require the whole script to have been consumed. */
  allowUnconsumedScript: boolean;
}

export const test = base.extend<{ app: AppHandle } & TestOptions, { arena: ArenaHandle }>({
  modelMode: ['scripted', { option: true }],
  script: [undefined, { option: true }],
  orchestratorScript: [undefined, { option: true }],
  verifierScript: [undefined, { option: true }],
  replayFile: [undefined, { option: true }],
  allowDeviations: [false, { option: true }],
  allowUnconsumedScript: [false, { option: true }],

  arena: [
    async ({}, use) => {
      const server = new WebArenaServer();
      const port = await server.start(0); // ephemeral: no port collisions
      const baseUrl = `http://127.0.0.1:${port}`;
      const handle: ArenaHandle = {
        baseUrl,
        state: async () => (await fetch(`${baseUrl}/__state`)).json() as Promise<ArenaState>,
        reset: async () => { await fetch(`${baseUrl}/api/oracle/reset`, { method: 'POST' }); }
      };
      await use(handle);
      await server.stop();
    },
    { scope: 'worker' }
  ],

  app: async ({ arena, modelMode, script, orchestratorScript, verifierScript, replayFile, allowDeviations, allowUnconsumedScript }, use, testInfo) => {
    await arena.reset();
    if (modelMode === 'live' && !process.env.AEGIS_E2E_MAX_COST_USD) {
      throw new Error('modelMode "live" requires AEGIS_E2E_MAX_COST_USD (hard cost cap in USD)');
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-e2e-'));
    const userDataDir = path.join(tmp, 'data');
    const chromiumDir = path.join(tmp, 'chromium');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(testInfo.outputDir, { recursive: true });
    const logFile = path.join(testInfo.outputDir, 'electron.log');

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    delete env.ELECTRON_RUN_AS_NODE; // must be absent, not empty
    if (modelMode !== 'live') for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete env[k];
    Object.assign(env, {
      AEGIS_E2E: '1',
      AEGIS_E2E_MODEL_MODE: modelMode,
      AEGIS_USER_DATA: userDataDir,
      AEGIS_ARENA: arena.baseUrl,
      ELECTRON_ENABLE_LOGGING: '1'
    });
    if (modelMode === 'scripted') {
      // No script means the test starts no mission: any model call is then a deviation.
      const file = path.join(tmp, 'script.json');
      fs.writeFileSync(file, JSON.stringify(script ? script.build({ arenaUrl: arena.baseUrl }) : [], null, 2));
      env.AEGIS_E2E_SCRIPT = file;
      const verifierFile = path.join(tmp, 'verifier_script.json');
      fs.writeFileSync(verifierFile, JSON.stringify(verifierScript ? verifierScript.build({ arenaUrl: arena.baseUrl }) : [], null, 2));
      env.AEGIS_E2E_VERIFIER_SCRIPT = verifierFile;
      if (orchestratorScript) {
        const orchFile = path.join(tmp, 'orchestrator_script.json');
        fs.writeFileSync(orchFile, JSON.stringify(orchestratorScript.build({ arenaUrl: arena.baseUrl }), null, 2));
        env.AEGIS_E2E_ORCHESTRATOR_SCRIPT = orchFile;
      }
    } else if (modelMode === 'replay') {
      if (!replayFile) throw new Error('replay mode needs test.use({ replayFile })');
      env.AEGIS_E2E_REPLAY = path.resolve(ROOT, replayFile);
    }

    // Flags only the e2e environment adds: hermetic network (loopback only), no GPU dependency, and a no-sandbox
    // Linux CI runner. The product's own flags and sandboxing are untouched everywhere else.
    const args = [
      `--user-data-dir=${chromiumDir}`,
      '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost',
      '--disable-gpu'
    ];
    if (process.platform === 'linux' && process.env.CI) args.push('--no-sandbox');
    args.push(ENTRY);

    const recordVideo = (process.env.AEGIS_E2E_VIDEO ?? 'off') !== 'off'
      ? { dir: path.join(testInfo.outputDir, 'video') }
      : undefined;

    const electronApp = await _electron.launch({
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      executablePath: require('electron') as unknown as string,
      args,
      env,
      cwd: ROOT,
      timeout: 60_000,
      recordVideo
    });

    const logStream = fs.createWriteStream(logFile, { flags: 'w' });
    electronApp.process().stdout?.on('data', d => logStream.write(d));
    electronApp.process().stderr?.on('data', d => logStream.write(d));

    const snapshot = (): Promise<E2ESnapshot> =>
      electronApp.evaluate(() => (globalThis as any).__AEGIS_E2E__.snapshot()) as Promise<E2ESnapshot>;

    let tracing = false;
    try {
      await electronApp.context().tracing.start({ screenshots: true, snapshots: true });
      tracing = true;
    } catch { /* tracing is best effort: a failing test is more useful than none */ }

    const chromePage = await findChromePage(electronApp);
    await chromePage.waitForFunction(() => Boolean((window as any).aegis?.startMission), null, { timeout: 30_000 });
    const handle: AppHandle = { electronApp, chromePage, arena, modelMode, userDataDir, logFile, snapshot };

    // Settle the first tab before the test starts. The product opens https://duckduckgo.com on launch; with the network
    // closed that load fails and the product swaps in its error page a moment later. A test that navigates before then
    // would be overwritten by that swap (and the omnibar by the matching tab patch), so wait for both.
    await expect.poll(async () => (await snapshot()).contents.some(c => c.url.startsWith('data:text/html')), { message: 'initial tab settled on the product error page', timeout: 30_000 }).toBe(true);
    await expect.poll(async () => {
      const s = await snapshot();
      const active = s.tabs.find(t => t.id === s.activeTabId);
      return active ? await chromePage.locator('#omnibar-input').inputValue() === active.url : false;
    }, { message: 'omnibar in sync with the active tab', timeout: 30_000 }).toBe(true);

    let useError: unknown;
    try {
      await use(handle);
    } catch (err) {
      useError = err;
    }

    // ---- teardown: evidence first (while the app is alive), then the process
    const failed = testInfo.status !== testInfo.expectedStatus || useError !== undefined;
    let finalSnapshot: E2ESnapshot | undefined;
    try { finalSnapshot = await snapshot(); } catch { /* app already gone */ }

    if (failed) await collectFailureArtifacts(handle, testInfo, finalSnapshot);
    if (tracing) {
      try {
        await electronApp.context().tracing.stop(failed ? { path: path.join(testInfo.outputDir, 'trace.zip') } : undefined);
        if (failed) await testInfo.attach('trace', { path: path.join(testInfo.outputDir, 'trace.zip'), contentType: 'application/zip' });
      } catch { /* ignore */ }
    }
    await closeApp(electronApp);
    logStream.end();
    // Logs are small: keep them for every test (CI sets preserveOutput: always). Heavy artifacts only on failure.
    const logsDir = path.join(userDataDir, 'logs');
    if (fs.existsSync(logsDir)) fs.cpSync(logsDir, path.join(testInfo.outputDir, 'app-logs'), { recursive: true });
    if (failed) await testInfo.attach('electron.log', { path: logFile, contentType: 'text/plain' });
    await attachVideos(electronApp, testInfo, failed);
    removeDir(tmp);

    if (useError !== undefined) throw useError;

    // ---- the model script is part of the assertion: deviations and unconsumed steps fail the test
    const model = finalSnapshot?.model as { deviations: string[]; roles: Record<string, { scriptSteps: number; consumed: number }>; mode: string } | null | undefined;
    if (modelMode === 'scripted' && !allowDeviations) {
      expect(model?.deviations ?? [], 'model script deviations').toEqual([]);
    }
    if (modelMode === 'scripted' && !allowUnconsumedScript && !allowDeviations && model) {
      for (const [role, progress] of Object.entries(model.roles)) {
        expect(progress.consumed, `scripted ${role} steps consumed by the agent loop`).toBe(progress.scriptSteps);
      }
    }
  }
});

export { expect };

async function findChromePage(electronApp: ElectronApplication): Promise<Page> {
  const isChrome = (p: Page) => /renderer[\\/]index\.html/.test(p.url()) || /renderer\/index\.html/.test(p.url());
  const first = await electronApp.firstWindow();
  await first.waitForLoadState('domcontentloaded');
  const known = electronApp.windows().find(isChrome);
  if (known) return known;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const hit = electronApp.windows().find(isChrome);
    if (hit) return hit;
    const next = await electronApp.waitForEvent('window', { timeout: 5_000 }).catch(() => null);
    if (next && isChrome(next)) return next;
  }
  throw new Error(`The chrome window (renderer/index.html) did not appear; windows: ${electronApp.windows().map(w => w.url()).join(', ')}`);
}

async function collectFailureArtifacts(app: AppHandle, testInfo: TestInfo, snap: E2ESnapshot | undefined): Promise<void> {
  const windows = app.electronApp.windows();
  for (const [i, page] of windows.entries()) {
    try {
      const file = path.join(testInfo.outputDir, `window-${i}.png`);
      await page.screenshot({ path: file, timeout: 5_000 });
      await testInfo.attach(`window-${i}`, { path: file, contentType: 'image/png' });
    } catch { /* a closed or crashed window cannot be captured */ }
  }
  if (snap) {
    await testInfo.attach('e2e-snapshot.json', { body: JSON.stringify(snap, null, 2), contentType: 'application/json' });
  }
  try {
    await testInfo.attach('arena-state.json', { body: JSON.stringify(await app.arena.state(), null, 2), contentType: 'application/json' });
  } catch { /* arena gone */ }
}

async function attachVideos(electronApp: ElectronApplication, testInfo: TestInfo, keep: boolean): Promise<void> {
  for (const page of electronApp.windows()) {
    const video = page.video();
    if (!video) continue;
    try {
      if (keep) await testInfo.attach('video', { path: await video.path(), contentType: 'video/webm' });
      else await video.delete();
    } catch { /* video not finalised */ }
  }
}

/** Closes the app; if it does not exit in time, kills the whole process tree so nothing outlives the test. */
async function closeApp(electronApp: ElectronApplication): Promise<void> {
  const proc = electronApp.process();
  const exited = new Promise<void>(resolve => { if (proc.exitCode !== null) resolve(); else proc.once('exit', () => resolve()); });
  const closed = electronApp.close().catch(() => undefined);
  const timeout = new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 15_000));
  const result = await Promise.race([Promise.all([closed, exited]).then(() => 'closed' as const), timeout]);
  if (result === 'timeout' && proc.pid) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
    else { try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch { /* gone */ } } }
  }
}

function removeDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); } catch { /* AV or a lingering handle on Windows; the OS temp cleaner owns it */ }
}
