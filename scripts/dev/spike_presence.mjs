// Design spike for #233 (LIV-02): where can the agent's presence layer (cursor, ripple, highlight) be drawn so a USER can see it above a
// native WebContentsView, without page JavaScript being able to see it, and without swallowing the user's real clicks?
// Run:  npx electron scripts/dev/spike_presence.mjs [--options N,A,B,B2,C,D,E] [--zooms 1,1.5] [--anim true] [--out dir] [--name file.json]
//       (add --force-device-scale-factor=1 / =2 to see other DPRs; the machine's own Windows scale is used otherwise)
// Windows only. Uses scripts/dev/os_screenshot.ps1 (real OS screen copy) and scripts/dev/os_click.ps1 (real OS mouse click, pid-guarded).
//
// Options under test (all draw a 20x20 DIP magenta square centred on an orange page button; page is static so pixel noise is ~0):
//   N   no presence layer (control: a real click must reach the page)
//   A   DOM element in the chrome renderer at z-index max, over the page area (what src/renderer/app.ts #presence-overlay does today)
//   B   second WebContentsView, last child of contentView, same bounds as the page view, transparent bg, body pointer-events:none
//   B2  like B but the view is only 48x48 DIP and is moved with setBounds to follow the cursor
//   C   transparent frameless child BrowserWindow (focusable:false, setIgnoreMouseEvents(true,{forward:true})) placed over the page view
//   D   element injected into the page's own DOM (position:fixed, pointer-events:none) = what stealth/cursor_overlay.ts does
//   E   CDP Overlay.highlightRect on the page
import { app, BrowserWindow, WebContentsView, screen, nativeImage } from 'electron';
import { once } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import * as C from './spike_common.mjs';
import os from 'node:os';
// Chromium persists per-host zoom in the profile; an isolated throw-away profile keeps runs independent (a stale zoom polluted an early probe run).
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'spike_presence-')));

const args = C.parseArgs();
const OUT = path.resolve(C.repoRoot, args.out ?? 'docs/audits/evidence/spikes/presence');
const OPTIONS = String(args.options ?? 'N,A,B,B2,C,D,E').split(',');
const ZOOMS = String(args.zooms ?? '1,1.5').split(',').map(Number);
const ANIM = args.anim !== 'false';
const NAME = args.name ?? 'results.json';
const TAG = args.tag ?? 'native';
const WEB_PREFS = { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true };
const ORANGE = [255, 136, 0], MAGENTA = [255, 0, 255];
const MARK = 20; // DIP

const CHROME_HTML = `<!doctype html><meta charset=utf-8><title>chrome</title>
<style>html,body{margin:0;height:100%;background:#0F1117;color:#9ab;font:13px monospace}
#bar{position:absolute;left:0;top:0;right:0;height:88px;background:#161b26}
#drawer{position:absolute;right:0;top:88px;width:320px;bottom:0;background:#121722}
#m{position:fixed;left:-100px;top:-100px;width:${MARK}px;height:${MARK}px;background:#f0f;z-index:2147483647;pointer-events:none}
#ctl{position:absolute;right:40px;top:120px;width:${MARK}px;height:${MARK}px;background:#f0f}</style>
<div id=bar>chrome renderer</div><div id=drawer><div id=ctl></div></div><div id=m></div>
<script>window.m=(x,y)=>{const e=document.getElementById('m');e.style.left=x+'px';e.style.top=y+'px'};</script>`;
// the control square #ctl sits in the chrome DOM where NO native view is (drawer): proves the capture can see chrome pixels at all.

