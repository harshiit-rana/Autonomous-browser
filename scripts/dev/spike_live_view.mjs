// Design spike for #232 (LIV-01): how to get live frames out of worker WebContentsViews.
// Run:  npx electron scripts/dev/spike_live_view.mjs [--dur 20] [--reps 2] [--only id,id] [--probes true|false] [--out dir]
//       (add --force-device-scale-factor=1.5 etc. to see the effect of Chromium's scale factor)
// Measures, per (placement x capture strategy x N): frames/s delivered per tile, frame-interval p95, capture latency p50/p95
// (capturePage), main-process / GPU / renderer CPU as % of one core (cumulative CPU seconds delta over the window), working set,
// and whether the page's rAF / 100 ms timer counters keep advancing. Plus probes: debugger double attach, Input.dispatchMouseEvent
// landing, Page.bringToFront focus theft, offscreen view promotion, OS-screenshot visibility, minimised window.
// Fixture: an in-script page (VISIBILITY_HTML in spike_common.mjs); fixtures/pages/visibility.html does not exist in the repo.
import { app, BrowserWindow, WebContentsView, screen, nativeImage } from 'electron';
import { once } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import * as C from './spike_common.mjs';
import os from 'node:os';
// Chromium persists per-host zoom in the profile; an isolated throw-away profile keeps runs independent (a stale zoom polluted an early probe run).
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'spike_live_view-')));

const args = C.parseArgs();
const DUR_MS = Number(args.dur ?? 20) * 1000;
const REPS = Number(args.reps ?? 2);
const OUT = path.resolve(C.repoRoot, args.out ?? 'docs/audits/evidence/spikes/live_view');
const ONLY = args.only ? new Set(String(args.only).split(',')) : null;
const RUN_PROBES = args.probes !== 'false';
const RUN_MATRIX = args.matrix !== 'false';

const WEB_PREFS = { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }; // same as view_manager.ts createTab
const STAGE = { x: 0, y: 100, width: 1000, height: 700 };
const TILE_W = 320, TILE_H = 200;
const tileRect = (i, n) => {
  const cols = n <= 1 ? 1 : Math.ceil(Math.sqrt(n));
  return { x: 10 + (i % cols) * (TILE_W + 10), y: 100 + Math.floor(i / cols) * (TILE_H + 10), width: TILE_W, height: TILE_H };
};

let win, srv, baseUrl;
const results = { host: C.hostInfo(), args: process.argv.slice(2), durMs: DUR_MS, cells: [], probes: {} };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function startWindow() {
  win = new BrowserWindow({ width: 1400, height: 900, show: true, backgroundColor: '#0F1117', title: 'spike-live-view' });
  win.setAlwaysOnTop(true, 'floating'); // keep the harness window unoccluded: Windows occlusion tracking would throttle it
  win.loadURL('data:text/html,<body style="margin:0;background:#0F1117;color:#9ab;font:14px monospace">spike_live_view harness window</body>');
  await once(win.webContents, 'did-finish-load');
  results.display = (({ scaleFactor, size, workAreaSize }) => ({ scaleFactor, size, workAreaSize }))(screen.getPrimaryDisplay());
  results.winBoundsDip = win.getBounds();
  results.contentBoundsDip = win.getContentBounds();
}

async function makeView(prefs = {}, url) {
  const view = new WebContentsView({ webPreferences: { ...WEB_PREFS, ...prefs } });
  if (url) {
    const t0 = C.now();
    const loaded = once(view.webContents, 'did-finish-load').then(() => 'ok');
    view.webContents.loadURL(url).catch(() => {});
    view.__load = await C.withTimeout(loaded, 15000, 'load-timeout').then(() => ({ ok: true, ms: C.round(C.now() - t0, 0) })).catch((e) => ({ ok: false, err: e.message }));
  }
  return view;
}

async function readState(view) {
  try { return await C.withTimeout(view.webContents.executeJavaScript(C.STATE_EXPR), 2500, 'js-timeout'); }
  catch (e) { return { err: e.message }; }
}

function addCover() {
  const cover = new WebContentsView({ webPreferences: WEB_PREFS });
  cover.webContents.loadURL('data:text/html,<body style="margin:0;background:%23ff00ff"></body>');
  win.contentView.addChildView(cover);
  cover.setBounds(STAGE);
  return cover;
}

