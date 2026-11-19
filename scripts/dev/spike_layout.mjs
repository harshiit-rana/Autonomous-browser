// Design spike for #237 (LIV-?? window/layout architecture with native views): modals above a native page view, measured layout
// (renderer reports #webview-viewport, main positions the view), resize, DPI, focus/keys, hide-vs-0x0, z-order ownership.
// Run:  npx electron scripts/dev/spike_layout.mjs [--parts all|a,b,..] [--out dir] [--name file.json] [--force-device-scale-factor=1.5]
// Windows only. Uses os_screenshot.ps1 (real OS screen copy, -Children for native HWND geometry) and os_click.ps1 (real mouse / key, pid-guarded).
// The "chrome" page is a stand-in for src/renderer/index.html with the same structure that matters here: a 40 px titlebar, a 48 px toolbar,
// a flex #webview-viewport, a 5 px #pane-resizer and a 320 px drawer; the page view uses the webPreferences of view_manager.ts createTab.
// Parts: modal (DOM modal vs hide-page vs overlay UI view), toggle (how to park an idle overlay view), resize (measured layout vs hardcoded),
//        hide (setVisible(false) vs setBounds 0x0 as seen by the page), keys (where Esc / Tab go), zorder (re-adding the page view).
import { app, BrowserWindow, WebContentsView, ipcMain, screen, nativeImage } from 'electron';
import { once } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import * as C from './spike_common.mjs';

const args = C.parseArgs();
const OUT = path.resolve(C.repoRoot, args.out ?? 'docs/audits/evidence/spikes/layout');
const PARTS = new Set(String(args.parts ?? 'all').split(','));
const want = (p) => PARTS.has('all') || PARTS.has(p);
const NAME = args.name ?? 'results.json';
const TAG = args.tag ?? 'native';
const WEB_PREFS = { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true };
const ORANGE = [255, 136, 0], YELLOW = [255, 213, 79], BLUE = [0, 120, 255];
const PRELOAD = path.join(C.here, 'spike_layout_preload.cjs');

const CHROME_HTML = `<!doctype html><meta charset=utf-8><title>chrome</title>
<style>
 html,body{margin:0;height:100%;overflow:hidden;background:#0F1117;color:#9ab;font:13px monospace}
 #root{display:flex;flex-direction:column;height:100vh}
 #titlebar{height:40px;background:#090d16;-webkit-app-region:drag;flex:none}
 #toolbar{height:48px;background:#161b26;flex:none}
 #main{flex:1;display:flex;min-height:0}
 #webview-viewport{flex:1;min-width:0;background:#202633}
 #pane-resizer{width:5px;background:#445;flex:none}
 #swarm-drawer{width:320px;box-sizing:border-box;border-left:1px solid #334;background:#121722;padding:16px;flex:none}
 #settings-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:1000}
 #settings-modal .card{position:absolute;left:50%;top:50%;width:480px;height:300px;margin:-150px 0 0 -240px;background:#ffd54f}
 #settings-modal .ok{position:absolute;left:20px;bottom:20px;width:120px;height:44px;background:#0078ff;border:0}
</style>
<div id=root><div id=titlebar></div><div id=toolbar>toolbar</div>
<div id=main><div id=webview-viewport></div><div id=pane-resizer></div><aside id=swarm-drawer>drawer</aside></div></div>
<div id=settings-modal><div class=card><button class=ok id=dom-ok>OK</button></div></div>
<script>
 window.__keys=[];window.addEventListener('keydown',e=>window.__keys.push(e.key));
 window.openDom=(v)=>{document.getElementById('settings-modal').style.display=v?'block':'none'};
 const vp=document.getElementById('webview-viewport');
 const send=()=>{const r=vp.getBoundingClientRect();window.spike.report({x:r.x,y:r.y,width:r.width,height:r.height,t:performance.timeOrigin+performance.now(),dpr:devicePixelRatio})};
 new ResizeObserver(send).observe(vp);window.addEventListener('resize',send);send();
</script>`;