const PAGE_HTML = `<!doctype html><meta charset=utf-8><title>target</title>
<style>html,body{margin:0;background:#101418;height:100%}
#btn{position:absolute;left:300px;top:200px;width:160px;height:56px;background:#ff8800;border:0;font:16px sans-serif}</style>
<button id=btn>target</button>
<script>
window.__clicks=0;window.__blurs=0;window.__focuses=0;window.__mut=0;window.__vis=0;
document.getElementById('btn').addEventListener('click',()=>{window.__clicks++});
window.addEventListener('blur',()=>{window.__blurs++});window.addEventListener('focus',()=>{window.__focuses++});
document.addEventListener('visibilitychange',()=>{window.__vis++});
const __n0=document.querySelectorAll('*').length;
new MutationObserver(l=>{window.__mut+=l.length}).observe(document,{subtree:true,childList:true,attributes:true});
window.__scan=()=>{const re=/aegis|__agent|presence|cursor|ripple/i;const hits=[];
 for(const k of Object.getOwnPropertyNames(window)) if(re.test(k)) hits.push('global:'+k);
 for(const el of document.querySelectorAll('*')){ if(re.test(el.id)||re.test(String(el.className))||[...el.attributes].some(a=>re.test(a.name)||re.test(a.value))) hits.push('node:'+el.tagName+'#'+el.id); }
 return {namedHits:hits,extraNodes:document.querySelectorAll('*').length-__n0,mutationRecords:window.__mut,blurs:window.__blurs,focuses:window.__focuses,visEvents:window.__vis,hasFocus:document.hasFocus()};};
window.__btnCenterCss=()=>{const r=document.getElementById('btn').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,dpr:devicePixelRatio,iw:innerWidth,ih:innerHeight}};
</script>`;

const OVERLAY_HTML = `<!doctype html><meta charset=utf-8><title>overlay</title>
<style>html,body{margin:0;background:transparent;overflow:hidden;pointer-events:none}
#m{position:fixed;left:-100px;top:-100px;width:${MARK}px;height:${MARK}px;background:#f0f;pointer-events:none}</style>
<div id=m></div><script>window.m=(x,y)=>{const e=document.getElementById('m');e.style.left=x+'px';e.style.top=y+'px'};</script>`;

const results = { host: C.hostInfo(), args: process.argv.slice(2), tag: TAG, conditions: [], anim: [], extra: {} };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let win, chromeSrv, pageSrv, overlaySrv, pageView, pv, chromeUrl, pageUrl, overlayUrl, pageWc;

async function shoot(name) {
  const file = path.join(OUT, 'shots', `${TAG}_${name}.png`);
  const r = await C.osScreenshot(process.pid, file);
  if (!r.ok) throw new Error('os screenshot failed: ' + r.info);
  const m = /rect=(-?\d+),(-?\d+),(\d+),(\d+)/.exec(r.info);
  return { png: C.loadPng(nativeImage, file), ox: Number(m[1]), oy: Number(m[2]), file };
}
const whole = (p) => ({ x: 0, y: 0, w: p.width, h: p.height });

function diffOutside(a, b, box, thr = 40) {
  let changed = 0;
  for (let y = 0; y < Math.min(a.height, b.height); y++) for (let x = 0; x < Math.min(a.width, b.width); x++) {
    if (box && x >= box.minX - 12 && x <= box.maxX + 12 && y >= box.minY - 12 && y <= box.maxY + 12) continue;
    const oa = (y * a.width + x) * 4, ob = (y * b.width + x) * 4;
    if (Math.abs(a.bmp[oa] - b.bmp[ob]) + Math.abs(a.bmp[oa + 1] - b.bmp[ob + 1]) + Math.abs(a.bmp[oa + 2] - b.bmp[ob + 2]) > thr) changed++;
  }
  return changed;
}

function newOverlayView() {
  const v = new WebContentsView({ webPreferences: WEB_PREFS });
  v.setBackgroundColor('#00000000');
  v.webContents.loadURL(overlayUrl);
  return v;
}

async function layout() {
  const cb = win.getContentBounds();
  pv = { x: 0, y: 88, width: cb.width - 320, height: cb.height - 88 };
  pageView.setBounds(pv);
}

