// Shared helpers for the design-spike harnesses (spike_live_view.mjs, spike_presence.mjs, spike_layout.mjs).
// Design spikes for #232 / #233 / #237. Not product code: nothing under src/ imports this file.
// Runs inside Electron's main process (`electron scripts/dev/spike_*.mjs`), Windows only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => performance.now();

export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[k] = v;
  }
  return out;
}

export function pctl(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}
export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
export const round = (n, d = 2) => (n == null || Number.isNaN(n) ? n : Math.round(n * 10 ** d) / 10 ** d);
export const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

export function withTimeout(promise, ms, label = 'timeout') {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label)), ms); }),
  ]);
}

/** Serve in-memory pages from 127.0.0.1 on an ephemeral port. routes: { '/x.html': 'html' | (url)=>string } */
export function serve(routes) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const r = routes[u.pathname];
      if (r == null) { res.writeHead(404); res.end('nf'); return; }
      const body = typeof r === 'function' ? r(u) : r;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => srv.close() }));
  });
}

/** The page every strategy is measured against: rAF counter, 100 ms timer, CSS animation, canvas redrawn each frame, a button. */
export const VISIBILITY_HTML = `<!doctype html><meta charset="utf-8"><title>visibility fixture</title>
<style>
 html,body{margin:0;background:#101418;color:#dfe;font:14px monospace;height:100%;overflow:hidden}
 #anim{position:absolute;left:0;top:200px;width:80px;height:80px;background:#4af;animation:mv 1s linear infinite alternate}
 @keyframes mv{from{transform:translateX(0)}to{transform:translateX(300px)}}
 #btn{position:absolute;left:100px;top:100px;width:120px;height:40px}
 #c{position:absolute;right:0;top:0;width:120px;height:120px}
 #hud{padding:6px;white-space:pre}
</style>
<div id="hud"></div><button id="btn">target</button><div id="anim"></div><canvas id="c" width="120" height="120"></canvas>
<script>
 window.__raf = 0; window.__tmr = 0; window.__clicks = 0; window.__moves = 0; window.__visEvents = 0;
 const ctx = document.getElementById('c').getContext('2d');
 (function f(){ window.__raf++; ctx.fillStyle = 'hsl(' + (window.__raf * 7 % 360) + ',80%,50%)'; ctx.fillRect(0,0,120,120); requestAnimationFrame(f); })();
 setInterval(() => { window.__tmr++; }, 100);
 document.getElementById('btn').addEventListener('click', () => { window.__clicks++; });
 document.addEventListener('mousemove', () => { window.__moves++; });
 document.addEventListener('visibilitychange', () => { window.__visEvents++; });
 setInterval(() => { document.getElementById('hud').textContent = 'raf=' + window.__raf + ' tmr=' + window.__tmr + ' vis=' + document.visibilityState + ' focus=' + document.hasFocus() + ' clicks=' + window.__clicks; }, 250);
</script>`;

export const STATE_EXPR = `({raf: window.__raf, tmr: window.__tmr, clicks: window.__clicks, moves: window.__moves, visEvents: window.__visEvents, vis: document.visibilityState, focus: document.hasFocus(), iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio})`;

/** Run powershell and capture stdout (async so the Electron main loop keeps running). */
export function ps(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', ...args], { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.trim(), err: err.trim(), ms: Date.now() - t0 }); });
  });
}
export const psCommand = (cmd, opts) => ps(['-Command', cmd], opts);

/** Real OS screen copy of the Electron window (scripts/dev/os_screenshot.ps1). Retries when the helper reports the window is covered. */
export async function osScreenshot(pid, outFile, extra = []) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  let last;
  for (let i = 0; i < 4; i++) {
    last = await ps(['-File', path.join(here, 'os_screenshot.ps1'), '-ProcessId', String(pid), '-Out', outFile, ...extra]);
    if (last.code === 0 && fs.existsSync(outFile)) return { ok: true, info: last.out, attempts: i + 1 };
  }
  return { ok: false, info: last.out || last.err, attempts: 4 };
}