const PAGE_HTML = `<!doctype html><meta charset=utf-8><title>target</title>
<style>html,body{margin:0;background:#101418;height:100%}
#btn{position:absolute;left:300px;top:200px;width:160px;height:56px;background:#ff8800;border:0}</style>
<button id=btn>target</button>
<script>
 window.__clicks=0;window.__resizes=0;window.__keys=[];window.__raf=0;
 document.getElementById('btn').addEventListener('click',()=>{window.__clicks++});
 window.addEventListener('resize',()=>{window.__resizes++});
 window.addEventListener('keydown',e=>{window.__keys.push(e.key)});
 (function f(){window.__raf++;requestAnimationFrame(f)})();
</script>`;

const UI_HTML = `<!doctype html><meta charset=utf-8><title>overlay ui</title>
<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}
#scrim{display:none;position:fixed;inset:0;background:rgba(0,0,0,.55)}
#dlg{position:absolute;left:50%;top:50%;width:480px;height:300px;margin:-150px 0 0 -240px;background:#ffd54f}
#ok{position:absolute;left:20px;bottom:20px;width:120px;height:44px;background:#0078ff;border:0}</style>
<div id=scrim><div id=dlg role=dialog aria-modal=true><button id=ok>OK</button></div></div>
<script>
 window.__ok=0;window.__keys=[];
 document.getElementById('ok').addEventListener('click',()=>{window.__ok++});
 window.addEventListener('keydown',e=>{window.__keys.push(e.key)});
 window.openDialog=()=>new Promise(res=>{document.getElementById('scrim').style.display='block';document.getElementById('ok').focus();requestAnimationFrame(()=>requestAnimationFrame(()=>res(performance.now())))});
 window.closeDialog=()=>{document.getElementById('scrim').style.display='none'};
</script>`;

const results = { host: C.hostInfo(), args: process.argv.slice(2), tag: TAG, parts: {} };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let win, pageView, pageWc, uiView, lastReport = null, reports = [];
let chromeUrl, pageUrl, uiUrl;

ipcMain.on('layout:report', (_e, r) => { lastReport = { ...r, recvAt: Date.now() }; reports.push(lastReport); if (liveLayout) applyReport(); });
let liveLayout = false;
const R = (n) => Math.round(n);
function boundsFromReport(r) { return { x: R(r.x), y: R(r.y), width: R(r.width), height: R(r.height) }; }
function applyReport() { if (lastReport && pageView) pageView.setBounds(boundsFromReport(lastReport)); }