// ----- option implementations. show(cx, cy): cx/cy = target centre in DIP relative to the page view's top-left (CSS px * zoom).
function makeOption(id) {
  const o = { id, async setup() {}, async show() {}, async hide() {}, async move(x, y) { return this.show(x, y); }, async teardown() {} };
  if (id === 'N') o.desc = 'no presence layer (control)';
  if (id === 'A') {
    o.desc = 'chrome-renderer DOM element, z-index 2147483647';
    o.show = async (x, y) => { await win.webContents.executeJavaScript(`m(${pv.x + x - MARK / 2},${pv.y + y - MARK / 2})`); };
    o.hide = async () => { await win.webContents.executeJavaScript('m(-100,-100)'); };
  }
  if (id === 'B') {
    o.desc = 'overlay WebContentsView, same bounds as the page view, transparent, pointer-events:none';
    let ov;
    o.setup = async () => { ov = newOverlayView(); o.ov = ov; await once(ov.webContents, 'did-finish-load'); };
    o.show = async (x, y) => { win.contentView.addChildView(ov); ov.setBounds(pv); await ov.webContents.executeJavaScript(`m(${x - MARK / 2},${y - MARK / 2})`); };
    o.move = async (x, y) => { ov.webContents.executeJavaScript(`m(${x - MARK / 2},${y - MARK / 2})`); };
    o.hide = async () => { try { win.contentView.removeChildView(ov); } catch {} };
    o.teardown = async () => { try { win.contentView.removeChildView(ov); } catch {} ov.webContents.close(); };
  }
  if (id === 'B2') {
    o.desc = 'cursor-sized (48x48) overlay WebContentsView moved with setBounds';
    let ov;
    o.setup = async () => { ov = newOverlayView(); o.ov = ov; await once(ov.webContents, 'did-finish-load'); await ov.webContents.executeJavaScript(`m(${24 - MARK / 2},${24 - MARK / 2})`); };
    o.show = async (x, y) => { win.contentView.addChildView(ov); ov.setBounds({ x: Math.round(pv.x + x - 24), y: Math.round(pv.y + y - 24), width: 48, height: 48 }); };
    o.hide = async () => { try { win.contentView.removeChildView(ov); } catch {} };
    o.teardown = async () => { try { win.contentView.removeChildView(ov); } catch {} ov.webContents.close(); };
  }
  if (id === 'C') {
    o.desc = 'transparent frameless child BrowserWindow, focusable:false, setIgnoreMouseEvents(true,{forward:true})';
    let ow;
    const place = () => { const cb = win.getContentBounds(); ow.setBounds({ x: cb.x + pv.x, y: cb.y + pv.y, width: pv.width, height: pv.height }); };
    o.place = place;
    o.setup = async () => {
      ow = new BrowserWindow({ parent: win, transparent: true, frame: false, show: false, focusable: false, skipTaskbar: true, hasShadow: false, resizable: false, backgroundColor: '#00000000', webPreferences: WEB_PREFS });
      o.ow = ow; ow.setIgnoreMouseEvents(true, { forward: true });
      ow.loadURL(overlayUrl); await once(ow.webContents, 'did-finish-load');
    };
    o.show = async (x, y) => { place(); if (!ow.isVisible()) ow.showInactive(); await ow.webContents.executeJavaScript(`m(${x - MARK / 2},${y - MARK / 2})`); };
    o.move = async (x, y) => { ow.webContents.executeJavaScript(`m(${x - MARK / 2},${y - MARK / 2})`); };
    o.hide = async () => { ow.hide(); };
    o.teardown = async () => { try { ow.destroy(); } catch {} };
  }
  if (id === 'D') {
    o.desc = 'element injected into the page DOM (position:fixed, pointer-events:none)';
    const z = () => pageWc.getZoomFactor();
    o.show = async (x, y) => {
      await pageWc.executeJavaScript(`(()=>{let e=document.getElementById('__agent_presence__');if(!e){e=document.createElement('div');e.id='__agent_presence__';e.style.cssText='position:fixed;width:${MARK}px;height:${MARK}px;background:#f0f;z-index:2147483647;pointer-events:none';document.body.appendChild(e)}e.style.left=(${x / z()}-${MARK / 2})+'px';e.style.top=(${y / z()}-${MARK / 2})+'px'})()`);
    };
    o.hide = async () => { await pageWc.executeJavaScript(`document.getElementById('__agent_presence__')?.remove()`); };
  }
  if (id === 'E') {
    o.desc = 'CDP Overlay.highlightRect';
    o.setup = async () => { try { pageWc.debugger.attach('1.3'); } catch {} await pageWc.debugger.sendCommand('DOM.enable'); await pageWc.debugger.sendCommand('Overlay.enable'); };
    o.show = async (x, y) => { const zf = pageWc.getZoomFactor(); await pageWc.debugger.sendCommand('Overlay.highlightRect', { x: Math.round(x / zf - MARK / 2), y: Math.round(y / zf - MARK / 2), width: MARK, height: MARK, color: { r: 255, g: 0, b: 255, a: 1 } }); };
    o.hide = async () => { await pageWc.debugger.sendCommand('Overlay.hideHighlight'); };
    o.teardown = async () => { try { await pageWc.debugger.sendCommand('Overlay.disable'); pageWc.debugger.detach(); } catch {} };
  }
  return o;
}