export async function osChildren(pid) {
  const r = await ps(['-File', path.join(here, 'os_screenshot.ps1'), '-ProcessId', String(pid), '-Children']);
  return r.out;
}

export async function systemSnapshot() {
  const r = await psCommand("$o=Get-CimInstance Win32_OperatingSystem; $c=(Get-CimInstance Win32_Processor).LoadPercentage; \"$([int]($o.FreePhysicalMemory/1024)) $c\"");
  const [free, load] = r.out.split(/\s+/).map(Number);
  return { freeMemMB: free, systemCpuLoadPct: load };
}

/** Cumulative CPU seconds per pid from Win32, with a PowerShell-side UTC timestamp (ms) so the rate window is exact. */
export async function procCpuSeconds(pids) {
  const m = new Map();
  if (!pids.length) return { tMs: Date.now(), map: m };
  const r = await psCommand(`$t=[DateTime]::UtcNow.Ticks; Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.TotalProcessorTime.TotalSeconds)" }; "T $($t)"`);
  let tMs = Date.now();
  for (const line of r.out.split("\n")) {
    const [a, b] = line.trim().split(/\s+/);
    if (a === 'T') tMs = Number(BigInt(b) / 10000n); else if (a && b) m.set(Number(a), Number(b));
  }
  return { tMs, map: m };
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

export const hostInfo = () => ({
  platform: process.platform, release: os.release(), cpus: os.cpus()[0]?.model, threads: os.cpus().length,
  totalMemMB: Math.round(os.totalmem() / 1048576), node: process.versions.node, electron: process.versions.electron,
  chrome: process.versions.chrome, date: new Date().toISOString(),
});

/** Decode a PNG file with Electron's nativeImage and return a function pixelAt(x,y)->[r,g,b,a] over its BGRA bitmap. */
export function loadPng(nativeImage, file) {
  const img = nativeImage.createFromPath(file);
  const { width, height } = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  return {
    width, height, bmp,
    at: (x, y) => { const o = (y * width + x) * 4; return [bmp[o + 2], bmp[o + 1], bmp[o], bmp[o + 3]]; },
  };
}

/** Centroid of pixels whose colour is within `tol` (per channel) of rgb inside the rect (physical px). */
export function findColor(png, rgb, rect, tol = 40) {
  let sx = 0, sy = 0, n = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
  const x0 = Math.max(0, rect.x | 0), y0 = Math.max(0, rect.y | 0);
  const x1 = Math.min(png.width, (rect.x + rect.w) | 0), y1 = Math.min(png.height, (rect.y + rect.h) | 0);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = (y * png.width + x) * 4; const b = png.bmp[o], g = png.bmp[o + 1], r = png.bmp[o + 2];
    if (Math.abs(r - rgb[0]) <= tol && Math.abs(g - rgb[1]) <= tol && Math.abs(b - rgb[2]) <= tol) {
      sx += x; sy += y; n++; if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
  }
  return { count: n, cx: n ? sx / n : null, cy: n ? sy / n : null, bbox: n ? { minX, minY, maxX, maxY } : null };
}

/** Count pixels that differ by more than `thr` (sum |dR|+|dG|+|dB|) between two loaded PNGs inside a rect. */
export function diffRegion(a, b, rect, thr = 40) {
  let changed = 0, total = 0;
  const x0 = Math.max(0, rect.x | 0), y0 = Math.max(0, rect.y | 0);
  const x1 = Math.min(a.width, b.width, (rect.x + rect.w) | 0), y1 = Math.min(a.height, b.height, (rect.y + rect.h) | 0);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const oa = (y * a.width + x) * 4, ob = (y * b.width + x) * 4;
    const d = Math.abs(a.bmp[oa] - b.bmp[ob]) + Math.abs(a.bmp[oa + 1] - b.bmp[ob + 1]) + Math.abs(a.bmp[oa + 2] - b.bmp[ob + 2]);
    total++; if (d > thr) changed++;
  }
  return { changed, total };
}