async function shoot(name) {
  const file = path.join(OUT, 'shots', `${TAG}_${name}.png`);
  const r = await C.osScreenshot(process.pid, file);
  if (!r.ok) throw new Error('os screenshot failed: ' + r.info);
  const m = /rect=(-?\d+),(-?\d+),(\d+),(\d+)/.exec(r.info);
  return { png: C.loadPng(nativeImage, file), ox: Number(m[1]), oy: Number(m[2]), file };
}
const whole = (p) => ({ x: 0, y: 0, w: p.width, h: p.height });
const count = (s, rgb, tol = 30) => C.findColor(s.png, rgb, whole(s.png), tol);
const sf = () => screen.getPrimaryDisplay().scaleFactor;
const click = async (x, y) => (await C.ps(['-File', path.join(C.here, 'os_click.ps1'), '-X', String(Math.round(x)), '-Y', String(Math.round(y)), '-ExpectPid', String(process.pid)])).out;
const keyPress = async (x, y, vk) => (await C.ps(['-File', path.join(C.here, 'os_click.ps1'), '-X', String(Math.round(x)), '-Y', String(Math.round(y)), '-ExpectPid', String(process.pid), '-Key', vk])).out;
const hitTest = async (x, y) => (await C.ps(['-File', path.join(C.here, 'os_click.ps1'), '-X', String(Math.round(x)), '-Y', String(Math.round(y)), '-ExpectPid', String(process.pid), '-HitTestOnly'])).out;
const pageState = () => pageWc.executeJavaScript('({clicks:__clicks,resizes:__resizes,keys:__keys.slice(),raf:__raf,iw:innerWidth,ih:innerHeight})');
const uiState = () => uiView.webContents.executeJavaScript('({ok:__ok,keys:__keys.slice()})');
const settle = async (ms = 700) => { await C.sleep(ms); };
const domRect = () => win.webContents.executeJavaScript(`(()=>{const r=document.getElementById('webview-viewport').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);

function winCenterScreenPx(s) { return { x: s.ox + s.png.width / 2, y: s.oy + s.png.height / 2 }; }

// ---------------------------------------------------------------- part: modal
async function partModal() {
  const out = {};
  const s0 = await shoot('modal_0_closed');
  const orange0 = count(s0, ORANGE, 25);
  out.baseline = { orangePagePixels: orange0.count };
  const btn = { x: orange0.cx + s0.ox, y: orange0.cy + s0.oy }; // page button, screen px

  // (0) DOM modal in the chrome renderer, page view visible and untouched
  await win.webContents.executeJavaScript('openDom(true)'); await settle();
  const s1 = await shoot('modal_1_dom_modal_page_visible');
  out.domModal_pageViewVisible = { yellowCardPixels: count(s1, YELLOW).count };
  // (a) hide the page view (setVisible(false)): modal card is the reference for "fully visible"
  pageView.setVisible(false); await settle();
  const s2 = await shoot('modal_2_dom_modal_page_hidden');
  const ref = count(s2, YELLOW).count;
  out.domModal_pageViewHidden = { yellowCardPixels: ref, orangePagePixels: count(s2, ORANGE, 25).count };
  out.domModal_pageViewVisible.fractionOfCardVisible = C.round(out.domModal_pageViewVisible.yellowCardPixels / ref, 3);
  await win.webContents.executeJavaScript('openDom(false)'); pageView.setVisible(true); await settle(500);

  // (b) overlay UI view: transparent, last child, scrim + dialog; the page stays visible behind the scrim
  const t0 = C.now();
  uiView = new WebContentsView({ webPreferences: WEB_PREFS });
  uiView.setBackgroundColor('#00000000');
  const loaded = once(uiView.webContents, 'did-finish-load');
  uiView.webContents.loadURL(uiUrl); await loaded;
  out.overlayView_coldCreateAndLoadMs = C.round(C.now() - t0, 0);
  const cb = win.getContentBounds();
  const full = { x: 0, y: 0, width: cb.width, height: cb.height };
  // show-latency, preloaded: add + bounds + openDialog() until two rAFs have run in the overlay renderer
  const lat = [];
  for (let i = 0; i < 20; i++) {
    const a = C.now();
    win.contentView.addChildView(uiView); uiView.setBounds(full);
    await uiView.webContents.executeJavaScript('openDialog()');
    lat.push(C.now() - a);
    await uiView.webContents.executeJavaScript('closeDialog()'); win.contentView.removeChildView(uiView);
  }
  out.overlayView_showLatencyMs_toSecondRaf = { p50: C.round(C.pctl(lat, 50)), p95: C.round(C.pctl(lat, 95)), max: C.round(Math.max(...lat)), n: lat.length, note: 'renderer-side (addChildView+setBounds+openDialog until 2 rAF); compositor/OS present time not included' };
  win.contentView.addChildView(uiView); uiView.setBounds(full);
  await uiView.webContents.executeJavaScript('openDialog()'); uiView.webContents.focus(); await settle(900);
  const s3 = await shoot('modal_3_overlay_view_open');
  const yellow3 = count(s3, YELLOW).count;
  const dim = count(s3, [R(255 * 0.45), R(136 * 0.45), 0], 14);
  const blue = count(s3, BLUE, 25);
  out.overlayView_open = { fractionOfCardVisible: C.round(yellow3 / ref, 3), pageButtonVisibleDimmedPixels: dim.count, pageButtonFullColourPixels: count(s3, ORANGE, 25).count };
  // real click on the dialog's OK button; real click on the page button underneath the scrim (must NOT reach the page: modal semantics)
  const p0 = await pageState(); const u0 = await uiState();
  out.overlayView_open.clickOk = { hit: await click(blue.cx + s3.ox, blue.cy + s3.oy) }; await settle(300);
  out.overlayView_open.clickPageButtonBehindScrim = { hit: await click(btn.x, btn.y) }; await settle(300);
  const p1 = await pageState(); const u1 = await uiState();
  out.overlayView_open.dialogOkClicksDelta = u1.ok - u0.ok; out.overlayView_open.pageClicksDelta = p1.clicks - p0.clicks;
  // Esc via real key press: who gets it?
  out.overlayView_open.escKey = { hit: await keyPress(btn.x, btn.y, '0x1B') }; await settle(300);
  const u2 = await uiState(); out.overlayView_open.overlayKeysAfterEsc = u2.keys; out.overlayView_open.uiWebContentsFocused = uiView.webContents.isFocused();
  await uiView.webContents.executeJavaScript('closeDialog()');
  results.extra = { ...(results.extra || {}), btnScreenPx: btn };
  return out;
}

// ---------------------------------------------------------------- part: toggle (idle overlay view parking)
async function partToggle() {
  const out = {};
  const s0 = await shoot('toggle_0'); const o = count(s0, ORANGE, 25); const btn = { x: o.cx + s0.ox, y: o.cy + s0.oy };
  const cb = win.getContentBounds(); const full = { x: 0, y: 0, width: cb.width, height: cb.height };
  const modes = {
    'attached-full-size-transparent-dialog-closed': () => { win.contentView.addChildView(uiView); uiView.setBounds(full); uiView.setVisible(true); },
    'attached-setVisible(false)': () => { win.contentView.addChildView(uiView); uiView.setBounds(full); uiView.setVisible(false); },
    'attached-setBounds(0,0,0,0)': () => { win.contentView.addChildView(uiView); uiView.setVisible(true); uiView.setBounds({ x: 0, y: 0, width: 0, height: 0 }); },
    'removeChildView': () => { try { win.contentView.removeChildView(uiView); } catch {} uiView.setVisible(true); },
  };
  for (const [name, set] of Object.entries(modes)) {
    await uiView.webContents.executeJavaScript('closeDialog()');
    set(); await settle(500);
    const p0 = await pageState();
    const hit = await click(btn.x, btn.y); await settle(250);
    const p1 = await pageState();
    out[name] = { pageClickDelta: p1.clicks - p0.clicks, hit };
  }
  try { win.contentView.removeChildView(uiView); } catch {} uiView.setVisible(true);
  return out;
}

// ---------------------------------------------------------------- part: resize
async function childrenGeometry() {
  const raw = await C.osChildren(process.pid);
  const m = /top=(-?\d+),(-?\d+),(\d+),(\d+) dpi=(\d+)\s+children=(.*)/s.exec(raw);
  if (!m) return { raw: raw.slice(0, 300) };
  const kids = JSON.parse(m[6]);
  return { top: { x: +m[1], y: +m[2], w: +m[3], h: +m[4] }, dpi: +m[5], children: kids.filter((k) => k.visible && k.w > 50 && k.h > 50) };
}

async function partResize() {
  const out = { sizesDip: [], dragSimulation: null };
  liveLayout = true; applyReport();
  const seq = [[1400, 816], [1000, 700], [800, 600], [1400, 816]];
  for (const [w, h] of seq) {
    const t0 = C.now(); const nReports = reports.length;
    win.setSize(w, h);
    let settleMs = null;
    for (let i = 0; i < 200; i++) {
      await C.sleep(5);
      const b = pageView.getBounds(); const r = lastReport;
      if (reports.length > nReports && r && b.x === R(r.x) && b.y === R(r.y) && b.width === R(r.width) && b.height === R(r.height)) { settleMs = C.round(C.now() - t0, 1); break; }
    }
    await C.sleep(300);
    const dom = await domRect(); const b = pageView.getBounds(); const wb = win.getBounds(); const cbd = win.getContentBounds();
    // what view_manager.ts relayout() would compute with its constants
    const hard = { x: 0, y: 88, width: Math.max(200, wb.width - 320), height: Math.max(200, wb.height - 88) };
    const row = {
      requestedDip: `${w}x${h}`, winBoundsDip: `${wb.width}x${wb.height}`, contentBoundsDip: `${cbd.width}x${cbd.height}`, frameDeltaDip: `${wb.width - cbd.width}x${wb.height - cbd.height}`,
      settleMsUntilViewMatchesReport: settleMs, domViewportRect: { x: R(dom.x * 100) / 100, y: R(dom.y * 100) / 100, w: R(dom.width * 100) / 100, h: R(dom.height * 100) / 100 },
      measuredLayoutViewBounds: b, measuredErrorVsDomRectPx: { dx: b.x - dom.x, dy: b.y - dom.y, dw: b.width - dom.width, dh: b.height - dom.height },
      hardcodedLayoutBounds: hard, hardcodedErrorVsDomRectPx: { dx: hard.x - dom.x, dy: hard.y - dom.y, dw: hard.width - dom.width, dh: hard.height - dom.height },
      page: await pageState(),
    };
    if ((w === 1400 && out.sizesDip.length === 0) || w === 800) {
      const g = await childrenGeometry(); const k = sf();
      const cbPx = screen.dipToScreenPoint({ x: cbd.x, y: cbd.y });
      const expect = { x: R(cbPx.x + b.x * k), y: R(cbPx.y + b.y * k), w: R(b.width * k), h: R(b.height * k) };
      const match = (g.children || []).find((c) => Math.abs(c.w - expect.w) <= 3 && Math.abs(c.h - expect.h) <= 3);
      row.nativeHwnd = { expectedScreenPx: expect, matchedChild: match ?? null, allVisibleChildren: g.children, top: g.top, dpi: g.dpi };
    }
    out.sizesDip.push(row);
  }
  // drag simulation: 40 steps from 1400 to 800 wide, 16 ms apart; measure the lag between each setSize and the view following
  const lags = []; let staleSamples = 0;
  for (let i = 0; i <= 40; i++) {
    const w = Math.round(1400 - (600 * i) / 40); const nR = reports.length; const t0 = C.now();
    win.setSize(w, 700);
    for (let j = 0; j < 100; j++) { await C.sleep(2); if (reports.length > nR) break; }
    lags.push(C.now() - t0);
    const dom = await domRect(); const b = pageView.getBounds();
    if (Math.abs(b.width - dom.width) > 1) staleSamples++;
    await C.sleep(Math.max(0, 16 - (C.now() - t0)));
  }
  out.dragSimulation = { steps: lags.length, setSizeToReportMsP50: C.round(C.pctl(lags, 50)), p95: C.round(C.pctl(lags, 95)), max: C.round(Math.max(...lags)), stepsWhereViewWidthDifferedFromDomByMoreThan1px: staleSamples, note: 'sampled right after the report arrived, so a nonzero count means the view lagged one report behind the DOM' };
  win.setSize(1400, 816); await C.sleep(500);
  // maximise / restore via API
  win.maximize(); await C.sleep(800);
  const domM = await domRect(); const bM = pageView.getBounds();
  out.maximised = { winBoundsDip: win.getBounds(), viewBounds: bM, domRect: { w: domM.width, h: domM.height }, errW: bM.width - domM.width, errH: bM.height - domM.height };
  win.unmaximize(); await C.sleep(600);
  liveLayout = false;
  return out;
}

// ---------------------------------------------------------------- part: hide (setVisible(false) vs 0x0 as seen by the page)
async function partHide() {
  const out = {};
  const cb = win.getContentBounds(); applyReport();
  const ref = pageView.getBounds();
  const run = async (name, hideFn, showFn) => {
    const s0 = await pageState(); hideFn(); await C.sleep(1000);
    const sh = await pageState(); const rafA = sh.raf; await C.sleep(1000); const sh2 = await pageState();
    showFn(); await C.sleep(1000); const s1 = await pageState();
    out[name] = { before: { iw: s0.iw, ih: s0.ih, resizes: s0.resizes }, whileHidden: { iw: sh.iw, ih: sh.ih, rafPerSec: sh2.raf - rafA }, afterShow: { iw: s1.iw, ih: s1.ih, resizeEventsSeenByPage: s1.resizes - s0.resizes } };
  };
  await run('setBounds(0,0,0,0)_and_restore', () => pageView.setBounds({ x: 0, y: 0, width: 0, height: 0 }), () => pageView.setBounds(ref));
  await run('setVisible(false)_and_true', () => pageView.setVisible(false), () => pageView.setVisible(true));
  await run('removeChildView_and_addChildView', () => win.contentView.removeChildView(pageView), () => { win.contentView.addChildView(pageView); pageView.setBounds(ref); });
  await run('move_off_screen_x=-6000_and_back', () => pageView.setBounds({ ...ref, x: -6000 }), () => pageView.setBounds(ref));
  return out;
}

// ---------------------------------------------------------------- part: keys (who gets Esc / Tab when the page view has focus)
async function partKeys() {
  const out = {};
  const s0 = await shoot('keys_0'); const c = winCenterScreenPx(s0);
  const kp = await win.webContents.executeJavaScript('window.__keys.length');
  pageWc.focus(); await C.sleep(400);
  out.pageViewFocusedAfterFocus = pageWc.isFocused();
  const p0 = await pageState();
  let beforeInput = [];
  const h = (_e, input) => { if (input.type === 'keyDown') beforeInput.push(input.key); };
  pageWc.on('before-input-event', h);
  out.escWithPageFocused = { hit: await keyPress(c.x, c.y, '0x1B') }; await C.sleep(400);
  const p1 = await pageState(); const kc = await win.webContents.executeJavaScript('window.__keys.slice()');
  out.escWithPageFocused.pageSawKeys = p1.keys.slice(p0.keys.length); out.escWithPageFocused.chromeRendererSawKeysDelta = kc.length - kp; out.escWithPageFocused.mainProcessBeforeInputEventSawKeys = beforeInput;
  // chrome focused
  win.webContents.focus(); await C.sleep(400); beforeInput = [];
  const kc0 = (await win.webContents.executeJavaScript('window.__keys.slice()')).length; const p2 = await pageState();
  out.escWithChromeFocused = { hit: await keyPress(c.x, c.y, '0x1B') }; await C.sleep(400);
  const kc1 = await win.webContents.executeJavaScript('window.__keys.slice()'); const p3 = await pageState();
  out.escWithChromeFocused.chromeRendererSawKeysDelta = kc1.length - kc0; out.escWithChromeFocused.pageSawKeysDelta = p3.keys.length - p2.keys.length;
  pageWc.removeListener('before-input-event', h);
  return out;
}

// ---------------------------------------------------------------- part: zorder
async function partZorder() {
  const out = {};
  const s0 = await shoot('z_0'); const ref = null;
  win.webContents.executeJavaScript('openDom(false)');
  const cb = win.getContentBounds(); const full = { x: 0, y: 0, width: cb.width, height: cb.height };
  win.contentView.addChildView(uiView); uiView.setBounds(full);
  await uiView.webContents.executeJavaScript('openDialog()'); await settle(700);
  const a = await shoot('z_1_overlay_open'); const y1 = count(a, YELLOW).count;
  // setActiveTab() in view_manager.ts does contentView.addChildView(newTab.view): this raises that view above the overlay
  win.contentView.addChildView(pageView); await settle(700);
  const b = await shoot('z_2_after_page_view_readd'); const y2 = count(b, YELLOW).count;
  out.childrenOrderAfterPageReadd = win.contentView.children.map((v) => (v === pageView ? 'page' : v === uiView ? 'overlayUI' : 'other'));
  win.contentView.addChildView(uiView); await settle(700);
  const c = await shoot('z_3_after_reassert'); const y3 = count(c, YELLOW).count;
  out.childrenOrderAfterReassert = win.contentView.children.map((v) => (v === pageView ? 'page' : v === uiView ? 'overlayUI' : 'other'));
  out.dialogCardPixels = { overlayOpen: y1, afterPageViewReadded: y2, afterReassertTop: y3 };
  await uiView.webContents.executeJavaScript('closeDialog()'); win.contentView.removeChildView(uiView);
  return out;
}

async function main() {
  fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
  const cs = await C.serve({ '/chrome.html': CHROME_HTML }); const ps = await C.serve({ '/target.html': PAGE_HTML }); const us = await C.serve({ '/ui.html': UI_HTML });
  chromeUrl = `http://127.0.0.1:${cs.port}/chrome.html`; pageUrl = `http://localhost:${ps.port}/target.html`; uiUrl = `http://127.0.0.1:${us.port}/ui.html`;
  await app.whenReady();
  win = new BrowserWindow({ width: 1400, height: 900, minWidth: 800, minHeight: 600, show: true, backgroundColor: '#0F1117', titleBarStyle: 'hidden', titleBarOverlay: { color: '#090d16', symbolColor: '#94a3b8', height: 38 }, title: 'spike-layout', webPreferences: { ...WEB_PREFS, preload: PRELOAD } });
  win.setAlwaysOnTop(true, 'floating');
  win.loadURL(chromeUrl); await once(win.webContents, 'did-finish-load'); await C.sleep(500);
  pageView = new WebContentsView({ webPreferences: WEB_PREFS }); pageWc = pageView.webContents;
  win.contentView.addChildView(pageView); applyReport();
  pageWc.loadURL(pageUrl); await once(pageWc, 'did-finish-load'); await C.sleep(600);
  uiView = new WebContentsView({ webPreferences: WEB_PREFS }); // replaced in partModal with timing; created here so later parts can run alone
  uiView.setBackgroundColor('#00000000'); uiView.webContents.loadURL(uiUrl); await once(uiView.webContents, 'did-finish-load');
  const d = screen.getPrimaryDisplay();
  results.display = { scaleFactor: d.scaleFactor, size: d.size, workArea: d.workAreaSize };
  results.window = { bounds: win.getBounds(), content: win.getContentBounds(), firstReport: lastReport, pageViewBounds: pageView.getBounds(), pageDpr: await pageWc.executeJavaScript('devicePixelRatio') };
  log('ready', JSON.stringify(results.display), 'report', JSON.stringify(lastReport));
  const save = () => C.writeJson(path.join(OUT, NAME), results);
  for (const [name, fn] of [['modal', partModal], ['toggle', partToggle], ['hide', partHide], ['keys', partKeys], ['zorder', partZorder], ['resize', partResize]]) {
    if (!want(name)) continue;
    log('part', name);
    try { results.parts[name] = await fn(); } catch (e) { results.parts[name] = { error: e.stack || e.message }; log('  ERROR', e.message); }
    save();
  }
  save(); log('done'); app.exit(0);
}
main().catch((e) => { console.error(e); app.exit(1); });