/** Create N views for a placement. Returns {views, extra:[views to clean]}. */
async function setupPlacement(cell, N) {
  const views = [], extra = [];
  const prefs = { ...(cell.webPrefs || {}) };
  for (let i = 0; i < N; i++) {
    const url = `${baseUrl}/visibility.html?id=${i}`;
    let v;
    if (cell.place === 'osr') { v = await makeView({ ...prefs, offscreen: true }, url); }
    else {
      v = new WebContentsView({ webPreferences: { ...WEB_PREFS, ...prefs } });
      switch (cell.place) {
        case 'unattached': break;
        case 'stage': case 'covered': case 'hidden': case 'detached': win.contentView.addChildView(v); v.setBounds(STAGE); break;
        case 'sliver': win.contentView.addChildView(v); v.setBounds({ x: -(STAGE.width - 1), y: STAGE.y, width: STAGE.width, height: STAGE.height }); break; // full-size view, only a 1 DIP column inside the window
        case 'tiny': win.contentView.addChildView(v); v.setBounds({ x: 0, y: 0, width: 1, height: 1 }); break;
        case 'offscreen': win.contentView.addChildView(v); v.setBounds({ x: -6000, y: 100, width: STAGE.width, height: STAGE.height }); break;
        case 'tile': case 'tilezoom': win.contentView.addChildView(v); v.setBounds(tileRect(i, N)); break;
        default: throw new Error('unknown placement ' + cell.place);
      }
      const t0 = C.now();
      const loaded = once(v.webContents, 'did-finish-load');
      v.webContents.loadURL(url).catch(() => {});
      v.__load = await C.withTimeout(loaded, 15000, 'load-timeout').then(() => ({ ok: true, ms: C.round(C.now() - t0, 0) })).catch((e) => ({ ok: false, err: e.message }));
      if (cell.place === 'tilezoom') v.webContents.setZoomFactor(TILE_W / STAGE.width);
      if (cell.place === 'hidden') v.setVisible(false);
      if (cell.place === 'detached') win.contentView.removeChildView(v); // what setActiveTab() does to the previous tab: was attached, now is not
    }
    views.push(v);
  }
  if (cell.place === 'covered') extra.push(addCover());
  return { views, extra };
}