async function pageClicks() { return pageWc.executeJavaScript('window.__clicks'); }

async function measureCondition(optId, zoom, s0, btnPx) {
  const opt = makeOption(optId);
  const row = { option: optId, desc: opt.desc, zoom, dpr: s0.dpr, displayScale: results.display.scaleFactor };
  await opt.setup();
  const c = await pageWc.executeJavaScript('window.__btnCenterCss()');
  const cx = c.x * zoom, cy = c.y * zoom; // DIP in the page view
  await pageWc.executeJavaScript('({b:window.__blurs,f:window.__focuses})').then((v) => { row.pageFocusBefore = v; });
  await opt.show(cx, cy);
  await C.sleep(900);
  const s1 = await shoot(`${optId}_z${zoom}`);
  const mag = C.findColor(s1.png, MAGENTA, whole(s1.png), 45);
  row.magentaPixels = mag.count;
  row.expectedMagentaPixelsIfVisible = Math.round(MARK * MARK * s0.dpr * s0.dpr);
  row.markerCentroidPx = mag.count ? { x: C.round(mag.cx + s1.ox, 1), y: C.round(mag.cy + s1.oy, 1) } : null;
  if (mag.count) {
    // the chrome-DOM control square in the drawer is also magenta: exclude it by restricting to the page-view rectangle (physical px)
    const sf = results.display.scaleFactor;
    const cb = screen.dipToScreenPoint({ x: win.getContentBounds().x, y: win.getContentBounds().y });
    const rect = { x: cb.x + pv.x * sf - s1.ox - 2, y: cb.y + pv.y * sf - s1.oy - 2, w: pv.width * sf + 4, h: pv.height * sf + 4 };
    const inPage = C.findColor(s1.png, MAGENTA, rect, 45);
    row.magentaPixelsInsidePageViewRect = inPage.count;
    if (inPage.count) {
      row.markerCentroidPx = { x: C.round(inPage.cx + s1.ox, 1), y: C.round(inPage.cy + s1.oy, 1) };
      row.centroidErrorPx = { dx: C.round(row.markerCentroidPx.x - btnPx.x, 2), dy: C.round(row.markerCentroidPx.y - btnPx.y, 2) };
      row.centroidErrorDip = { dx: C.round(row.centroidErrorPx.dx / s0.dpr_display, 2), dy: C.round(row.centroidErrorPx.dy / s0.dpr_display, 2) };
    }
    row.changedPixelsOutsideMarker = diffOutside(s0.png, s1.png, inPage.bbox ?? mag.bbox);
  } else row.changedPixelsOutsideMarker = diffOutside(s0.png, s1.png, null);
  // real user click on the button centre (worst case: directly under the marker)
  const before = await pageClicks();
  const cl = await C.ps(['-File', path.join(C.here, 'os_click.ps1'), '-X', String(Math.round(btnPx.x)), '-Y', String(Math.round(btnPx.y)), '-ExpectPid', String(process.pid)]);
  await C.sleep(300);
  row.osClick = { output: cl.out || cl.err, exit: cl.code, pageClickDelta: (await pageClicks()) - before };
  // what page JS / model screenshots can see
  row.pageScan = await pageWc.executeJavaScript('window.__scan()');
  const img = await pageWc.capturePage();
  const bm = img.toBitmap(); const sz = img.getSize();
  row.capturePageMagenta = C.findColor({ width: sz.width, height: sz.height, bmp: bm }, MAGENTA, { x: 0, y: 0, w: sz.width, h: sz.height }, 45).count;
  try {
    if (!pageWc.debugger.isAttached()) pageWc.debugger.attach('1.3');
    const cap = await pageWc.debugger.sendCommand('Page.captureScreenshot', { format: 'png' });
    const im2 = nativeImage.createFromBuffer(Buffer.from(cap.data, 'base64')); const s2 = im2.getSize();
    row.cdpScreenshotMagenta = C.findColor({ width: s2.width, height: s2.height, bmp: im2.toBitmap() }, MAGENTA, { x: 0, y: 0, w: s2.width, h: s2.height }, 45).count;
    if (optId !== 'E') pageWc.debugger.detach();
  } catch (e) { row.cdpScreenshotMagenta = 'err: ' + e.message; }
  row.pageFocusAfter = await pageWc.executeJavaScript('({b:window.__blurs,f:window.__focuses,hasFocus:document.hasFocus()})');
  row.mainWindowFocusedAfter = win.isFocused();

  // z-order: setActiveTab() calls contentView.addChildView(pageView) again; does the overlay survive that?
  if (optId === 'B' || optId === 'B2') {
    win.contentView.addChildView(pageView); pageView.setBounds(pv); await C.sleep(500);
    const s3 = await shoot(`${optId}_z${zoom}_after_readd`);
    row.zOrder = { childrenOrderAfterReaddPage: win.contentView.children.map((v) => (v === pageView ? 'page' : v === opt.ov ? 'overlay' : 'other')) };
    row.zOrder.magentaAfterPageReadded = C.findColor(s3.png, MAGENTA, whole(s3.png), 45).count - (results.extra.controlSquarePx ?? 0);
    win.contentView.addChildView(opt.ov); await C.sleep(400);
    const s4 = await shoot(`${optId}_z${zoom}_after_reassert`);
    row.zOrder.magentaAfterReassert = C.findColor(s4.png, MAGENTA, whole(s4.png), 45).count - (results.extra.controlSquarePx ?? 0);
  }
  await opt.hide(); await C.sleep(300);
  // option C extras: focus, parent move/resize sync, minimise/restore
  if (optId === 'C' && zoom === 1) {
    const ow = opt.ow; const x = {};
    x.overlayIsVisibleAfterHide = ow.isVisible();
    await opt.show(cx, cy);
    x.mainFocusedAfterOverlayShown = win.isFocused();
    const b0 = win.getBounds();
    const target = { x: b0.x + 40, y: b0.y + 20, width: b0.width - 200, height: b0.height - 120 };
    const t = C.now(); win.setBounds(target);
    let lag = null; const want = () => { const cb = win.getContentBounds(); return { x: cb.x + pv.x, y: cb.y + pv.y }; };
    // the product must re-place the overlay on move/resize; here we do it from the events and measure how long until the bounds match
    const handler = () => { const w = want(); const pvNew = { x: 0, y: 88, width: win.getContentBounds().width - 320, height: win.getContentBounds().height - 88 }; pv = pvNew; pageView.setBounds(pv); ow.setBounds({ x: w.x, y: w.y, width: pv.width, height: pv.height }); };
    win.on('resize', handler); win.on('move', handler);
    for (let i = 0; i < 100; i++) { await C.sleep(5); const ob = ow.getBounds(); const w = want(); if (ob.x === w.x && ob.y === w.y && ob.width === pv.width && ob.height === pv.height) { lag = C.now() - t; break; } }
    x.moveResizeSyncLagMs = lag == null ? 'not within 500 ms' : C.round(lag, 1);
    win.removeListener('resize', handler); win.removeListener('move', handler);
    win.minimize(); await C.sleep(900); x.overlayVisibleWhileParentMinimised = ow.isVisible();
    win.restore(); win.setAlwaysOnTop(true, 'floating'); await C.sleep(900); x.overlayVisibleAfterRestore = ow.isVisible();
    win.setBounds(b0); await C.sleep(500); handler(); await opt.hide();
    results.extra.optionC = x;
  }
  await opt.teardown();
  return row;
}

