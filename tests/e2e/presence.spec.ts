import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, expect, ROOT, type AppHandle } from './fixtures.js';
import { openUrl, startMission, waitForStatus, verifierPasses } from './helpers.js';

/**
 * Agent presence layer (#233, ADR 0011) in the REAL app: the cursor is drawn by a transparent click-through child window,
 * so it must show in a real OS screenshot (CDP screenshots cannot see it), must not take the user's click, and must be
 * invisible to the page and to capturePage. Windows only: ADR 0011 measured that platform; Linux has no layer (docs/limitations.md).
 *
 * The cursor is produced by the product's own path: scripted model -> click tool -> ActionExecutor.clickAt -> presence sink ->
 * PresenceLayer -> overlay window. Nothing here emits a presence event.
 */
test.skip(process.platform !== 'win32', 'presence pixels are only measured on Windows (ADR 0011)');

const DOT = [124, 92, 255]; // the tab agent's colour, set by ViewManager (#7C5CFF)
const EVIDENCE_DIR = path.join(ROOT, 'docs', 'audits', 'evidence', '233');
const OS_SHOT = path.join(ROOT, 'scripts', 'dev', 'os_screenshot.ps1');
const OS_CLICK = path.join(ROOT, 'scripts', 'dev', 'os_click.ps1');

const PAGE = `<!doctype html><meta charset="utf-8"><title>presence fixture</title>
<style>html,body{margin:0;background:#e6e6e6;font:16px sans-serif;cursor:none}
#b{position:absolute;left:60px;top:40px;width:120px;height:50px;background:#bbb;border:1px solid #999;outline:none;cursor:none}</style>
<button id="b">Press me</button><h1 style="position:absolute;left:60px;top:200px">Presence fixture</h1>
<script>
window.__clicks = 0; window.__mut = 0; window.__focusEvents = 0;
document.getElementById('b').addEventListener('click', () => { window.__clicks++; });
new MutationObserver(r => { window.__mut += r.length; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
window.addEventListener('blur', () => window.__focusEvents++); window.addEventListener('focus', () => window.__focusEvents++);
const RE = /aegis|__agent|presence|ripple/i;
window.__scan = () => {
  const hits = [];
  for (const k of Object.getOwnPropertyNames(window)) if (RE.test(k) && !/^IDBCursor/.test(k)) hits.push('global:' + k);
  for (const el of document.querySelectorAll('*')) {
    if (RE.test(el.tagName) || RE.test(el.id) || RE.test(el.className && el.className.baseVal !== undefined ? el.className.baseVal : String(el.className))) hits.push('node:' + el.tagName + '#' + el.id);
    for (const a of el.attributes) if (RE.test(a.name) || RE.test(a.value)) hits.push('attr:' + a.name);
  }
  return { hits, nodeCount: document.querySelectorAll('*').length, mutations: window.__mut };
};
</script>`;