function startCapture(kind, view) {
  const wc = view.webContents;
  const rec = { kind, frames: [], lat: [], bytes: 0, hashes: new Set(), timeouts: 0, errors: 0, empty: 0, lastErr: null, startErr: null };
  let stopped = false, onMsg, onPaint, lastAck = 0;
  const h = {
    rec,
    async start() {
      if (kind === 'capturePage10') {
        (async () => {
          while (!stopped) {
            const t = C.now();
            try {
              const img = await C.withTimeout(wc.capturePage(), 2000, 'hang');
              const lat = C.now() - t;
              if (img.isEmpty()) rec.empty++;
              else { const j = img.resize({ width: 320 }).toJPEG(60); rec.lat.push(lat); rec.frames.push(C.now()); rec.bytes += j.length; if (rec.hashes.size < 5000) rec.hashes.add(C.md5(j)); }
            } catch (e) { if (e.message === 'hang') rec.timeouts++; else rec.errors++; rec.lastErr = e.message; }
            const wait = 100 - (C.now() - t);
            if (wait > 0) await C.sleep(wait);
          }
        })();
      } else if (kind === 'screencast' || kind === 'screencast15' || kind === 'screencastNth10') {
        const dbg = wc.debugger;
        try { if (!dbg.isAttached()) dbg.attach('1.3'); } catch (e) { rec.startErr = 'attach: ' + e.message; return; }
        onMsg = (_e, method, params) => {
          if (method !== 'Page.screencastFrame') return;
          rec.frames.push(C.now()); rec.bytes += params.data.length * 0.75;
          if (rec.hashes.size < 5000) rec.hashes.add(C.md5(params.data));
          const ack = () => dbg.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
          if (kind === 'screencast15') { const wait = Math.max(0, 1000 / 15 - (C.now() - lastAck)); lastAck = C.now() + wait; setTimeout(ack, wait); } else ack();
        };
        dbg.on('message', onMsg);
        try { await dbg.sendCommand('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 320, maxHeight: 200, everyNthFrame: kind === 'screencastNth10' ? 10 : 1 }); }
        catch (e) { rec.startErr = 'startScreencast: ' + e.message; }
      } else if (kind === 'paint') {
        let k = 0;
        wc.setFrameRate?.(60);
        onPaint = (_e, _dirty, image) => { rec.frames.push(C.now()); if (++k % 15 === 0 && rec.hashes.size < 5000) rec.hashes.add(C.md5(image.toBitmap())); };
        wc.on('paint', onPaint);
      }
    },
    async stop() {
      stopped = true;
      try {
        if (onMsg) { await wc.debugger.sendCommand('Page.stopScreencast').catch(() => {}); wc.debugger.removeListener('message', onMsg); try { wc.debugger.detach(); } catch {} }
        if (onPaint) wc.removeListener('paint', onPaint);
      } catch {}
    },
  };
  return h;
}

const sum = (a) => a.reduce((x, y) => x + y, 0);
function metricsSnapshot() {
  const m = app.getAppMetrics();
  const byPid = new Map();
  for (const p of m) byPid.set(p.pid, { type: p.type, cum: p.cpu.cumulativeCPUUsage, pct: p.cpu.percentCPUUsage, wsKB: p.memory.workingSetSize });
  return byPid;
}

async function runCell(cell, N, rep) {
  const id = `${cell.id}__n${N}__r${rep}`;
  const sys0 = await C.systemSnapshot();
  const { views, extra } = await setupPlacement(cell, N);
  await C.sleep(1500);
  const caps = views.map((v) => startCapture(cell.cap, v));
  const tB0 = C.now();
  const before = await Promise.all(views.map(readState));
  await Promise.all(caps.map((c) => c.start()));
  const pids = [...metricsSnapshot().keys()];
  const ps0 = await C.procCpuSeconds(pids);
  const cpu0 = process.cpuUsage(); const t0 = C.now();
  await C.sleep(DUR_MS);
  const t1 = C.now(); const cpu1 = process.cpuUsage(); const m1 = metricsSnapshot();
  const ps1 = await C.procCpuSeconds([...new Set([...pids, ...m1.keys()])]);
  const after = await Promise.all(views.map(readState)); const tB1 = C.now();
  await Promise.all(caps.map((c) => c.stop()));
  const wall = (t1 - t0) / 1000;
  const psWall = (ps1.tMs - ps0.tMs) / 1000;
  const cpuByType = {};
  for (const [pid, v] of ps1.map) {
    if (!ps0.map.has(pid)) continue;
    const type = m1.get(pid)?.type ?? 'exited';
    cpuByType[type] = (cpuByType[type] || 0) + ((v - ps0.map.get(pid)) / psWall) * 100;
  }
  const wsByType = {};
  for (const b of m1.values()) wsByType[b.type] = (wsByType[b.type] || 0) + b.wsKB / 1024;
  for (const c of caps) c.rec.frames = c.rec.frames.filter((t) => t >= t0 && t <= t1);
  const fpsPerTile = caps.map((c) => c.rec.frames.length / wall);
  const intervals = caps.flatMap((c) => c.rec.frames.slice(1).map((t, i) => t - c.rec.frames[i]));
  const lat = caps.flatMap((c) => c.rec.lat);
  const liveWall = (tB1 - tB0) / 1000;
  const live = views.map((_, i) => {
    const b = before[i], a = after[i];
    if (!b || !a || b.err || a.err) return { err: (b && b.err) || (a && a.err) || 'no state' };
    return { rafPerSec: C.round((a.raf - b.raf) / liveWall, 1), tmrPerSec: C.round((a.tmr - b.tmr) / liveWall, 1), visAfter: a.vis, visEvents: a.visEvents, iw: a.iw, ih: a.ih, dpr: a.dpr };
  });
  const row = {
    id, cell: cell.id, place: cell.place, cap: cell.cap, N, rep, wallSec: C.round(wall, 2), cpuWindowSec: C.round(psWall, 2),
    sysBefore: sys0,
    loadOk: views.map((v) => v.__load?.ok), loadMs: views.map((v) => v.__load?.ms ?? v.__load?.err),
    fpsPerTileMean: C.round(C.mean(fpsPerTile)), fpsPerTileMin: C.round(Math.min(...fpsPerTile)), fpsPerTileMax: C.round(Math.max(...fpsPerTile)),
    frameIntervalMsP50: C.round(C.pctl(intervals, 50)), frameIntervalMsP95: C.round(C.pctl(intervals, 95)),
    captureLatencyMsP50: C.round(C.pctl(lat, 50)), captureLatencyMsP95: C.round(C.pctl(lat, 95)),
    captureTimeouts: sum(caps.map((c) => c.rec.timeouts)), captureErrors: sum(caps.map((c) => c.rec.errors)), captureEmpty: sum(caps.map((c) => c.rec.empty)),
    startErr: caps.map((c) => c.rec.startErr).filter(Boolean)[0] ?? null, lastErr: caps.map((c) => c.rec.lastErr).filter(Boolean)[0] ?? null,
    kBPerFrame: caps.some((c) => c.rec.frames.length) ? C.round(sum(caps.map((c) => c.rec.bytes)) / sum(caps.map((c) => c.rec.frames.length)) / 1024, 1) : null,
    distinctFramesMin: Math.min(...caps.map((c) => c.rec.hashes.size)),
    mainProcCpuPct_nodeCpuUsageCrossCheck: C.round(((cpu1.user + cpu1.system - cpu0.user - cpu0.system) / 1e6 / wall) * 100, 1),
    cpuPctOfOneCoreByType: Object.fromEntries(Object.entries(cpuByType).map(([k, v]) => [k, C.round(v, 1)])),
    totalCpuPctOfOneCore: C.round(sum(Object.values(cpuByType)), 1),
    workingSetMBByType: Object.fromEntries(Object.entries(wsByType).map(([k, v]) => [k, C.round(v, 0)])),
    workingSetMBTotal: C.round(sum(Object.values(wsByType)), 0),
    pageLiveness: live,
    pageRafPerSecMean: C.round(C.mean(live.map((l) => l.rafPerSec).filter((x) => x != null)), 1),
    pageTimerPerSecMean: C.round(C.mean(live.map((l) => l.tmrPerSec).filter((x) => x != null)), 1),
    viewportAtLoad: live[0] ? { iw: live[0].iw, ih: live[0].ih } : null,
  };
  for (const c of caps) await c.stop();
  for (const v of [...views, ...extra]) { try { win.contentView.removeChildView(v); } catch {} try { v.webContents.setZoomFactor(1); } catch {} try { v.webContents.close(); } catch {} }
  await C.sleep(800);
  return row;
}

function buildMatrix() {
  const M = [];
  const add = (place, cap, ns, extra = {}) => M.push({ id: `${place}-${cap}${extra.webPrefs ? '-nothrottle' : ''}`, place, cap, ns, ...extra });
  M.push({ id: 'idle', place: 'none', cap: 'none', ns: [0] });
  for (const cap of ['none', 'capturePage10', 'screencast']) add('stage', cap, [1]);
  for (const cap of ['none', 'capturePage10', 'screencast']) add('unattached', cap, [1, 6]);
  for (const cap of ['none', 'capturePage10', 'screencast']) add('detached', cap, [1, 6]);
  add('unattached', 'none', [6], { webPrefs: { backgroundThrottling: false } });
  add('unattached', 'screencast', [6], { webPrefs: { backgroundThrottling: false } });
  for (const place of ['tiny', 'offscreen', 'covered', 'hidden']) for (const cap of ['none', 'capturePage10', 'screencast']) add(place, cap, [6]);
  for (const cap of ['none', 'capturePage10', 'screencast']) add('tile', cap, [1, 5, 6, 10], {});
  add('tile', 'screencast15', [1, 5, 6, 10]); add('tile', 'screencastNth10', [6]);
  for (const cap of ['none', 'capturePage10', 'screencast15']) add('sliver', cap, [6]);
  add('sliver', 'screencast15', [10]);
  add('tilezoom', 'none', [6, 10]); add('tilezoom', 'screencast15', [6]); add('covered', 'screencast15', [6]); add('offscreen', 'screencast15', [6]);
  add('osr', 'paint', [1, 6, 10]);
  return M;
}

// ---------------------------------------------------------------- probes
const psFg = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class FG{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);}'; $h=[FG]::GetForegroundWindow(); $p=0; [void][FG]::GetWindowThreadProcessId($h,[ref]$p); "$($h.ToInt64()) $p"`;

async function probeDebuggerAttach() {
  const v = await makeView({}, `${baseUrl}/visibility.html`);
  win.contentView.addChildView(v); v.setBounds(tileRect(0, 1));
  const dbg = v.webContents.debugger; const r = {};
  try { dbg.attach('1.3'); r.firstAttach = 'ok'; } catch (e) { r.firstAttach = e.message; }
  try { dbg.attach('1.3'); r.secondAttach = 'ok (no throw)'; } catch (e) { r.secondAttach = 'throws: ' + e.message; }
  r.isAttachedAfterDouble = dbg.isAttached();
  // Two consumers sharing the single session: both can sendCommand; one detach kills the other's session.
  let frames = 0; dbg.on('message', (_e, m, p) => { if (m === 'Page.screencastFrame') { frames++; dbg.sendCommand('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {}); } });
  await dbg.sendCommand('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 320, maxHeight: 200 });
  const ev = await dbg.sendCommand('Runtime.evaluate', { expression: '1+1' }); r.sharedSessionRuntimeEvaluate = ev.result?.value;
  await C.sleep(1000); const f1 = frames; dbg.detach(); r.isAttachedAfterOneDetach = dbg.isAttached();
  await C.sleep(500); r.framesBeforeDetach = f1; r.framesAfterDetach = frames - f1;
  win.contentView.removeChildView(v); v.webContents.close();
  return r;
}

async function probeInputLands() {
  const out = {};
  const cases = [
    { id: 'stage-1000x700', place: 'stage' }, { id: 'tile-320x200', place: 'tile' }, { id: 'tiny-1x1', place: 'tiny' },
    { id: 'offscreen-x-6000', place: 'offscreen' }, { id: 'covered-by-opaque-view', place: 'covered' }, { id: 'hidden-setVisible-false', place: 'hidden' },
    { id: 'tilezoom-0.32', place: 'tilezoom' }, { id: 'unattached', place: 'unattached' }];
  for (const c of cases) {
    const { views, extra } = await setupPlacement({ place: c.place }, 1);
    const v = views[0]; await C.sleep(600);
    const dbg = v.webContents.debugger; const r = {};
    try {
      dbg.attach('1.3');
      // the button is at CSS px (100,100,120x40); aim at its centre (160,120)
      const scale = c.place === 'tilezoom' ? 1 : 1;
      const send = (type, extra2 = {}) => dbg.sendCommand('Input.dispatchMouseEvent', { type, x: 160 * scale, y: 120 * scale, button: 'left', clickCount: 1, ...extra2 });
      await send('mouseMoved', { button: 'none', clickCount: 0 }); await send('mousePressed'); await send('mouseReleased');
      await C.sleep(300);
      const s = await readState(v); r.clicksLanded = s.clicks; r.moves = s.moves; r.viewport = `${s.iw}x${s.ih}`; r.dpr = s.dpr;
      const elAt = await dbg.sendCommand('Runtime.evaluate', { expression: 'document.elementFromPoint(160,120)?.id || "(none)"' }); r.elementFromPoint160_120 = elAt.result?.value;
    } catch (e) { r.err = e.message; }
    out[c.id] = r;
    try { dbg.detach(); } catch {}
    for (const x of [...views, ...extra]) { try { win.contentView.removeChildView(x); } catch {} try { x.webContents.setZoomFactor(1); } catch {} try { x.webContents.close(); } catch {} }
    await C.sleep(300);
  }
  return out;
}

async function probeBringToFront() {
  const other = new BrowserWindow({ width: 500, height: 300, x: 1500, y: 100, show: true, title: 'other-app-window' });
  other.loadURL('data:text/html,<body>other</body>');
  await C.sleep(800);
  const v = await makeView({}, `${baseUrl}/visibility.html`);
  win.contentView.addChildView(v); v.setBounds(tileRect(0, 1)); await C.sleep(500);
  other.focus(); await C.sleep(700);
  const fg = async () => (await C.psCommand(psFg)).out;
  const r = { before: { otherFocused: other.isFocused(), mainFocused: win.isFocused(), osForegroundHwndPid: await fg(), mainPid: process.pid } };
  const dbg = v.webContents.debugger; dbg.attach('1.3');
  await dbg.sendCommand('Page.bringToFront'); await C.sleep(800);
  r.afterBringToFront = { otherFocused: other.isFocused(), mainFocused: win.isFocused(), viewWebContentsFocused: v.webContents.isFocused(), osForegroundHwndPid: await fg() };
  other.focus(); await C.sleep(600);
  await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  r.focusEmulation = { documentHasFocusWhileOtherWindowFocused: (await readState(v)).focus, otherStillFocused: other.isFocused() };
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: 160, y: 120, button: 'left', clickCount: 1 });
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 160, y: 120, button: 'left', clickCount: 1 });
  await C.sleep(400);
  r.afterCdpClickWithFocusEmulation = { otherFocused: other.isFocused(), osForegroundHwndPid: await fg() };
  dbg.detach(); win.contentView.removeChildView(v); v.webContents.close(); other.close();
  win.setAlwaysOnTop(true, 'floating');
  return r;
}

const BLUE = [68, 170, 255]; // #4af, the animated block on the fixture

async function probeOsVisibility() {
  const out = {};
  const shotDir = path.join(OUT, 'shots'); fs.mkdirSync(shotDir, { recursive: true });
  const cases = [
    { id: 'tile-6', cell: { place: 'tile' }, N: 6 }, { id: 'tilezoom-6', cell: { place: 'tilezoom' }, N: 6 },
    { id: 'osr-attached-1', cell: { place: 'osr' }, N: 1, attach: true }, { id: 'covered-1', cell: { place: 'covered' }, N: 1 },
    { id: 'hidden-1', cell: { place: 'hidden' }, N: 1 }, { id: 'offscreen-1', cell: { place: 'offscreen' }, N: 1 }, { id: 'tiny-1', cell: { place: 'tiny' }, N: 1 }];
  for (const c of cases) {
    const { views, extra } = await setupPlacement(c.cell, c.N);
    if (c.attach) { views[0].webContents.setFrameRate?.(30); win.contentView.addChildView(views[0]); views[0].setBounds(STAGE); }
    await C.sleep(1500);
    const file = path.join(shotDir, `os_${c.id}.png`);
    const shot = await C.osScreenshot(process.pid, file);
    const r = { shot: shot.ok, attempts: shot.attempts, info: shot.info };
    if (shot.ok) {
      const png = C.loadPng(nativeImage, file); const sf = results.display.scaleFactor;
      r.imageSizePx = `${png.width}x${png.height}`;
      const regions = c.cell.place === 'tile' || c.cell.place === 'tilezoom'
        ? views.map((_, i) => { const t = tileRect(i, c.N); return { x: Math.round(t.x * sf), y: Math.round((t.y) * sf), w: Math.round(t.width * sf), h: Math.round(t.height * sf) }; })
        : [{ x: 0, y: Math.round(100 * sf), w: Math.round(1000 * sf), h: Math.round(700 * sf) }];
      // client-area offset: the OS capture is of the whole window rect; titlebar / frame offset is small vs the tile, count blue pixels in a padded region
      r.bluePixelsPerRegion = regions.map((rg) => C.findColor(png, BLUE, { x: rg.x, y: rg.y - 40, w: rg.w, h: rg.h + 80 }, 30).count);
      r.magentaCoverPixels = C.findColor(png, [255, 0, 255], { x: 0, y: 0, w: png.width, h: png.height }, 20).count;
    }
    out[c.id] = r;
    for (const x of [...views, ...extra]) { try { win.contentView.removeChildView(x); } catch {} try { x.webContents.setZoomFactor(1); } catch {} try { x.webContents.close(); } catch {} }
    await C.sleep(500);
  }
  return out;
}


async function probeOsrWindow() {
  // Does 'paint' fire for webPreferences.offscreen:true at all? Compare a BrowserWindow(show:false) with a WebContentsView.
  const out = {};
  const bw = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { ...WEB_PREFS, offscreen: true } });
  let n = 0; bw.webContents.on('paint', () => { n++; });
  await bw.loadURL(baseUrl + '/visibility.html'); await C.sleep(5000);
  out.browserWindowOffscreen = { paintEventsIn5s: n, frameRate: bw.webContents.getFrameRate?.() };
  bw.destroy();
  const v = await makeView({ offscreen: true }, baseUrl + '/visibility.html');
  let m = 0; v.webContents.on('paint', () => { m++; });
  await C.sleep(3000);
  out.webContentsViewOffscreen_listenerAfterLoad = { paintEventsIn3s: m, isPainting: v.webContents.isPainting?.() };
  v.webContents.startPainting?.(); await C.sleep(3000);
  out.webContentsViewOffscreen_afterStartPainting = { paintEventsTotal: m, isPainting: v.webContents.isPainting?.() };
  v.webContents.close();
  return out;
}