// ----- animation cost: move the cursor along a path at 60 Hz for 10 s
async function measureAnimation(optId) {
  const opt = makeOption(optId);
  await opt.setup(); await opt.show(300, 200); await C.sleep(800);
  const pids = () => app.getAppMetrics().map((m) => m.pid);
  const typeOf = new Map(app.getAppMetrics().map((m) => [m.pid, m.type]));
  const runFor = async (ms, animate) => {
    const ps0 = await C.procCpuSeconds(pids());
    const cpu0 = process.cpuUsage(); const t0 = C.now(); let ticks = 0; const rt = [];
    if (animate) {
      let next = t0;
      while (C.now() - t0 < ms) {
        const t = (C.now() - t0) / 1000; const x = 400 + 250 * Math.cos(t * 2), y = 250 + 120 * Math.sin(t * 3);
        if (ticks % 6 === 0) { const a = C.now(); await opt.show(x, y); rt.push(C.now() - a); } else opt.move(x, y);
        ticks++; next += 1000 / 60; const w = next - C.now(); await C.sleep(Math.max(0, w));
      }
    } else await C.sleep(ms);
    const wall = (C.now() - t0) / 1000; const cpu1 = process.cpuUsage();
    const ps1 = await C.procCpuSeconds(pids()); const psWall = (ps1.tMs - ps0.tMs) / 1000;
    const by = {};
    for (const [pid, v] of ps1.map) if (ps0.map.has(pid)) { const ty = typeOf.get(pid) ?? 'other'; by[ty] = (by[ty] || 0) + ((v - ps0.map.get(pid)) / psWall) * 100; }
    return { wallSec: C.round(wall, 2), updatesPerSec: C.round(ticks / wall, 1), roundtripMsP50: C.round(C.pctl(rt, 50)), roundtripMsP95: C.round(C.pctl(rt, 95)), cpuPctOfOneCoreByType: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, C.round(v, 1)])), mainNodeCpuPct: C.round(((cpu1.user + cpu1.system - cpu0.user - cpu0.system) / 1e6 / wall) * 100, 1) };
  };
  const idle = await runFor(6000, false); const moving = await runFor(10000, true);
  await opt.teardown();
  return { option: optId, desc: opt.desc, staticMarker: idle, moving60Hz: moving };
}

