#!/usr/bin/env node
/**
 * Real-app e2e for Issue #229 (SWX-03): worker isolation, guards, settle and teardown, in the running Electron app.
 *
 *   npm run build && npm run rebuild && node scripts/e2e_worker_isolation.mjs [--out <dir>]
 *
 * Launches the built app (dist/) with Playwright `_electron` on a throw-away profile, with --expose-gc so heap
 * numbers are meaningful. The SwarmManager / WorkerHost used below are the app's own modules, loaded inside
 * the main process (same module instances the runtime uses); pages come from a local fixture server started here.
 *
 *  1. 3 workers: 3 distinct partitions, 3 distinct session objects; storage paths reported as Electron gives them
 *     (in-memory partitions have none: nothing is written to disk).
 *  2. Cookie / localStorage set by worker 1 on the fixture origin is invisible to workers 2 and 3
 *     (the fixture page prints document.cookie; the server also logs the Cookie header it received).
 *  3. Settle: a page that fetches 300 ms after load and renders at ~1000 ms is fully rendered when navigate() returns
 *     (the old fixed 600 ms sleep returned before that); a page that mutates forever returns at the deadline, unsettled.
 *  4. Guards: file:/chrome:/javascript: refused, geolocation/notification permission denied in the page,
 *     window.open returns null and opens nothing, a download is cancelled.
 *  5. Crash: forcefullyCrashRenderer() on a worker is detected and the worker is recovered and usable again.
 *  6. Teardown: after shutdown, webContents count and window child views return to the baseline.
 *  7. Closing the parent window while workers run tears them all down.
 *  8. Leak test: 20 workers spawned and torn down; webContents count back to baseline, main-process heap growth < 20 MB.
 *  9. A real `/swarm` mission through the app's IPC: worker events carry identity (name/colour/glyph), and no worker
 *     WebContents survives the mission.
 * Exit code 0 only if every assertion holds. Requires a desktop session (xvfb on Linux).
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { _electron: electron } = require('playwright-core');
const electronExe = require(path.join(root, 'node_modules', 'electron'));

const outIdx = process.argv.indexOf('--out');
const outDir = path.resolve(outIdx > 0 ? process.argv[outIdx + 1] : path.join(root, 'tests', 'output', 'e2e_worker_isolation'));
fs.mkdirSync(outDir, { recursive: true });
const report = { startedAt: new Date().toISOString(), electron: null, phases: {} };
const rootFwd = root.replace(/\\/g, '/');

// ------------------------------------------------------------------------------------------ fixture server
const serverLog = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const cookie = req.headers.cookie || '';
  serverLog.push({ path: u.pathname, who: u.searchParams.get('w'), cookie });
  const html = body => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset=utf-8><title>fixture ${u.pathname}</title><body style="font:20px sans-serif;padding:24px">${body}`); };
  switch (u.pathname) {
    case '/set': // set a cookie (not HttpOnly) and a localStorage entry
      res.setHeader('Set-Cookie', `owner=${u.searchParams.get('v')}; Path=/`);
      return html(`<h2>cookie set by ${u.searchParams.get('v')}</h2><script>localStorage.setItem('owner','${u.searchParams.get('v')}')</script>`);
    case '/read':
      return html(`<h2>worker: ${u.searchParams.get('w') || '?'}</h2><p>document.cookie = <code id="out"></code></p><p>localStorage.owner = <code id="ls"></code></p><script>document.getElementById('out').textContent=JSON.stringify(document.cookie);document.getElementById('ls').textContent=JSON.stringify(localStorage.getItem('owner'))</script>`);
    case '/slow':
      return html(`<div id="app">loading...</div><script>setTimeout(async()=>{const r=await fetch('/data');document.getElementById('app').innerHTML='<p id="late">'+await r.text()+'</p>'},300)</script>`);
    case '/data':
      return setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('rendered after a 700 ms request'); }, 700);
    case '/busy':
      return html(`<div id="n">0</div><script>let i=0;setInterval(()=>{document.getElementById('n').textContent=++i},30)</script>`);
    case '/file.bin':
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="file.bin"' });
      return res.end(crypto.randomBytes(64));
    default:
      return html('<p>fixture</p>');
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------------------------------------------ app launch
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-e2e-swx-'));
const env = { ...process.env, AEGIS_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: electronExe,
  args: ['--js-flags=--expose-gc', path.join(root, 'dist', 'main', 'index.js')],
  env,
  timeout: 60000
});
const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await page.waitForFunction(() => Boolean(window.aegis && window.aegis.listMissions), null, { timeout: 30000 });
report.electron = await app.evaluate(({ app: a }) => ({ electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome, platform: process.platform }));

const main = (fn, arg) => app.evaluate(fn, { root: rootFwd, base, ...(arg || {}) });
const save = (name, b64) => fs.writeFileSync(path.join(outDir, name), Buffer.from(b64, 'base64'));
let exitCode = 0;

try {
  // -------------------------------------------------------------------------- phase 0: load the app's own modules
  const baseline = await main(async ({ BrowserWindow, webContents }, { root }) => {
    const { createRequire } = process.getBuiltinModule('node:module');
    const rq = createRequire(root + '/package.json');
    const G = (globalThis.__swx = { events: [] });
    G.SwarmManager = rq(root + '/dist/swarm/swarm_manager.js').SwarmManager;
    G.win = BrowserWindow.getAllWindows()[0];
    G.record = w => w.on('event', e => G.events.push({ type: e.type, workerId: e.workerId, name: e.identity.name, glyph: e.identity.glyph, detail: e.detail || null }));
    G.counts = () => ({ webContents: webContents.getAllWebContents().length, childViews: G.win.contentView.children.length });
    G.gc = async () => { for (let i = 0; i < 3; i++) { global.gc(); await new Promise(r => setTimeout(r, 120)); } };
    return G.counts();
  });
  // the initial user tab may still be loading; take the baseline once it is stable
  await new Promise(r => setTimeout(r, 1500));
  const stableBaseline = await main(() => globalThis.__swx.counts());
  assert.deepEqual(stableBaseline, baseline, 'baseline is stable before the swarm starts');
  report.baseline = baseline;
  console.log('baseline', JSON.stringify(baseline), 'electron', report.electron.electron);

  // -------------------------------------------------------------------------- phase 1: three isolated workers
  const iso = await main(async ({ session }) => {
    const G = globalThis.__swx;
    G.iso = new G.SwarmManager({ missionId: 'e2e-iso', parentWindow: G.win, attachToWindow: true, maxWorkers: 8 });
    G.isoWorkers = await G.iso.spawnSwarm(3, 'iso');
    G.isoWorkers.forEach(G.record);
    const sessions = G.isoWorkers.map(w => w.view.webContents.session);
    const pairwiseDistinct = sessions.every((s, i) => sessions.every((t, j) => i === j || s !== t));
    return {
      workers: G.isoWorkers.map(w => ({
        id: w.id, partition: w.partitionName, identity: w.identity,
        storagePath: w.view.webContents.session.getStoragePath(),
        isInMemory: !w.partitionName.startsWith('persist:'),
        sameAsFromPartition: session.fromPartition(w.partitionName) === w.view.webContents.session,
        isDefaultSession: w.view.webContents.session === session.defaultSession
      })),
      pairwiseDistinctSessions: pairwiseDistinct,
      counts: G.counts()
    };
  });
  assert.equal(iso.workers.length, 3);
  assert.equal(new Set(iso.workers.map(w => w.partition)).size, 3, '3 distinct partition names');
  assert.ok(iso.workers.every(w => w.partition.startsWith('agent-e2e-iso-') && w.isInMemory), 'in-memory agent-<mission>-<worker> partitions');
  assert.ok(iso.pairwiseDistinctSessions, '3 distinct Electron session objects');
  assert.ok(iso.workers.every(w => w.sameAsFromPartition && !w.isDefaultSession), 'each view really runs in session.fromPartition(its partition), never the default session');
  assert.equal(new Set(iso.workers.map(w => w.identity.name)).size, 3, 'distinct identities');
  assert.equal(iso.counts.webContents, baseline.webContents + 3, 'exactly 3 new WebContents');
  assert.equal(iso.counts.childViews, baseline.childViews + 3, 'attached to the window');
  assert.ok(iso.workers.every(w => w.storagePath === null), 'in-memory partitions have no on-disk storage path (nothing is persisted)');
  report.phases.isolation = iso;
  console.log('phase 1 isolation ok:', iso.workers.map(w => `${w.partition} storagePath=${w.storagePath}`).join(' | '));

  // -------------------------------------------------------------------------- phase 2: cookie / localStorage isolation
  const cookies = await main(async (_e, { base }) => {
    const G = globalThis.__swx;
    const [w1, w2, w3] = G.isoWorkers;
    const read = async w => {
      const wc = w.view.webContents;
      return {
        documentCookie: await wc.executeJavaScript('document.cookie'),
        localStorageOwner: await wc.executeJavaScript("localStorage.getItem('owner')"),
        printed: await wc.executeJavaScript("document.getElementById('out').textContent"),
        sessionCookies: (await wc.session.cookies.get({})).map(c => `${c.name}=${c.value}`),
        shot: (await wc.capturePage()).toPNG().toString('base64')
      };
    };
    await w1.navigate(`${base}/set?v=worker1`);
    await w1.navigate(`${base}/read?w=worker1`);
    const r1 = await read(w1);
    await w2.navigate(`${base}/read?w=worker2`);
    const r2 = await read(w2);
    await w3.navigate(`${base}/read?w=worker3`);
    const r3 = await read(w3);
    return { r1, r2, r3, ids: G.isoWorkers.map(w => w.id) };
  });
  save('cookie-worker1.png', cookies.r1.shot); save('cookie-worker2.png', cookies.r2.shot); save('cookie-worker3.png', cookies.r3.shot);
  assert.equal(cookies.r1.documentCookie, 'owner=worker1', 'positive control: worker 1 sees its own cookie');
  assert.equal(cookies.r1.localStorageOwner, 'worker1');
  assert.equal(cookies.r2.documentCookie, '', 'worker 2 cannot see worker 1 cookie (page document.cookie)');
  assert.equal(cookies.r3.documentCookie, '');
  assert.equal(cookies.r2.printed, '""', 'the fixture page itself printed an empty cookie string');
  assert.equal(cookies.r2.localStorageOwner, null);
  assert.equal(cookies.r3.localStorageOwner, null);
  assert.deepEqual(cookies.r1.sessionCookies, ['owner=worker1']);
  assert.deepEqual(cookies.r2.sessionCookies, [], "worker 2's session cookie jar is empty");
  assert.deepEqual(cookies.r3.sessionCookies, []);
  const reads = serverLog.filter(l => l.path === '/read');
  assert.equal(reads.find(l => l.who === 'worker1').cookie, 'owner=worker1', 'server saw the cookie from worker 1');
  assert.equal(reads.find(l => l.who === 'worker2').cookie, '', 'server saw NO cookie from worker 2');
  assert.equal(reads.find(l => l.who === 'worker3').cookie, '', 'server saw NO cookie from worker 3');
  report.phases.cookies = { worker1: { ...cookies.r1, shot: undefined }, worker2: { ...cookies.r2, shot: undefined }, worker3: { ...cookies.r3, shot: undefined }, serverSawCookieHeader: reads.map(r => ({ worker: r.who, cookie: r.cookie })) };
  console.log('phase 2 cookie isolation ok');

  // -------------------------------------------------------------------------- phase 3: settle
  const settle = await main(async (_e, { base }) => {
    const G = globalThis.__swx;
    const [, w2, w3] = G.isoWorkers;
    const t0 = Date.now();
    await w2.navigate(`${base}/slow`);
    const slowMs = Date.now() - t0;
    const late = await w2.view.webContents.executeJavaScript("document.getElementById('late') ? document.getElementById('late').textContent : null");
    const slowSettle = w2.lastSettle;
    const t1 = Date.now();
    await w3.navigate(`${base}/busy`);
    const busyMs = Date.now() - t1;
    return { slowMs, late, slowSettle, busyMs, busySettle: w3.lastSettle };
  });
  assert.equal(settle.late, 'rendered after a 700 ms request', 'content that arrives ~1000 ms after load is rendered when navigate() returns');
  assert.ok(settle.slowMs > 1000, `waited for the late request (took ${settle.slowMs} ms; the old fixed wait was 600 ms)`);
  assert.equal(settle.slowSettle.settled, true);
  assert.equal(settle.busySettle.settled, false, 'a page that never stops mutating is reported unsettled');
  assert.equal(settle.busySettle.reason, 'deadline');
  assert.ok(settle.busyMs >= 9500 && settle.busyMs < 16000, `returned at the 10 s deadline, not never (${settle.busyMs} ms)`);
  report.phases.settle = settle;
  console.log('phase 3 settle ok', JSON.stringify({ slowMs: settle.slowMs, busyMs: settle.busyMs }));

  // -------------------------------------------------------------------------- phase 4: guards
  const guards = await main(async (_e, { base }) => {
    const G = globalThis.__swx;
    const [w1] = G.isoWorkers;
    const wc = w1.view.webContents;
    await w1.navigate(`${base}/read?w=guards`);
    const urlBefore = wc.getURL();
    const refused = {};
    for (const u of ['file:///C:/Windows/win.ini', 'chrome://gpu', 'javascript:alert(1)', 'devtools://devtools/bundled/inspector.html']) {
      refused[u] = await w1.navigate(u).then(() => 'LOADED', e => e.message);
    }
    const permissions = await wc.executeJavaScript(`(async () => ({
      geolocation: await new Promise(res => navigator.geolocation.getCurrentPosition(() => res('granted'), e => res('error code ' + e.code))),
      notifications: await Notification.requestPermission(),
    }))()`, true);
    const countBeforePopup = G.counts().webContents;
    const popupResult = await wc.executeJavaScript(`window.open('${base}/read?w=popup') === null`, true);
    await new Promise(r => setTimeout(r, 800));
    const countAfterPopup = G.counts().webContents;
    const download = await w1.navigate(`${base}/file.bin`).then(() => 'LOADED', e => e.message);
    await new Promise(r => setTimeout(r, 300));
    return { urlBefore, urlAfter: wc.getURL(), refused, permissions, popupBlocked: popupResult, countBeforePopup, countAfterPopup, download, events: G.events.filter(e => e.workerId === w1.id) };
  });
  for (const [u, msg] of Object.entries(guards.refused)) assert.match(msg, /Navigation blocked/, `${u} must be refused: ${msg}`);
  assert.equal(guards.urlAfter, guards.urlBefore, 'the page never navigated away');
  assert.equal(guards.permissions.geolocation, 'error code 1', 'geolocation request denied (PERMISSION_DENIED)');
  assert.equal(guards.permissions.notifications, 'denied');
  assert.equal(guards.popupBlocked, true, 'window.open returned null');
  assert.equal(guards.countAfterPopup, guards.countBeforePopup, 'no popup WebContents was created');
  assert.ok(guards.events.some(e => e.type === 'popup-denied'));
  assert.ok(guards.events.some(e => e.type === 'permission-denied' && e.detail.permission === 'geolocation'));
  assert.ok(guards.events.some(e => e.type === 'download-cancelled' && e.detail.fileName === 'file.bin'), 'download cancelled: ' + guards.download);
  assert.ok(guards.events.filter(e => e.type === 'navigation-blocked').length >= 4);
  report.phases.guards = guards;
  console.log('phase 4 guards ok');

  // -------------------------------------------------------------------------- phase 5: crash and recovery
  const crash = await main(async (_e, { base }) => {
    const G = globalThis.__swx;
    const w = G.isoWorkers[2];
    await w.navigate(`${base}/read?w=after-crash-setup`);
    const urlBefore = w.view.webContents.getURL();
    w.view.webContents.forcefullyCrashRenderer();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !G.events.some(e => e.workerId === w.id && e.type === 'recovered')) await new Promise(r => setTimeout(r, 100));
    const recovered = G.events.some(e => e.workerId === w.id && e.type === 'recovered');
    const snap = await w.getSnapshot();
    let usable = null;
    if (recovered) { await w.navigate(`${base}/read?w=after-crash`); usable = await w.view.webContents.executeJavaScript("document.querySelector('h2').textContent"); }
    return { urlBefore, recovered, status: snap.status, crashes: w.crashes, urlAfter: snap.url, usable, events: G.events.filter(e => e.workerId === w.id && (e.type === 'render-process-gone' || e.type === 'recovered')) };
  });
  assert.ok(crash.events.some(e => e.type === 'render-process-gone'), 'crash detected');
  assert.ok(crash.recovered, 'worker recovered');
  assert.equal(crash.crashes, 1);
  assert.equal(crash.usable, 'worker: after-crash', 'recovered worker is usable');
  report.phases.crash = crash;
  console.log('phase 5 crash recovery ok');

  // -------------------------------------------------------------------------- phase 6: teardown returns to baseline
  const down = await main(async () => {
    const G = globalThis.__swx;
    const workers = G.isoWorkers.slice();
    const sessions = workers.map(w => w.partitionName);
    await G.iso.shutdown();
    const confirmed = workers.map(w => w.destroyedConfirmed);
    const destroyed = workers.map(w => w.isDestroyed);
    await new Promise(r => setTimeout(r, 300));
    return { confirmed, destroyed, partitions: sessions, counts: G.counts() };
  });
  assert.ok(down.confirmed.every(Boolean) && down.destroyed.every(Boolean), 'every worker WebContents confirmed destroyed');
  assert.deepEqual(down.counts, baseline, 'webContents and child views are back to the baseline');
  report.phases.teardown = down;
  console.log('phase 6 teardown ok', JSON.stringify(down.counts));

  // -------------------------------------------------------------------------- phase 7: window closed while workers run
  const closed = await main(async ({ BrowserWindow, webContents }, { base }) => {
    const G = globalThis.__swx;
    const before = webContents.getAllWebContents().length;
    const extra = new BrowserWindow({ show: false, width: 800, height: 600 });
    const mgr = new G.SwarmManager({ missionId: 'e2e-winclose', parentWindow: extra, attachToWindow: true });
    const ws = await mgr.spawnSwarm(2, 'wc');
    await Promise.all(ws.map((w, i) => w.navigate(`${base}/read?w=winclose${i}`)));
    const during = webContents.getAllWebContents().length;
    extra.close();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !ws.every(w => w.isDestroyed)) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 300));
    return { before, during, after: webContents.getAllWebContents().length, allDestroyed: ws.every(w => w.isDestroyed), active: mgr.getActiveCount() };
  });
  assert.equal(closed.during, closed.before + 3, 'window + 2 workers while running');
  assert.ok(closed.allDestroyed, 'closing the window tore the workers down');
  assert.equal(closed.after, closed.before, 'no WebContents left behind');
  assert.equal(closed.active, 0);
  report.phases.windowClosed = closed;
  console.log('phase 7 window-closed ok');

  // -------------------------------------------------------------------------- phase 8: leak test, 20 workers
  const leak = await main(async ({ app: a }, { base }) => {
    const G = globalThis.__swx;
    const rendererRss = () => a.getAppMetrics().filter(m => m.type === 'Tab' || m.type === 'Renderer').reduce((s, m) => s + (m.memory.workingSetSize || 0), 0); // KB
    const cycle = async (n, prefix) => {
      const mgr = new G.SwarmManager({ missionId: `${prefix}`, parentWindow: G.win, attachToWindow: true, maxWorkers: 8 });
      const ws = await mgr.spawnSwarm(n, 'leak');
      await Promise.all(ws.map((w, i) => w.navigate(`${base}/read?w=${prefix}-${i}`)));
      await mgr.shutdown();
      return ws.every(w => w.destroyedConfirmed);
    };
    await cycle(2, 'e2e-leak-warmup'); // load lazy native/JS state before measuring
    await G.gc();
    const before = { heapUsed: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss, rendererWorkingSetKB: rendererRss(), counts: G.counts() };
    const confirmed = [];
    let total = 0;
    for (let b = 0; b < 5; b++) { confirmed.push(await cycle(4, `e2e-leak-${b}`)); total += 4; }
    await new Promise(r => setTimeout(r, 500));
    await G.gc();
    const after = { heapUsed: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss, rendererWorkingSetKB: rendererRss(), counts: G.counts() };
    return { workersSpawnedAndTornDown: total, allConfirmedDestroyed: confirmed.every(Boolean), before, after, heapGrowthMB: (after.heapUsed - before.heapUsed) / 1048576, rssGrowthMB: (after.rss - before.rss) / 1048576 };
  });
  assert.equal(leak.workersSpawnedAndTornDown, 20);
  assert.ok(leak.allConfirmedDestroyed, 'every one of the 20 WebContents was confirmed destroyed');
  assert.deepEqual(leak.after.counts, leak.before.counts, 'webContents count back to the pre-test value');
  assert.deepEqual(leak.after.counts, baseline);
  assert.ok(leak.heapGrowthMB < 20, `main-process heap growth ${leak.heapGrowthMB.toFixed(2)} MB must be < 20 MB`);
  report.phases.leak = leak;
  console.log('phase 8 leak ok', `heap +${leak.heapGrowthMB.toFixed(2)} MB, rss ${leak.rssGrowthMB.toFixed(1)} MB, renderer working set ${leak.before.rendererWorkingSetKB} -> ${leak.after.rendererWorkingSetKB} KB`);

  // -------------------------------------------------------------------------- phase 9: a real /swarm mission through the app
  await page.evaluate(() => window.aegis.updateSettings({ modelProvider: 'ollama', ollamaBaseUrl: 'http://127.0.0.1:9/v1' }));
  const started = await page.evaluate(() => window.aegis.startMission('/swarm compare prices across shops', 'llama3'));
  assert.ok(started.ok && started.data.started, `mission did not start: ${JSON.stringify(started)}`);
  const missionId = started.data.missionId;
  let mission;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const list = await page.evaluate(() => window.aegis.listMissions(20));
    mission = list.data.find(m => m.id === missionId);
    if (mission && ['completed', 'failed', 'cancelled'].includes(mission.state)) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  assert.ok(mission && ['completed', 'failed', 'cancelled'].includes(mission.state), `mission never finished: ${JSON.stringify(mission)}`);
  await new Promise(r => setTimeout(r, 1500));
  const evs = await page.evaluate(id => window.aegis.getMissionEvents(id, 0, 500), missionId);
  // 'worker-agent-1' is the single-agent runtime's own status pseudo-worker (not a swarm worker with a view)
  const allWorkerEvents = evs.data.events.filter(e => e.kind === 'worker');
  const workerEvents = allWorkerEvents.filter(e => e.data.id !== 'worker-agent-1');
  const after = await main(() => globalThis.__swx.counts());
  assert.ok(workerEvents.length > 0, 'the mission emitted worker events');
  assert.ok(workerEvents.every(e => e.data.name && e.data.color && e.data.glyph && e.data.id), 'every worker event carries name, colour and glyph');
  assert.deepEqual(after, baseline, 'no worker WebContents survives the mission');
  report.phases.mission = {
    missionId, state: mission.state, error: mission.error ?? null,
    workerEvents: workerEvents.length,
    otherEvents: allWorkerEvents.length - workerEvents.length,
    sample: workerEvents.slice(0, 3).map(e => e.data),
    identities: [...new Map(workerEvents.map(e => [e.data.id, { id: e.data.id, name: e.data.name, color: e.data.color, glyph: e.data.glyph }])).values()],
    countsAfter: after
  };
  console.log('phase 9 mission ok', JSON.stringify(report.phases.mission));
  await page.screenshot({ path: path.join(outDir, 'chrome-after-mission.png') });

  report.result = 'PASS';
} catch (err) {
  report.result = 'FAIL';
  report.error = String(err && err.stack || err);
  console.error(err);
  exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  await app.close().catch(() => {});
  server.close();
}
console.log(report.result, '->', path.join(outDir, 'report.json'));
process.exit(exitCode);