async function probeMinimised() {
  const { views } = await setupPlacement({ place: 'tile' }, 1);
  const v = views[0]; await C.sleep(800);
  const cap = startCapture('screencast', v); await cap.start();
  const sample = async (label, ms) => {
    const f0 = cap.rec.frames.length; const s0 = await readState(v); const t0 = C.now();
    await C.sleep(ms); const s1 = await readState(v); const w = (C.now() - t0) / 1000;
    return { label, screencastFps: C.round((cap.rec.frames.length - f0) / w), rafPerSec: C.round((s1.raf - s0.raf) / w, 1), timerPerSec: C.round((s1.tmr - s0.tmr) / w, 1), vis: s1.vis };
  };
  const r = { normal: await sample('normal', 4000) };
  win.minimize(); await C.sleep(800);
  r.minimized = await sample('minimized', 5000);
  win.restore(); win.setAlwaysOnTop(true, 'floating'); await C.sleep(1000);
  r.restored = await sample('restored', 4000);
  await cap.stop(); win.contentView.removeChildView(v); v.webContents.close();
  return r;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  srv = await C.serve({ '/visibility.html': C.VISIBILITY_HTML });
  baseUrl = `http://127.0.0.1:${srv.port}`;
  await app.whenReady();
  await startWindow();
  log('window ready', JSON.stringify(results.display), 'args', process.argv.slice(2).join(' '));
  const save = () => C.writeJson(path.join(OUT, args.name ?? 'results.json'), results);
  if (RUN_PROBES) {
    for (const [name, fn] of [['debuggerAttach', probeDebuggerAttach], ['inputLands', probeInputLands], ['bringToFront', probeBringToFront], ['osVisibility', probeOsVisibility], ['minimised', probeMinimised], ['osrWindow', probeOsrWindow]]) {
      if (ONLY && !ONLY.has('probe:' + name) && !ONLY.has('probes')) continue;
      log('probe', name);
      try { results.probes[name] = await fn(); } catch (e) { results.probes[name] = { error: e.stack || e.message }; }
      save();
    }
  }
  if (RUN_MATRIX) {
    const matrix = buildMatrix();
    for (let rep = 1; rep <= REPS; rep++) {
      for (const cell of matrix) {
        if (ONLY && !ONLY.has(cell.id)) continue;
        for (const N of cell.ns) {
          log('cell', cell.id, 'N=' + N, 'rep', rep);
          try {
            const row = await runCell(cell, N, rep);
            results.cells.push(row);
            log('  fps/tile', row.fpsPerTileMean, 'mainCPU%', row.cpuPctOfOneCoreByType.Browser, 'GPU%', row.cpuPctOfOneCoreByType.GPU, 'raf/s', row.pageRafPerSecMean, 'to', row.captureTimeouts, 'ws', row.workingSetMBTotal);
          } catch (e) { results.cells.push({ cell: cell.id, N, rep, error: e.stack || e.message }); log('  ERROR', e.message); }
          save();
        }
      }
    }
  }
  save(); srv.close(); log('done'); app.exit(0);
}
main().catch((e) => { console.error(e); app.exit(1); });