async function main() {
  fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
  chromeSrv = await C.serve({ '/chrome.html': CHROME_HTML });
  pageSrv = await C.serve({ '/target.html': PAGE_HTML });
  overlaySrv = await C.serve({ '/overlay.html': OVERLAY_HTML });
  chromeUrl = `http://127.0.0.1:${chromeSrv.port}/chrome.html`;
  pageUrl = `http://localhost:${pageSrv.port}/target.html`; // different host name: Chromium keys zoom by host, keep chrome UI at zoom 1
  overlayUrl = `http://127.0.0.1:${overlaySrv.port}/overlay.html`;
  await app.whenReady();
  win = new BrowserWindow({ width: 1400, height: 900, minWidth: 800, minHeight: 600, show: true, backgroundColor: '#0F1117', titleBarStyle: 'hidden', titleBarOverlay: { color: '#090d16', symbolColor: '#94a3b8', height: 38 }, title: 'spike-presence', webPreferences: WEB_PREFS });
  win.setAlwaysOnTop(true, 'floating');
  win.loadURL(chromeUrl); await once(win.webContents, 'did-finish-load');
  pageView = new WebContentsView({ webPreferences: WEB_PREFS });
  win.contentView.addChildView(pageView); await layout();
  pageWc = pageView.webContents; pageWc.loadURL(pageUrl); await once(pageWc, 'did-finish-load');
  await C.sleep(800);
  const d = screen.getPrimaryDisplay();
  results.display = { scaleFactor: d.scaleFactor, size: d.size, workArea: d.workAreaSize };
  results.window = { bounds: win.getBounds(), content: win.getContentBounds(), pageView: pv };
  log('ready', JSON.stringify(results.display), 'pageView', JSON.stringify(pv), 'dpr(page)=', await pageWc.executeJavaScript('devicePixelRatio'));
  const save = () => C.writeJson(path.join(OUT, NAME), results);
  const sf = d.scaleFactor;
  for (const zoom of ZOOMS) {
    pageWc.setZoomFactor(zoom); await C.sleep(600);
    const dprPage = await pageWc.executeJavaScript('devicePixelRatio');
    // baseline (no presence) screenshot twice: orange button centroid, noise between identical captures, and the chrome-DOM control square
    const s0 = await shoot(`baseline_z${zoom}`); s0.dpr = dprPage / zoom; s0.dpr_display = sf;
    const s0b = await shoot(`baseline2_z${zoom}`);
    const orange = C.findColor(s0.png, ORANGE, whole(s0.png), 25);
    if (!orange.count) { results.conditions.push({ zoom, error: 'orange button not found in OS screenshot' }); continue; }
    const btnPx = { x: orange.cx + s0.ox, y: orange.cy + s0.oy };
    results.extra['baseline_z' + zoom] = { orangePixels: orange.count, buttonCentroidScreenPx: btnPx, noiseChangedPixelsBetweenIdenticalCaptures: diffOutside(s0.png, s0b.png, null), imageOrigin: { ox: s0.ox, oy: s0.oy }, pageDprReported: dprPage };
    const ctl = C.findColor(s0.png, MAGENTA, whole(s0.png), 45);
    results.extra.controlSquarePx = ctl.count; // chrome DOM square in the drawer (no native view there): proves chrome pixels are capturable
    results.extra.controlSquareExpectedPx = Math.round(MARK * MARK * sf * sf);
    for (const id of OPTIONS) {
      if ((zoom !== 1) && !['B', 'C', 'D', 'E', 'B2'].includes(id)) continue;
      log('option', id, 'zoom', zoom);
      try { results.conditions.push(await measureCondition(id, zoom, s0, btnPx)); }
      catch (e) { results.conditions.push({ option: id, zoom, error: e.stack || e.message }); log('  ERROR', e.message); }
      save();
    }
    pageWc.setZoomFactor(1);
  }
  if (ANIM) {
    for (const id of OPTIONS.filter((o) => ['B', 'B2', 'C', 'D'].includes(o))) {
      log('animation', id);
      try { results.anim.push(await measureAnimation(id)); } catch (e) { results.anim.push({ option: id, error: e.stack || e.message }); }
      save();
    }
  }
  save(); log('done'); app.exit(0);
}
main().catch((e) => { console.error(e); app.exit(1); });