function serve(): Promise<{ url: string; close: () => void }> {
  return new Promise(resolve => {
    const srv = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(srv.address() as any).port}/fixture_page.html`, close: () => srv.close() }));
  });
}

function ps(file: string, args: string[]): { code: number | null; out: string } {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() };
}

/** The Electron main process id as the main process itself reports it (Playwright's own handle may be a launcher). */
async function mainPid(app: AppHandle): Promise<number> {
  return app.electronApp.evaluate(() => process.pid);
}

/** A real OS screen copy of the Electron window (never PrintWindow, which would skip the overlay). */
async function osShot(app: AppHandle, name: string): Promise<{ file: string; left: number; top: number; width: number; height: number }> {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, name);
  const pid = await mainPid(app);
  let last = { code: 1 as number | null, out: '' };
  for (let i = 0; i < 5; i++) {
    last = ps(OS_SHOT, ['-ProcessId', String(pid), '-Out', file]);
    const m = /rect=(-?\d+),(-?\d+),(\d+),(\d+)/.exec(last.out);
    if (last.code === 0 && m && fs.existsSync(file)) return { file, left: +m[1], top: +m[2], width: +m[3], height: +m[4] };
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`OS screenshot failed: ${last.out}`);
}

interface Geometry { view: { x: number; y: number; width: number; height: number }; winWidth: number; zoom: number; dpr: number; tabId: string }

async function geometry(app: AppHandle): Promise<Geometry> {
  const snap = await app.snapshot();
  const tabId = snap.activeTabId!;
  const view = snap.presenceRects[tabId] as Geometry['view'];
  const g = await app.electronApp.evaluate(({ BrowserWindow, webContents }) => {
    const win = BrowserWindow.getAllWindows().find(w => !w.getParentWindow())!;
    const page = webContents.getAllWebContents().find(w => /fixture_page.html/.test(w.getURL()))!;
    return { winWidth: win.getBounds().width, zoom: page.getZoomFactor() };
  });
  return { view, winWidth: g.winWidth, zoom: g.zoom, dpr: 0, tabId };
}

/** Runs in the Electron main process: colour centroid and a before/after diff on real OS screenshots. */
async function analyse(app: AppHandle, args: { file: string; before: string; geo: Geometry; btn: { x: number; y: number } }) {
  return app.electronApp.evaluate(({ nativeImage }, a) => {
    const img = nativeImage.createFromPath(a.file); const before = nativeImage.createFromPath(a.before);
    const { width, height } = img.getSize(); const bmp = img.toBitmap(); const bbmp = before.toBitmap();
    const ratio = width / a.geo.winWidth; // physical px per DIP, whatever the display scale
    const ex = (a.geo.view.x + a.btn.x * a.geo.zoom) * ratio; const ey = (a.geo.view.y + a.btn.y * a.geo.zoom) * ratio;
    // colour centroid of the dot within 10 DIP of the expected point
    const R = 10 * ratio; let sx = 0, sy = 0, n = 0;
    for (let y = Math.max(0, Math.floor(ey - R)); y < Math.min(height, Math.ceil(ey + R)); y++) for (let x = Math.max(0, Math.floor(ex - R)); x < Math.min(width, Math.ceil(ex + R)); x++) {
      const o = (y * width + x) * 4;
      if (Math.abs(bmp[o + 2] - 124) <= 22 && Math.abs(bmp[o + 1] - 92) <= 22 && Math.abs(bmp[o] - 255) <= 22) { sx += x; sy += y; n++; }
    }
    // pixels changed inside the page view, outside the box around the cursor graphics
    const vx0 = Math.round(a.geo.view.x * ratio), vy0 = Math.round(a.geo.view.y * ratio), vx1 = Math.round((a.geo.view.x + a.geo.view.width) * ratio), vy1 = Math.round((a.geo.view.y + a.geo.view.height) * ratio);
    const bx0 = ex - 100 * ratio, bx1 = ex + 160 * ratio, by0 = ey - 70 * ratio, by1 = ey + 70 * ratio;
    let changed = 0, total = 0; const box = { x0: 1e9, y0: 1e9, x1: -1, y1: -1 };
    // the outermost row/column is the OS window border, which changes colour with the window's active state (not the overlay)
    for (let y = vy0; y < Math.min(vy1, height - 2); y++) for (let x = vx0; x < Math.min(vx1, width - 2); x++) {
      if (x >= bx0 && x <= bx1 && y >= by0 && y <= by1) continue;
      const o = (y * width + x) * 4; total++;
      if (Math.abs(bmp[o] - bbmp[o]) + Math.abs(bmp[o + 1] - bbmp[o + 1]) + Math.abs(bmp[o + 2] - bbmp[o + 2]) > 40) { changed++; box.x0 = Math.min(box.x0, x); box.y0 = Math.min(box.y0, y); box.x1 = Math.max(box.x1, x); box.y1 = Math.max(box.y1, y); }
    }
    const dotAreaPx = a.geo.view.width * a.geo.view.height * ratio * ratio;
    return { ratio, count: n, cx: n ? sx / n : null, cy: n ? sy / n : null, ex, ey, errX: n ? sx / n - ex : null, errY: n ? sy / n - ey : null, changed, total, changedBox: box, view: [vx0, vy0, vx1, vy1], shot: { width, height } };
  }, args);
}

async function runPresenceCheck(app: AppHandle, label: string): Promise<void> {
  const page = await serve();
  try {
    await openUrl(app, page.url);
    // Window top-left on the primary display and a known size: forced DPR 2 shrinks the screen to 960x540 DIP.
    await app.electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(w => !w.getParentWindow())!.setBounds({ x: 0, y: 0, width: 800, height: 600 }); });
    await expect.poll(async () => { const s = await app.snapshot(); return s.presenceRects[s.activeTabId!] != null; }, { message: 'page view rect given to the presence layer' }).toBe(true);
    await new Promise(r => setTimeout(r, 600));
    const before = await osShot(app, `${label}_before.png`);

    await startMission(app, 'press the button');
    const done = await waitForStatus(app, ['completed', 'failed', 'cancelled']);
    expect(done.status, done.message).toBe('completed');
    await new Promise(r => setTimeout(r, 1200)); // let the 700 ms cursor animation and the ripple finish

    const snap = await app.snapshot();
    const ev = snap.presence as any;
    const BTN = { x: 60 + 61, y: 40 + 26 }; // centre of the 120x50 + border button at CSS (60,40)
    // The executor's own coordinates (what the tool dispatched), not a number the test chose.
    expect(ev?.kind, JSON.stringify(ev)).toBe('click');
    expect(Math.abs(ev.x - BTN.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(ev.y - BTN.y)).toBeLessThanOrEqual(2);
    const tabWc = await app.electronApp.evaluate(({ webContents }) => {
      const p = webContents.getAllWebContents().find(w => /fixture_page.html/.test(w.getURL()))!;
      return p.executeJavaScript('window.__clicks');
    });
    expect(tabWc, 'the agent click reached the page').toBe(1);

    const after = await osShot(app, `${label}_after.png`);
    const geo = await geometry(app);
    const m = await analyse(app, { file: after.file, before: before.file, geo, btn: { x: ev.x, y: ev.y } });
    fs.writeFileSync(path.join(EVIDENCE_DIR, `${label}_measure.json`), JSON.stringify({ geo, before, after, m, event: ev }, null, 2));
    // 1. visible in a real OS screenshot, at the target (+-3 px, ADR 0011 acceptance)
    expect(m.count, `dot pixels in the OS screenshot ${JSON.stringify(m)}`).toBeGreaterThan(20);
    expect(Math.abs(m.errX!), JSON.stringify(m)).toBeLessThanOrEqual(3);
    expect(Math.abs(m.errY!), JSON.stringify(m)).toBeLessThanOrEqual(3);
    // 2. the overlay is transparent: nothing else in the page view changed
    expect(m.changed, `pixels changed outside the cursor graphics: ${JSON.stringify(m)}`).toBe(0);

    // 3. page cannot see it: no node, global, attribute or mutation, and capturePage has no dot pixels
    const scan = await app.electronApp.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => /fixture_page.html/.test(w.getURL()))!.executeJavaScript('window.__scan()')) as any;
    fs.writeFileSync(path.join(EVIDENCE_DIR, `${label}_page_scan.json`), JSON.stringify(scan, null, 2));
    expect(scan.hits).toEqual([]);
    const cap = await app.electronApp.evaluate(async ({ webContents }) => {
      const p = webContents.getAllWebContents().find(w => /fixture_page.html/.test(w.getURL()))!;
      const img = await p.capturePage(); const b = img.toBitmap(); let n = 0;
      for (let i = 0; i < b.length; i += 4) if (Math.abs(b[i + 2] - 124) <= 22 && Math.abs(b[i + 1] - 92) <= 22 && Math.abs(b[i] - 255) <= 22) n++;
      return { n, size: img.getSize() };
    });
    expect(cap.n, 'dot pixels in capturePage of the page view').toBe(0);

    // 4. a real OS click passes through the overlay, on the dot itself and 60 DIP aside
    const pid = await mainPid(app);
    const r = after.width / geo.winWidth;
    const clickAt = async (dx: number) => ps(OS_CLICK, ['-X', String(Math.round(after.left + (geo.view.x + (BTN.x + dx) * geo.zoom) * r)), '-Y', String(Math.round(after.top + (geo.view.y + BTN.y * geo.zoom) * r)), '-ExpectPid', String(pid)]);
    const c1 = await clickAt(0);
    expect(c1.code, c1.out).toBe(0);
    await expect.poll(() => app.electronApp.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => /fixture_page.html/.test(w.getURL()))!.executeJavaScript('window.__clicks')), { message: 'real click through the cursor reached the page' }).toBe(2);

    // 5. the page's own mutation count did not move because of the overlay (only the button's click handler runs)
    expect(scan.mutations).toBe(0);

    // 6. overlay follows the window and hides on minimise
    const track = await app.electronApp.evaluate(({ BrowserWindow }) => {
      const parent = BrowserWindow.getAllWindows().find(w => !w.getParentWindow())!;
      const ov = BrowserWindow.getAllWindows().find(w => w.getParentWindow())!;
      const near = (a: Electron.Rectangle, b: Electron.Rectangle) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height));
      const out: Record<string, unknown> = { overlayVisible: ov.isVisible(), focusable: ov.isFocusable() };
      out.alignedAtStart = near(ov.getBounds(), parent.getContentBounds());
      parent.setBounds({ x: 20, y: 10, width: 900, height: 650 });
      out.alignedAfterResize = near(ov.getBounds(), parent.getContentBounds());
      parent.minimize(); out.visibleWhileMinimised = ov.isVisible();
      parent.restore(); out.visibleAfterRestore = ov.isVisible();
      out.alignedAfterRestore = near(ov.getBounds(), parent.getContentBounds());
      return out;
    });
    fs.writeFileSync(path.join(EVIDENCE_DIR, `${label}_tracking.json`), JSON.stringify(track, null, 2));
    expect(track.overlayVisible).toBe(true);
    expect(track.focusable).toBe(false);
    expect(track.alignedAtStart).toBeLessThanOrEqual(2);
    expect(track.alignedAfterResize).toBeLessThanOrEqual(2);
    expect(track.visibleWhileMinimised).toBe(false);
    expect(track.visibleAfterRestore).toBe(true);
    expect(track.alignedAfterRestore).toBeLessThanOrEqual(2);
  } finally {
    page.close();
  }
}

const SCRIPT = {
  build: () => [
    { expectTools: ['click', 'done'], expectPageContains: ['Presence fixture', 'button "Press me"'], respond: { text: 'Pressing the button.', tool: 'click', args: { ref: 'e1' } } },
    { respond: { tool: 'done', args: { result: 'Pressed the button on the Presence fixture page.', evidence: ['Presence fixture'] } } }
  ]
};

test.describe('presence layer, DPR 1', () => {
  test.use({ script: SCRIPT, verifierScript: { build: () => [verifierPasses('Presence fixture')] }, extraArgs: ['--force-device-scale-factor=1'] });
  test('the agent cursor is visible in an OS screenshot, takes no clicks and is invisible to the page', async ({ app }) => {
    await runPresenceCheck(app, 'dpr1');
  });
});

test.describe('presence layer, DPR 2', () => {
  test.use({ script: SCRIPT, verifierScript: { build: () => [verifierPasses('Presence fixture')] }, extraArgs: ['--force-device-scale-factor=2'] });
  test('same at forced device scale factor 2', async ({ app }) => {
    await runPresenceCheck(app, 'dpr2');
  });
});
