#!/usr/bin/env node
/**
 * Real-app check for #232 (LIV-01): the live Swarm Grid in the running Electron app (Windows).
 *
 * Starts the built app with AEGIS_TEST_MODE=1 (test-only IPC hooks that spawn REAL WorkerHosts through a real
 * SwarmManager; no model is involved) and drives it over CDP and real OS screenshots:
 *   1. D1 repro: 3 tabs on the animated fixture, Grid -> every tile gets frames (window.__tileStats) and changes.
 *   2. 6 real fixture workers (+3 tabs = 9 tiles): per-tile frames in the first 2 s, distinct hashes, OS-screenshot
 *      pixel change per tile 1 s apart, page rAF of visible vs parked workers, layout viewport under tile zoom and a
 *      real executor click (CDP Input) landing under zoom, main-process CPU while streaming.
 *   3. Resize, minimise/restore (no reload), worker crash (last frame + badge) and recovery, worker retire,
 *      renderer reload (frames port re-sent), promote a worker tile to the Stage.
 *
 *   npm run build
 *   node scripts/dev/drive_live_grid.mjs [--out docs/audits/evidence/232] [--port 9351] [--workers 6]
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const electronExe = require('electron');
const root = path.resolve(import.meta.dirname, '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const outDir = path.resolve(root, arg('out', 'docs/audits/evidence/232'));
const port = Number(arg('port', '9351'));
const workerCount = Number(arg('workers', '6'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- fixture server (127.0.0.1, random port)
const fixtureHtml = fs.readFileSync(path.join(root, 'fixtures', 'pages', 'visibility.html'));
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(fixtureHtml); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const fixture = label => `http://127.0.0.1:${server.address().port}/visibility.html?w=${label}`;

const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-232-'));
const env = { ...process.env, AEGIS_USER_DATA: prof, ELECTRON_ENABLE_LOGGING: '1', AEGIS_TEST_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete env[k];

const logStream = fs.createWriteStream(path.join(outDir, 'electron.log'));
let log = '';
// CalculateNativeWinOcclusion off: another window on this shared desktop must not freeze the views mid-run
// (Windows occlusion tracking is not part of what this run measures; see docs/limitations.md).
const child = spawn(electronExe, [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(prof, 'chromium')}`, '--disable-features=CalculateNativeWinOcclusion', path.join(root, 'dist', 'main', 'index.js')], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
for (const s of [child.stdout, child.stderr]) s.on('data', d => { log += d.toString(); logStream.write(d); });

const results = [];
const observations = {};
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const ps = (args) => spawnSync('powershell', ['-NoProfile', '-NonInteractive', ...args], { encoding: 'utf8' });
const shot = name => {
  const r = ps(['-File', path.join(root, 'scripts/dev/os_screenshot.ps1'), '-ProcessId', String(child.pid), '-Out', path.join(outDir, name)]);
  const line = (r.stdout || r.stderr || '').trim().split('\n').pop();
  console.log(`screenshot ${name}: ${line}`);
  return line;
};
const diff = (a, b, rect) => {
  const r = ps(['-File', path.join(root, 'scripts/dev/png_diff.ps1'), '-PathA', path.join(outDir, a), '-PathB', path.join(outDir, b), '-Region', rect.join(',')]);
  const m = (r.stdout || '').match(/changed=(\d+) total=(\d+)/);
  return m ? { changed: Number(m[1]), total: Number(m[2]) } : { changed: -1, total: -1, err: (r.stderr || r.stdout).slice(0, 200) };
};
const cpuSeconds = pid => {
  const r = ps(['-Command', `(Get-Process -Id ${pid}).TotalProcessorTime.TotalSeconds`]);
  return Number(String(r.stdout).trim().replace(',', '.'));
};

let browser, chrome;
const ipc = async (fn, ...a) => {
  const r = await chrome.evaluate(([f, args]) => window.aegis[f](...args), [fn, a]);
  if (r && r.ok === false) throw new Error(`${fn}: ${r.error}`);
  return r?.data;
};
const stats = () => chrome.evaluate(() => JSON.parse(JSON.stringify(window.__tileStats || {})));
const tiles = () => chrome.$$eval('#swarm-grid-container .live-tile', els => els.map(e => {
  const f = e.querySelector('.tile-frame').getBoundingClientRect();
  return { id: e.dataset.id, presentation: e.dataset.presentation, hasFrame: e.classList.contains('has-frame'), badge: e.querySelector('.tile-badge').classList.contains('hidden') ? '' : e.querySelector('.tile-badge').textContent, chip: e.querySelector('.tile-chip').textContent, name: e.querySelector('.tile-name').textContent, rect: { x: f.x, y: f.y, w: f.width, h: f.height } };
}));
const framesIn = (st, fromMs, windowMs) => (st.times || []).filter(t => t >= fromMs && t <= fromMs + windowMs).length;

try {
  for (let i = 0; i < 60 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 }); } catch { await sleep(500); }
  }
  if (!browser) throw new Error('could not attach CDP');
  for (let i = 0; i < 60 && !chrome; i++) { chrome = browser.contexts()[0].pages().find(p => p.url().includes('renderer/index.html')); await sleep(250); }
  if (!chrome) throw new Error('chrome renderer not found');
  await sleep(2500);
  const dpr = await chrome.evaluate(() => window.devicePixelRatio);
  observations.dpr = dpr;
  check('test mode is on and logged as test-only', /AEGIS_TEST_MODE=1: test-only IPC hooks/.test(log));
  const flags = await ipc('getRuntimeFlags');
  check('renderer sees test mode (exposes window.__tileStats)', flags?.testMode === true && await chrome.evaluate(() => typeof window.__tileStats === 'object'));

  // ---------------------------------------------------------------- 1. D1 repro: 3 tabs, Grid
  const firstTab = (await ipc('getGridSources')).sources.find(s => s.kind === 'tab');
  await ipc('navigateTab', fixture('T1'), firstTab.id);
  await ipc('createTab', fixture('T2'), false);
  await ipc('createTab', fixture('T3'), false);
  await sleep(2000);
  await chrome.click('#layout-grid-btn');
  const t0 = await chrome.evaluate(() => performance.now());
  await sleep(3000);
  let st = await stats();
  let ts = await tiles();
  observations.d1_tiles = ts;
  observations.d1_stats = Object.fromEntries(Object.entries(st).map(([k, v]) => [k, { frames: v.frames, distinct: v.distinctHashes, source: v.lastSource, size: v.lastSize, first2s: framesIn(v, v.subscribedAt ?? t0, 2000) }]));
  check('D1 repro: Grid with 3 tabs renders 3 tiles', ts.length === 3, ts.map(t => `${t.name}:${t.presentation}`).join(' | '));
  check('D1 repro: every tab tile received >= 5 live frames in its first 2 s', ts.length === 3 && ts.every(t => framesIn(st[t.id] || {}, st[t.id]?.subscribedAt ?? t0, 2000) >= 5), JSON.stringify(observations.d1_stats));
  check('D1 repro: every tab tile shows >= 3 distinct frame hashes', ts.length === 3 && ts.every(t => (st[t.id]?.distinctHashes || 0) >= 3));
  shot('os_01_grid_3tabs.png');

  // ---------------------------------------------------------------- 2. real workers
  const spawned = await ipc('testSpawnWorkers', workerCount, fixture('W'));
  const workerIds = spawned.ids;
  check(`${workerCount} real WorkerHosts spawned through SwarmManager`, workerIds.length === workerCount, workerIds.join(','));
  const tw = await chrome.evaluate(() => performance.now());
  await sleep(4000);
  st = await stats();
  ts = await tiles();
  const wTiles = ts.filter(t => workerIds.includes(t.id));
  observations.worker_tiles = wTiles;
  check(`Grid shows ${workerCount} worker tiles + 3 tab tiles`, wTiles.length === workerCount && ts.length === workerCount + 3, `${ts.length} tiles`);
  const visibleW = wTiles.filter(t => t.presentation === 'visible');
  observations.worker_stats = Object.fromEntries(workerIds.map(id => [id, { frames: st[id]?.frames, distinct: st[id]?.distinctHashes, source: st[id]?.lastSource, size: st[id]?.lastSize, subscribedAt: st[id]?.subscribedAt, firstFrameAt: st[id]?.firstFrameAt }]));
  check('worker tiles fully on screen are live native views (presentation visible)', visibleW.length >= Math.min(workerCount, 6), visibleW.map(t => t.id).join(','));
  // Frames in the first 2 s after the first frame (page load time excluded: the worker navigates after spawn).
  const per2s = Object.fromEntries(visibleW.map(t => [t.id, framesIn(st[t.id] || {}, st[t.id]?.firstFrameAt ?? tw, 2000)]));
  observations.worker_frames_first_2s = per2s;
  check('every visible worker tile received >= 5 frames in its first 2 s of frames', visibleW.length > 0 && visibleW.every(t => per2s[t.id] >= 5), JSON.stringify(per2s));
  check('every visible worker tile has >= 3 distinct frame hashes', visibleW.length > 0 && visibleW.every(t => (st[t.id]?.distinctHashes || 0) >= 3), JSON.stringify(observations.worker_stats));
  check('frames come from the CDP screencast (not capturePage)', visibleW.every(t => st[t.id]?.lastSource === 'screencast'), visibleW.map(t => st[t.id]?.lastSource).join(','));

  // Pixel change in the real OS window, per tile, 1 s apart
  shot('os_02a_grid_workers.png');
  await sleep(1000);
  shot('os_02b_grid_workers_1s_later.png');
  const tilePixelChange = {};
  for (const t of ts.filter(t => t.presentation === 'visible')) {
    const r = [Math.round(t.rect.x * dpr), Math.round(t.rect.y * dpr), Math.round(t.rect.w * dpr), Math.round(t.rect.h * dpr)];
    tilePixelChange[t.id] = diff('os_02a_grid_workers.png', 'os_02b_grid_workers_1s_later.png', r);
  }
  observations.os_tile_pixel_change = tilePixelChange;
  check('OS screenshot: every visible tile region changed between two samples 1 s apart', Object.keys(tilePixelChange).length > 0 && Object.values(tilePixelChange).every(d => d.changed > 200), JSON.stringify(tilePixelChange));

  // Does the page run? rAF of a visible worker vs a parked one, over 1 s
  const vpA = {}, vpB = {};
  for (const id of workerIds) vpA[id] = await ipc('testWorkerAction', 'viewport', id);
  await sleep(1000);
  for (const id of workerIds) vpB[id] = await ipc('testWorkerAction', 'viewport', id);
  const rafRate = Object.fromEntries(workerIds.map(id => [id, vpB[id].page.raf - vpA[id].page.raf]));
  observations.worker_raf_per_s = rafRate;
  observations.worker_viewport = vpB;
  check('visible worker pages run (rAF >= 30/s)', visibleW.every(t => rafRate[t.id] >= 30), JSON.stringify(rafRate));
  check('tile zoom keeps the worker layout viewport near 1280 CSS px wide', visibleW.every(t => Math.abs(vpB[t.id].page.innerWidth - 1280) <= 64), visibleW.map(t => `${t.id}: ${vpB[t.id].page.innerWidth}x${vpB[t.id].page.innerHeight} zoom ${vpB[t.id].zoom.toFixed(3)} dpr ${vpB[t.id].page.dpr}`).join(' | '));
  // ADR 0010 zoom check: the executor's CDP click (page CSS px) lands on the fixture button under tile zoom.
  const probe = visibleW[0]?.id;
  if (probe) {
    const before = (await ipc('testWorkerAction', 'viewport', probe)).page.clicks;
    await ipc('testWorkerAction', 'click', probe, 160, 120);
    await sleep(300);
    const after = (await ipc('testWorkerAction', 'viewport', probe)).page.clicks;
    check('under tile zoom an ActionExecutor click at the button centre lands (+1)', after === before + 1, `clicks ${before} -> ${after}`);
  }

  // Main-process CPU while 6+ tiles stream (budget ADR 0010: <= 25 % of one core at N=6)
  const c0 = cpuSeconds(child.pid), w0 = Date.now();
  await sleep(10000);
  const c1 = cpuSeconds(child.pid), w1 = Date.now();
  const mainCpu = ((c1 - c0) / ((w1 - w0) / 1000)) * 100;
  const st10 = await stats();
  const fpsPerTile = Object.fromEntries(ts.filter(t => t.presentation === 'visible').map(t => [t.id, framesIn(st10[t.id] || {}, 0, Infinity)]));
  observations.main_cpu_pct_one_core = Number(mainCpu.toFixed(1));
  observations.visible_tiles_during_cpu = Object.keys(fpsPerTile).length;
  check(`main-process CPU with ${Object.keys(fpsPerTile).length} streaming tiles <= 25 % of one core`, mainCpu <= 25, `${mainCpu.toFixed(1)} %`);

  // Parked tiles (not fully on screen) show a still and the paused badge
  ts = await tiles();
  const parked = ts.filter(t => t.presentation === 'parked');
  observations.parked_tiles = parked;
  if (parked.length) {
    check('tiles not fully on screen are parked with the "Paused" badge', parked.every(t => /Paused/.test(t.badge)), parked.map(t => `${t.id}:${t.badge}`).join(' | '));
    check('parked tiles show a still (capturePage), not an empty box', parked.every(t => t.hasFrame), parked.map(t => `${t.id}:${t.hasFrame}`).join(' | '));
  }

  // ---------------------------------------------------------------- 3a. resize
  ps(['-File', path.join(root, 'scripts/dev/os_screenshot.ps1'), '-ProcessId', String(child.pid), '-SetSize', '1000x700']);
  await sleep(1500);
  const children = ps(['-File', path.join(root, 'scripts/dev/os_screenshot.ps1'), '-ProcessId', String(child.pid), '-Children']).stdout;
  fs.writeFileSync(path.join(outDir, 'children_after_resize.txt'), children);
  ts = await tiles();
  const visAfter = ts.filter(t => t.presentation === 'visible');
  let hwnds = [];
  try { hwnds = JSON.parse((children.match(/children=(\[.*\])/) || [])[1] || '[]'); } catch { hwnds = []; }
  const rects = hwnds.filter(h => h.class === 'Chrome_RenderWidgetHostHWND').map(h => [h.x, h.y, h.w, h.h]);
  const top = (children.match(/top=(-?\d+),(-?\d+)/) || []).slice(1).map(Number);
  observations.resize = { window: top, visibleTiles: visAfter.map(t => ({ id: t.id, rect: t.rect })), hwndRects: rects };
  const matched = visAfter.filter(t => rects.some(r => Math.abs(r[2] - t.rect.w * dpr) <= 2 && Math.abs(r[3] - t.rect.h * dpr) <= 2 && Math.abs(r[0] - top[0] - t.rect.x * dpr) <= 2 && Math.abs(r[1] - top[1] - t.rect.y * dpr) <= 2));
  check('after resize to 1000x700 every visible tile has a native view at its DOM rect (within 2 px)', visAfter.length > 0 && matched.length === visAfter.length, `${matched.length}/${visAfter.length} matched`);
  shot('os_03_after_resize.png');
  ps(['-File', path.join(root, 'scripts/dev/os_screenshot.ps1'), '-ProcessId', String(child.pid), '-SetSize', '1400x900']);
  await sleep(1500);

  // ---------------------------------------------------------------- 3b. minimise / restore
  const liveId = (await tiles()).find(t => t.presentation === 'visible' && workerIds.includes(t.id))?.id;
  const beforeMin = (await ipc('testWorkerAction', 'viewport', liveId)).page;
  await ipc('minimize');
  await sleep(1500);
  const sMin1 = (await stats())[liveId]?.frames;
  await sleep(1500);
  const sMin2 = (await stats())[liveId]?.frames;
  await ipc('testWorkerAction', 'restoreWindow');
  await sleep(2500);
  const sRes = (await stats())[liveId]?.frames;
  const afterRes = (await ipc('testWorkerAction', 'viewport', liveId)).page;
  observations.minimise = { liveId, framesWhileMinimised: [sMin1, sMin2], framesAfterRestore: sRes, tmrBefore: beforeMin.tmr, tmrAfter: afterRes.tmr };
  check('minimised: no frames are streamed', sMin2 - sMin1 <= 1, `${sMin1} -> ${sMin2}`);
  check('restored: frames resume', sRes - sMin2 >= 5, `${sMin2} -> ${sRes}`);
  check('restored without reload (page timer counter kept counting)', afterRes.tmr > beforeMin.tmr, `tmr ${beforeMin.tmr} -> ${afterRes.tmr}`);

  // ---------------------------------------------------------------- 3c. crash -> last frame + badge, recover
  // SwarmManager recovers a crashed worker by itself (MAX_CRASH_RECOVERIES = 2), so the crashed state of the first
  // two crashes lasts only until the reload. The third crash is left failed: that is the state checked here.
  const crashId = liveId;
  const crashTrail = [];
  for (let n = 1; n <= 3; n++) {
    await ipc('testWorkerAction', 'crash', crashId);
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      const t = (await tiles()).find(x => x.id === crashId);
      crashTrail.push({ crash: n, ms: i * 100, presentation: t?.presentation, badge: t?.badge });
      if (n < 3 && t?.presentation === 'visible' && i > 3) break; // auto-recovered and live again
    }
  }
  observations.crash_trail = crashTrail;
  check('the first two crashes were auto-recovered by SwarmManager (tile went crashed, then visible)', [1, 2].every(n => crashTrail.some(c => c.crash === n && c.presentation === 'crashed') && crashTrail.some(c => c.crash === n && c.presentation === 'visible')));
  let ct = (await tiles()).find(t => t.id === crashId);
  check('crashed worker tile keeps its last frame with a "Crashed" badge', ct && ct.hasFrame && /Crashed/.test(ct.badge) && ct.presentation === 'crashed', JSON.stringify(ct));
  shot('os_04_crashed_tile.png');
  if (ct) {
    // The live view is hidden; the canvas underneath shows the last frame (not black) in the real window.
    const r = ps(['-Command', `Add-Type -AssemblyName System.Drawing; $b=New-Object System.Drawing.Bitmap '${path.join(outDir, 'os_04_crashed_tile.png')}'; $n=0; for($y=${Math.round(ct.rect.y * dpr) + 4};$y -lt ${Math.round((ct.rect.y + ct.rect.h) * dpr) - 4};$y+=3){for($x=${Math.round(ct.rect.x * dpr) + 4};$x -lt ${Math.round((ct.rect.x + ct.rect.w) * dpr) - 4};$x+=3){$c=$b.GetPixel($x,$y); if(($c.R+$c.G+$c.B) -gt 60){$n++}}}; $b.Dispose(); $n`]);
    const lit = Number(String(r.stdout).trim());
    observations.crashed_tile_lit_samples = lit;
    check('OS screenshot: the crashed tile region shows the last frame, not an empty box', lit > 200, `${lit} non-dark samples`);
  }
  await ipc('testWorkerAction', 'recover', crashId);
  await sleep(3000);
  ct = (await tiles()).find(t => t.id === crashId);
  const fAfterRecover1 = (await stats())[crashId]?.frames;
  await sleep(1000);
  const fAfterRecover2 = (await stats())[crashId]?.frames;
  check('recovered worker is live again (visible, frames flowing)', ct?.presentation === 'visible' && fAfterRecover2 > fAfterRecover1, `${ct?.presentation} ${fAfterRecover1} -> ${fAfterRecover2}`);

  // ---------------------------------------------------------------- 3d. retire a worker
  const retireId = workerIds[workerIds.length - 1];
  await ipc('testWorkerAction', 'retire', retireId);
  await sleep(1000);
  ts = await tiles();
  check('a retired worker tile disappears; the others keep streaming', !ts.some(t => t.id === retireId) && ts.length === workerCount + 2, `${ts.length} tiles`);

  // ---------------------------------------------------------------- 3e. renderer reload: port re-sent
  await chrome.reload();
  await sleep(3000);
  await chrome.click('#layout-grid-btn');
  await sleep(3000);
  st = await stats();
  ts = await tiles();
  const reloadVisible = ts.filter(t => t.presentation === 'visible');
  check('after a chrome renderer reload the Grid streams again (new frames port)', reloadVisible.length > 0 && reloadVisible.every(t => (st[t.id]?.frames || 0) >= 5), reloadVisible.map(t => `${t.id}:${st[t.id]?.frames}`).join(' | '));

  // ---------------------------------------------------------------- 3f. promote a worker to the Stage
  const promoteId = workerIds[0];
  const tmrBeforePromote = (await ipc('testWorkerAction', 'viewport', promoteId)).page.tmr;
  await chrome.click(`.live-tile[data-id="${promoteId}"] .tile-head`);
  await sleep(1500);
  const vpStage = await ipc('testWorkerAction', 'viewport', promoteId);
  const src = (await ipc('getGridSources')).sources.find(s => s.id === promoteId);
  const layoutActive = await chrome.$eval('#layout-stage-btn', e => e.classList.contains('active'));
  check('clicking a worker tile header shows that worker on the Stage without reload', layoutActive && src?.staged && src?.presentation === 'visible' && vpStage.page.tmr >= tmrBeforePromote && vpStage.zoom === 1, `staged=${src?.staged} ${vpStage.page.innerWidth}x${vpStage.page.innerHeight} zoom ${vpStage.zoom} tmr ${tmrBeforePromote}->${vpStage.page.tmr}`);
  shot('os_05_worker_on_stage.png');

  check('log has no unhandled error', !/Unhandled error|Uncaught Exception|Unhandled Promise Rejection/.test(log), (log.match(/[^\n]*(Unhandled|Uncaught)[^\n]*/) || [''])[0].slice(0, 200));
  await ipc('testWorkerAction', 'shutdown');
} catch (err) {
  check('driver ran to completion', false, err.stack);
} finally {
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ at: new Date().toISOString(), machine: `${os.type()} ${os.release()} ${os.cpus()[0]?.model}`, workers: workerCount, results, observations }, null, 2));
  try { await browser?.close(); } catch {}
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  server.close();
  logStream.end();
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
