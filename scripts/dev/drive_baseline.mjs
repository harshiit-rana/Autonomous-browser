#!/usr/bin/env node
/**
 * RUN-01 (#223): launches the REAL built app (dist/) and drives it with Playwright attached over CDP.
 *
 *   npm run build && node scripts/dev/drive_baseline.mjs [--out <dir>] [--port 9333]
 *
 * Nothing here asserts a pre-decided verdict. Every scenario records what was measured; `status` is computed
 * from the checks, and docs/audits/RUNNING_APP_BASELINE.md is written by a human from the resulting scenario_results.json.
 *
 * What is real and what is not:
 *  - Electron, the chrome renderer, WebContentsViews, IPC, persistence, credential vault, swarm coordinator and
 *    agent loop are the product code in dist/. Websites (duckduckgo.com, example.com) are fetched from the internet.
 *  - No model API key exists in this environment, so "a model" is a LOCAL STUB endpoint started by this script
 *    (scripted OpenAI-compatible responses). It is NOT a real model and its answers prove nothing about model
 *    quality; it only lets the agent loop, step feed, counters and controls run in the real app. Where a stub is
 *    in play the scenario says so.
 *  - CDP screenshots only capture the chrome renderer, never the native WebContentsView children on top of it.
 *    Every screenshot named os_* is a screen capture of the real window (scripts/dev/os_screenshot.ps1).
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { chromium } = require('playwright-core');
const electronExe = require(path.join(root, 'node_modules', 'electron'));

const argv = process.argv.slice(2);
const argVal = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const OUT = path.resolve(argVal('--out', path.join(root, 'docs', 'audits', 'evidence', 'run01')));
const PREFERRED_PORT = Number(argVal('--port', '9333'));
const ONLY = argVal('--only', '');
fs.mkdirSync(OUT, { recursive: true });
for (const n of fs.readdirSync(OUT)) if (/\.(png|json|log)$/.test(n) && n !== 'build.log') fs.rmSync(path.join(OUT, n)); // evidence of one clean run only

const sleep = ms => new Promise(r => setTimeout(r, ms));
const FAKE_KEY = 'AIzaSyBASELINE-NOT-A-REAL-KEY-0123456789';
const results = [];
const extra = {};
const sha = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);

// ------------------------------------------------------------------ small utilities
function ps(command) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8', timeout: 45000 });
  return (r.stdout || '').trim();
}
function isPortFree(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}
async function pickPort() {
  const notes = [];
  for (let p = PREFERRED_PORT; p < PREFERRED_PORT + 30; p++) {
    if (await isPortFree(p)) { if (p !== PREFERRED_PORT) notes.push(`port ${PREFERRED_PORT} busy, using ${p}`); return { port: p, notes }; }
    notes.push(`port ${p} busy`);
  }
  throw new Error('no free port');
}
function descendantCpuSeconds(pid) {
  // breadth-first over the process tree with a visited set (PID reuse can create cycles)
  const out = ps(`$all=Get-CimInstance Win32_Process; $seen=New-Object 'System.Collections.Generic.HashSet[int]'; $q=New-Object System.Collections.Queue; $q.Enqueue([int]${pid}); while($q.Count -gt 0){ $c=$q.Dequeue(); if(-not $seen.Add($c)){continue}; foreach($p in $all){ if($p.ParentProcessId -eq $c -and $p.ProcessId -ne 0){ $q.Enqueue([int]$p.ProcessId) } } }; $s=0; foreach($id in $seen){ $p=Get-Process -Id $id -ErrorAction SilentlyContinue; if($p){ $s += $p.TotalProcessorTime.TotalSeconds } }; "$s;$($seen.Count)"`);
  const [s, n] = out.split(';');
  return { cpuSeconds: Number(s), processes: Number(n) };
}
async function cpuPercent(pid, ms) {
  const a = descendantCpuSeconds(pid); const t0 = Date.now();
  await sleep(ms);
  const b = descendantCpuSeconds(pid); const dt = (Date.now() - t0) / 1000;
  return { percentOfOneCore: Number((((b.cpuSeconds - a.cpuSeconds) / dt) * 100).toFixed(1)), processes: b.processes, seconds: Number(dt.toFixed(1)) };
}

// ------------------------------------------------------------------ fixture site + scripted model stub
const stub = { requests: [], pathsSeen: new Set(), inflightClosed: 0, mode: 'normal', requirePrefixV1: true, server: null, port: 0 };
function fixtureHtml(title, h1) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:sans-serif">
<h1>${h1}</h1><p>Local fixture served by the RUN-01 driver.</p>
<a id="next" href="/second">Go to second page</a> <button id="b" onclick="document.getElementById('o').textContent='clicked '+Date.now()">Click me</button><div id="o"></div>
<div id="tick" style="font-size:48px">0</div><canvas id="c" width="300" height="60"></canvas>
<script>let n=0;const c=document.getElementById('c').getContext('2d');(function f(){n++;document.getElementById('tick').textContent=n;c.fillStyle='hsl('+(n*3%360)+',80%,50%)';c.fillRect(0,0,300,60);requestAnimationFrame(f)})()</script></body></html>`;
}
function startStub() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const url = req.url || '/';
      stub.pathsSeen.add(`${req.method} ${url}`);
      if (url === '/' || url === '/ticker') { res.setHeader('content-type', 'text/html'); return res.end(fixtureHtml('Baseline Fixture Page', 'Baseline Fixture Heading')); }
      if (url === '/second') { res.setHeader('content-type', 'text/html'); return res.end(fixtureHtml('Second Fixture Page', 'Second Heading')); }
      if (url === '/api/tags') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ models: [{ name: 'stub-model:latest' }] })); }
      if (req.method === 'POST' && /chat\/completions$/.test(url)) {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', async () => {
          const wrongPath = stub.requirePrefixV1 && url !== '/v1/chat/completions';
          let body = {};
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
          const msgs = body.messages || [];
          const firstUser = String((msgs.find(m => m.role === 'user') || {}).content || '');
          const lastUser = String([...msgs].reverse().find(m => m.role === 'user')?.content || '');
          const entry = { t: Date.now(), path: url, model: body.model, messageCount: msgs.length, tools: (body.tools || []).length, wrongPath, firstUser: firstUser.slice(0, 120), lastUserHasSteer: msgs.some(m => typeof m.content === 'string' && m.content.includes('[User Steering Instruction]')) };
          stub.requests.push(entry);
          if (wrongPath) { res.statusCode = 404; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ error: { message: `404 page not found (stub mimics Ollama, which only serves /v1/chat/completions; got ${url})` } })); }
          let closed = false;
          req.on('close', () => { if (!res.writableEnded) { closed = true; stub.inflightClosed++; entry.clientAborted = true; } });
          let call;
          const assistants = msgs.filter(m => m.role === 'assistant').length;
          if (firstUser.includes('SLOWMODE')) { await sleep(3000); call = { name: 'wait', args: { ms: 100 } }; }
          else if (assistants === 0 && firstUser.includes('NAVFIRST')) { const m = firstUser.match(/http:\/\/127\.0\.0\.1:\d+\/\S*/); call = { name: 'navigate', args: { url: m ? m[0] : 'https://example.com' } }; }
          else if (assistants === 0) { const ref = lastUser.match(/\[(e\d+)\][^\n]*Click me/) || lastUser.match(/\[(e\d+)\]/); call = ref ? { name: 'click', args: { ref: ref[1] } } : { name: 'wait', args: { ms: 100 } }; }
          else { const t = lastUser.match(/Title:\s*([^\n]*)/); call = { name: 'done', args: { result: `Page title seen by the scripted stub: ${t ? t[1].trim() : '(none)'}`, evidence: [] } }; }
          if (closed) return;
          const text = JSON.stringify(msgs).length;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            id: 'stub-' + stub.requests.length, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
            choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: `[stub] step ${assistants + 1}`, tool_calls: [{ id: 'call_' + stub.requests.length, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }],
            usage: { prompt_tokens: Math.ceil(text / 4), completion_tokens: 20, total_tokens: Math.ceil(text / 4) + 20 }
          }));
        });
        return;
      }
      res.statusCode = 404; res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => { stub.server = server; stub.port = server.address().port; resolve(); });
  });
}

// ------------------------------------------------------------------ app launch
async function launchApp(label, { extraArgs = [], profile, env = {}, cdpPort, isolateChromium = true } = {}) {
  const prof = profile || fs.mkdtempSync(path.join(os.tmpdir(), `aegis-baseline-${label}-`));
  const logPath = path.join(OUT, label === 'main' ? 'electron.log' : `electron_${label}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'w' });
  const e = { ...process.env, AEGIS_USER_DATA: prof, ELECTRON_ENABLE_LOGGING: '1', ...env };
  delete e.ELECTRON_RUN_AS_NODE;
  // AEGIS_USER_DATA does not move Chromium's own profile (cookies, cache, single-instance lock): see scenario E.
  const args = [`--remote-debugging-port=${cdpPort}`, ...(isolateChromium ? [`--user-data-dir=${path.join(prof, 'chromium')}`] : []), '--disable-features=CalculateNativeWinOcclusion', ...extraArgs, path.join(root, 'dist', 'main', 'index.js')];
  const child = spawn(electronExe, args, { env: e, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const app = { label, child, profile: prof, logPath, log: '', exited: null, cdpPort, args };
  const onData = d => { const s = d.toString(); app.log += s; logStream.write(s); };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  child.on('exit', (code, sig) => { app.exited = { code, sig }; logStream.end(); });
  let browser = null;
  for (let i = 0; i < 60 && !app.exited; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 2000 }); break; } catch { await sleep(500); }
  }
  if (!browser) throw new Error(`could not attach CDP on ${cdpPort}; exited=${JSON.stringify(app.exited)}\n${app.log.slice(0, 1500)}`);
  app.browser = browser;
  app.ctx = browser.contexts()[0];
  for (let i = 0; i < 60; i++) { app.chrome = app.ctx.pages().find(p => p.url().includes('renderer/index.html')); if (app.chrome) break; await sleep(250); }
  if (!app.chrome) throw new Error('chrome renderer page not found');
  app.consoleMsgs = [];
  app.chrome.on('console', m => app.consoleMsgs.push({ type: m.type(), text: m.text() }));
  app.chrome.on('pageerror', e2 => app.consoleMsgs.push({ type: 'pageerror', text: String(e2) }));
  await app.chrome.waitForSelector('#titlebar', { timeout: 20000 });
  await app.chrome.waitForFunction(() => Boolean(window.aegis), null, { timeout: 15000 }).catch(() => {});
  return app;
}
async function closeApp(app) {
  try { await app.browser.close(); } catch {}
  if (!app.exited) { spawnSync('taskkill', ['/PID', String(app.child.pid), '/T', '/F']); await sleep(800); }
}
const nativePages = app => app.ctx.pages().filter(p => !p.url().startsWith('file://') && !p.url().startsWith('devtools://'));
function osShot(app, name) {
  const file = path.join(OUT, `${name}.png`);
  let r;
  for (let attempt = 1; attempt <= 4; attempt++) {
    r = spawnSync('powershell', ['-NoProfile', '-File', path.join(root, 'scripts', 'dev', 'os_screenshot.ps1'), '-ProcessId', String(app.child.pid), '-Out', file], { encoding: 'utf8' });
    const m = /rect=(-?\d+),(-?\d+),(\d+),(\d+)/.exec(r.stdout || '');
    if (r.status === 0 && m && Number(m[3]) >= 600 && Number(m[4]) >= 400) break;
    console.error(`    (osShot ${name}: attempt ${attempt} saw an unusable window rect: ${(r.stdout || '').trim()} ${(r.stderr || '').trim().slice(0, 120)}; retrying)`);
    spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 1500']);
  }
  if (r.status !== 0) return { file: null, error: (r.stderr || r.stdout).trim().slice(0, 200) };
  return { file: path.basename(file), rect: r.stdout.trim() };
}
function setWindowSize(app, size) {
  const r = spawnSync('powershell', ['-NoProfile', '-File', path.join(root, 'scripts', 'dev', 'os_screenshot.ps1'), '-ProcessId', String(app.child.pid), '-SetSize', size], { encoding: 'utf8' });
  return r.stdout.trim();
}
async function cdpShot(app, name) {
  const file = path.join(OUT, `${name}.png`);
  for (let attempt = 1; ; attempt++) {
    try { await app.chrome.screenshot({ path: file, timeout: 15000 }); break; } catch (e) { if (attempt >= 3) throw e; await sleep(1500); }
  }
  return path.basename(file);
}
async function ipc(app, fn, ...args) {
  return app.chrome.evaluate(([n, a]) => window.aegis[n](...a), [fn, args]);
}
async function waitUntil(fn, timeoutMs = 10000, every = 200) {
  const t0 = Date.now();
  for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t0 > timeoutMs) return null; await sleep(every); }
}
const tabTitles = app => app.chrome.$$eval('#tabs-container .tab', els => els.map(e => ({ active: e.classList.contains('active'), title: e.querySelector('.tab-title')?.textContent, badge: e.querySelector('.profile-badge')?.textContent })));
const timelineItems = app => app.chrome.$$eval('#evidence-feed .evidence-item .ev-text', els => els.map(e => e.textContent));
// Real geometry of the native views: Win32 child HWNDs of the app window. (document.innerWidth of a page inside a
// WebContentsView does NOT follow setBounds(0,0,0,0), so it cannot be used to tell whether a view is hidden.)
function nativeViews(app) {
  const r = spawnSync('powershell', ['-NoProfile', '-File', path.join(root, 'scripts', 'dev', 'os_screenshot.ps1'), '-ProcessId', String(app.child.pid), '-Children'], { encoding: 'utf8' });
  const top = r.stdout.match(/top=(-?\d+),(-?\d+),(\d+),(\d+) dpi=(\d+)/) || [];
  const kids = JSON.parse((r.stdout.match(/children=(.*)/) || [, '[]'])[1]);
  const scale = (Number(top[5]) || 96) / 96;
  return kids.filter(k => /RenderWidgetHost/.test(k.class)).map(k => ({ visible: k.visible, x: Math.round((k.x - Number(top[1])) / scale), y: Math.round((k.y - Number(top[2])) / scale), w: Math.round(k.w / scale), h: Math.round(k.h / scale) }));
}
// NOTE: the child HWND keeps its old size after the app calls setBounds(0,0,0,0) (measured: the Settings modal is
// fully visible in the real window while this still reports 1080x728). It is only good for the Stage geometry;
// whether a view is hidden must be decided from pixels (os_screenshot + png_diff against the chrome-only CDP frame).
const nativeSize = async app => nativeViews(app).filter(v => v.visible && v.y > 40 && v.w > 0 && v.h > 0).map(v => ({ w: v.w, h: v.h, x: v.x, y: v.y, url: '(active page view)' }));
async function missionStates(app) { const r = await ipc(app, 'listMissions', 20); return r && r.ok ? r.data : []; }
async function lastStatusEvents(app, missionId, n = 3) {
  const r = await ipc(app, 'getMissionEvents', missionId, 0, 500);
  if (!r?.ok) return [];
  return r.data.events.filter(e => e.kind === 'status').slice(-n).map(e => `${e.data.status}: ${e.data.message}`);
}
async function startViaUi(app, prompt, { execute = true } = {}) {
  await app.chrome.fill('#omnibar-input', prompt);
  await app.chrome.press('#omnibar-input', 'Enter');
  const visible = await waitUntil(async () => !(await app.chrome.$eval('#plan-preview-modal', e => e.classList.contains('hidden'))), 8000);
  if (!visible) return { planModal: false };
  const plan = await app.chrome.evaluate(() => ({
    goal: document.getElementById('plan-goal-text').textContent,
    steps: [...document.querySelectorAll('#plan-steps-container .plan-step-item')].map(s => s.textContent.replace(/\s+/g, ' ').trim()),
    duration: document.getElementById('plan-est-duration').textContent,
    cost: document.getElementById('plan-est-cost').textContent
  }));
  if (execute) await app.chrome.click('#execute-plan-btn');
  return { planModal: true, plan };
}
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: Boolean(ok), detail: String(detail) }); return ok; };
async function scenario(id, title, expectation, fn) {
  if (ONLY && !ONLY.split(',').includes(String(id))) return;
  checks.length = 0;
  const rec = { id, title, expectation, status: 'ERROR', checks: [], observations: [], screenshots: [], durationMs: 0 };
  const t0 = Date.now();
  const obs = s => { rec.observations.push(s); console.log(`    ${s}`); };
  const shots = s => rec.screenshots.push(s);
  console.log(`\n[${id}] ${title}`);
  try { await fn({ obs, shots, rec }); } catch (e) { rec.observations.push(`SCENARIO ERROR: ${e.message}`); console.log('    ERROR', e.stack); }
  rec.checks = checks.map(c => ({ ...c }));
  rec.durationMs = Date.now() - t0;
  const okN = rec.checks.filter(c => c.ok).length;
  rec.status = rec.checks.length === 0 ? 'ERROR' : okN === rec.checks.length ? 'PASS' : okN === 0 ? 'FAIL' : 'PARTIAL';
  console.log(`  => ${rec.status} (${okN}/${rec.checks.length} checks)`);
  results.push(rec);
}
function scanProfile(profile, needle) {
  const hits = [];
  const walk = d => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, n.name); if (n.isDirectory()) { if (['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnWebGPUCache', 'DawnGraphiteCache', 'Local Storage', 'Session Storage', 'Network', 'blob_storage', 'Shared Dictionary', 'cache'].includes(n.name)) continue; walk(p); } else { try { if (fs.readFileSync(p).includes(needle)) hits.push(path.relative(profile, p)); } catch {} } } };
  walk(profile);
  return hits;
}

// ================================================================== main
await startStub();
const { port, notes: portNotes } = await pickPort();
const gitBefore = spawnSync('git', ['status', '--porcelain', '--ignored'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter(l => l && !l.includes('docs/audits/evidence/run01') && !l.includes('dist/') && !l.includes('.native') && !l.includes('node_modules') && !l.includes('tests/output'));
const env = {
  os: ps('(Get-CimInstance Win32_OperatingSystem | ForEach-Object { $_.Caption + " " + $_.Version })'),
  cpu: os.cpus()[0].model + ` x${os.cpus().length}`,
  ramGB: Math.round(os.totalmem() / 2 ** 30),
  gpu: ps('(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + " driver " + $_.DriverVersion }) -join "; "'),
  node: process.version,
  electron: JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version,
  commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
  stubPort: stub.port,
  cdpPort: port,
  portNotes
};
extra.environment = env;
console.log('ENV', JSON.stringify(env, null, 2));
const A = await launchApp('main', { cdpPort: port });
const fixtureUrl = `http://127.0.0.1:${stub.port}/`;
const tickerUrl = `http://127.0.0.1:${stub.port}/ticker`;
extra.profile = A.profile;
extra.launchArgs = A.args.map(a => a.replace(root, '<repo>'));

// ------------------------------------------------------------------ 1 launch + titlebar
await scenario(1, 'App opens; custom titlebar renders; no console errors',
  'Window opens, titlebar/tab strip/window controls render, window.aegis exists, chrome-renderer console has no errors.',
  async ({ obs, shots }) => {
    await sleep(2500);
    const dom = await A.chrome.evaluate(() => ({
      titlebar: !!document.getElementById('titlebar')?.offsetHeight,
      logo: document.querySelector('.app-logo span')?.textContent,
      tabStrip: !!document.getElementById('tab-strip')?.offsetHeight,
      controls: !!document.querySelector('.window-controls')?.offsetHeight,
      bridge: typeof window.aegis,
      bridgeKeys: window.aegis ? Object.keys(window.aegis).length : 0,
      dpr: window.devicePixelRatio, inner: [innerWidth, innerHeight], title: document.title
    }));
    check('titlebar visible', dom.titlebar); check('tab strip visible', dom.tabStrip); check('window controls rendered', dom.controls);
    check('preload bridge window.aegis defined', dom.bridge === 'object', `${dom.bridgeKeys} members`);
    obs(`DOM: ${JSON.stringify(dom)}`);
    const tabs = await tabTitles(A); obs(`tab strip: ${JSON.stringify(tabs)}`);
    check('startup tab present', tabs.length >= 1);
    const consoleErrors = A.consoleMsgs.filter(m => m.type === 'error' || m.type === 'pageerror');
    const logErrors = A.log.split('\n').filter(l => /CONSOLE|Uncaught|\[ERROR\]/.test(l) && /ERROR/.test(l));
    check('no chrome renderer console errors (listener attached after load)', consoleErrors.length === 0, JSON.stringify(consoleErrors));
    check('no ERROR lines in electron.log at startup', logErrors.length === 0, logErrors.slice(0, 3).join(' | '));
    obs(`startup log mentions loading ${(A.log.match(/Creating tab \{[\s\S]*?url: '([^']+)'/) || [])[1]} as the first tab (network request on every launch)`);
    shots(osShot(A, 'os_01_app_open').file); shots(await cdpShot(A, 'cdp_01_chrome_renderer_only'));
    obs('os_01 shows the real window; cdp_01 is the chrome renderer alone: the native page view is absent from CDP shots.');
  });

// ------------------------------------------------------------------ 2 tabs + navigation
await scenario(2, 'Open a new tab; navigate to https://example.com; back/forward/reload; tab strip title updates',
  'A new tab opens, the omnibar navigates it to example.com, tab title becomes "Example Domain", back/forward/reload act on the page.',
  async ({ obs, shots }) => {
    const before = (await tabTitles(A)).length;
    await A.chrome.click('#new-tab-btn');
    const added = await waitUntil(async () => (await tabTitles(A)).length === before + 1, 6000);
    check('new tab appears in strip', added, `tabs before=${before}`);
    await sleep(2500);
    await A.chrome.fill('#omnibar-input', 'https://example.com');
    await A.chrome.press('#omnibar-input', 'Enter');
    const nav = await waitUntil(async () => nativePages(A).some(p => p.url().startsWith('https://example.com')), 15000);
    check('native page navigated to example.com', nav);
    const titled = await waitUntil(async () => (await tabTitles(A)).some(t => t.active && t.title === 'Example Domain'), 8000);
    check('active tab title updated to "Example Domain"', titled, JSON.stringify(await tabTitles(A)));
    const heading = await nativePages(A).find(p => p.url().startsWith('https://example.com'))?.textContent('h1').catch(() => null);
    obs(`h1 of the real page: ${JSON.stringify(heading)}`);
    shots(osShot(A, 'os_02a_example_com').file);
    const origin0 = await nativePages(A).find(p => p.url().startsWith('https://example.com')).evaluate(() => performance.timeOrigin);
    await A.chrome.click('#back-btn');
    const back = await waitUntil(async () => nativePages(A).some(p => p.url().includes('duckduckgo.com')) && (await A.chrome.inputValue('#omnibar-input')).includes('duckduckgo'), 10000);
    check('back returns to previous page and omnibar follows', back, await A.chrome.inputValue('#omnibar-input'));
    await A.chrome.click('#forward-btn');
    const fwd = await waitUntil(async () => nativePages(A).some(p => p.url().startsWith('https://example.com')), 10000);
    check('forward returns to example.com', fwd);
    await sleep(1500);
    await A.chrome.click('#reload-btn');
    await sleep(2500);
    const origin1 = await nativePages(A).find(p => p.url().startsWith('https://example.com'))?.evaluate(() => performance.timeOrigin).catch(() => null);
    check('reload really reloads the page (new document timeOrigin)', origin1 && origin1 !== origin0, `${origin0} -> ${origin1}`);
    obs(`final tab strip: ${JSON.stringify(await tabTitles(A))}`);
    shots(osShot(A, 'os_02b_after_back_forward_reload').file);
  });

// ------------------------------------------------------------------ 3 settings modal visibility + invalid-key test
await scenario(3, 'Settings modal opens visibly (vs native page view) and the credentials test button reports an invalid key',
  'DOM modal is actually visible in the real window; "Test Key" with an invalid key shows an error and does not crash.',
  async ({ obs, shots }) => {
    const viewsBefore = nativeViews(A);
    await A.chrome.click('#settings-btn');
    await A.chrome.waitForSelector('#settings-modal:not(.hidden)');
    await sleep(900);
    const domVisible = await A.chrome.isVisible('#settings-modal .modal-card');
    const viewsOpen = nativeViews(A); const sizeOpen = await nativeSize(A);
    check('modal is visible in the DOM', domVisible);
    obs(`Win32 render-widget child windows (x,y,w,h in DIP) before opening: ${JSON.stringify(viewsBefore)}; while the modal is open: ${JSON.stringify(viewsOpen)} (the HWND keeps its size even when the app hides the view with setBounds 0x0, so pixels decide below)`);
    const cardRect = await A.chrome.$eval('#settings-modal .modal-card', e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(v => Math.round(v * devicePixelRatio)); });
    const osOpen = osShot(A, 'os_03a_settings_modal_open'); shots(osOpen.file);
    shots(await cdpShot(A, 'cdp_03a_settings_modal_open'));
    const cardDiff = pngDiff('os_03a_settings_modal_open.png', 'cdp_03a_settings_modal_open.png', cardRect);
    obs(`pixels of the modal card region that differ between the real window (os_03a) and the chrome renderer's own frame (cdp_03a): ${JSON.stringify(cardDiff)}`);
    check('modal card is painted unobstructed in the real window (pixels match the chrome renderer)', cardDiff.total > 0 && cardDiff.changed / cardDiff.total < 0.02, JSON.stringify(cardDiff));
    const vpRect = await A.chrome.$eval('#webview-viewport', e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(v => Math.round(v * devicePixelRatio)); });
    const vpDiff = pngDiff('os_03a_settings_modal_open.png', 'cdp_03a_settings_modal_open.png', vpRect);
    obs(`page area (webview viewport) pixels that differ between the real window and the chrome-only frame while the modal is open: ${JSON.stringify(vpDiff)}. Near 0 means the native page view is not painted there: the app hides it (shrinks it to 0x0, #138), so the page behind the modal is blank rather than dimmed.`);
    check('while the modal is open the native page view is hidden (page area equals the chrome-only frame)', vpDiff.total > 0 && vpDiff.changed / vpDiff.total < 0.05, JSON.stringify(vpDiff));
    await A.chrome.fill('#settings-gemini-key', 'INVALID_KEY_BASELINE_PROBE');
    const t0 = Date.now();
    await A.chrome.click('#test-gemini-btn');
    const msg = await waitUntil(async () => { const t = await A.chrome.textContent('#settings-status-msg'); return t && !/^Testing/.test(t) ? t : null; }, 30000, 250);
    obs(`"Test Key" result after ${Date.now() - t0} ms: ${JSON.stringify(msg)}`);
    check('invalid key produces a visible error message', msg && msg.startsWith('✗'), msg);
    shots(osShot(A, 'os_03b_invalid_key_error').file);
    await A.chrome.keyboard.press('Escape');
    await sleep(600);
    const closed = await A.chrome.$eval('#settings-modal', e => e.classList.contains('hidden'));
    const after = osShot(A, 'os_03c_after_close'); shots(after.file);
    await cdpShot(A, 'tmp_03c_cdp');
    const vpAfter = pngDiff('os_03c_after_close.png', 'tmp_03c_cdp.png', vpRect);
    fs.rmSync(path.join(OUT, 'tmp_03c_cdp.png'), { force: true });
    obs(`after Escape: page area differs from the chrome-only frame by ${JSON.stringify(vpAfter)} (large = the page view is back)`);
    check('Escape closes the modal and the page view comes back', closed && vpAfter.total > 0 && vpAfter.changed / vpAfter.total > 0.2, JSON.stringify(vpAfter));
    await A.chrome.fill('#settings-gemini-key', '').catch(() => {});
  });

// ------------------------------------------------------------------ 4 no key, demoMode=false
await scenario(4, 'No API key and demoMode=false: starting a mission gives a clear "configure a model" error, not a crash',
  'The mission is refused with a readable message (and Settings opens); main process stays alive and responsive.',
  async ({ obs, shots }) => {
    const st = await ipc(A, 'getSettings'); obs(`settings at first run: provider=${st.data.modelProvider} model=${st.data.modelName} keys=${JSON.stringify(Object.keys(st.data.apiKeys || {}))}`);
    check('first-run settings have no demoMode setting (removed in #224) and no key', st.data.demoMode === undefined && Object.keys(st.data.apiKeys || {}).length === 0);
    const envKeys = ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'].filter(k => process.env[k]);
    check('no model API key present in the environment', envKeys.length === 0, envKeys.join(',') || 'none set');
    // The issue's own example phrase, typed the way a user would:
    const urlBefore = nativePages(A).map(p => p.url());
    await A.chrome.fill('#omnibar-input', 'open example.com and tell me the page heading');
    await A.chrome.press('#omnibar-input', 'Enter');
    await sleep(2500);
    const planShown = !(await A.chrome.$eval('#plan-preview-modal', e => e.classList.contains('hidden')));
    obs(`Plain sentence "open example.com and tell me the page heading": plan preview shown=${planShown}; page urls after: ${JSON.stringify(nativePages(A).map(p => p.url().slice(0, 80)))}`);
    check('plain-language sentence from the issue is routed as a mission', planShown, planShown ? '' : 'it was treated as a web search and navigated the page');
    if (planShown) await A.chrome.click('#cancel-plan-btn');
    const r = await startViaUi(A, '/do open example.com and tell me the page heading');
    check('plan preview modal appears for /do', r.planModal);
    obs(`plan preview: ${JSON.stringify(r.plan)}`);
    shots(osShot(A, 'os_04a_plan_preview').file);
    await sleep(2500);
    const items = await timelineItems(A);
    obs(`timeline after Execute: ${JSON.stringify(items)}`);
    const settingsOpened = !(await A.chrome.$eval('#settings-modal', e => e.classList.contains('hidden')));
    check('timeline shows a clear key-not-configured notice', items.some(t => /key is not configured|configure/i.test(t)), items[0] || '');
    check('Settings dialog opened to let the user fix it', settingsOpened);
    shots(osShot(A, 'os_04b_no_key_error').file);
    const alive = await ipc(A, 'listMissions', 5);
    check('main process still alive and answering IPC', alive && alive.ok, JSON.stringify(alive).slice(0, 80));
    check('no mission row created for the refused start', (alive.data || []).length === 0, `missions=${(alive.data || []).length}`);
    const appCrash = A.log.split('\n').filter(l => /Unhandled error|render-process-gone|child-process-gone|FATAL/.test(l)).length;
    const pageErrs = A.log.split('\n').filter(l => /CONSOLE.*Uncaught/.test(l)).length;
    obs(`electron.log: app-level crash/unhandled markers=${appCrash}; "Uncaught" console errors raised by web pages (e.g. Google's own captcha page) = ${pageErrs}`);
    await A.chrome.click('#cancel-settings-btn');
    // demoMode was removed in #224: there is no silent mock path to observe any more.
    await A.chrome.click('#cancel-plan-btn').catch(() => {});
  });

// ------------------------------------------------------------------ 3b credential storage
await scenario('3b', 'Saved API key: how is it stored and what leaves the main process?',
  'Key is encrypted at rest (vault.enc), not in the database, logs or readable files; not echoed back to the renderer in clear text.',
  async ({ obs }) => {
    await A.chrome.click('#settings-btn');
    await A.chrome.waitForSelector('#settings-modal:not(.hidden)');
    await A.chrome.fill('#settings-gemini-key', FAKE_KEY);
    await A.chrome.click('#save-settings-btn');
    await A.chrome.waitForSelector('#settings-modal.hidden', { state: 'attached', timeout: 5000 });
    await sleep(1200);
    const vault = path.join(A.profile, 'vault.enc');
    check('vault.enc written', fs.existsSync(vault));
    const vaultTxt = fs.existsSync(vault) ? fs.readFileSync(vault, 'utf8') : '';
    obs(`vault.enc: ${vaultTxt.replace(/"([A-Za-z0-9+/=]{12})[A-Za-z0-9+/=]+"/g, '"$1…"').replace(/\s+/g, ' ').slice(0, 160)}`);
    check('plaintext key NOT in vault.enc', !vaultTxt.includes(FAKE_KEY));
    const hits = scanProfile(A.profile, FAKE_KEY);
    check('plaintext key not found in any profile file (db, wal, logs, vault)', hits.length === 0, hits.join(', '));
    check('plaintext key not in electron.log', !A.log.includes(FAKE_KEY));
    obs(`vault log line: ${(A.log.match(/\[credential-vault\][^\n]*/g) || []).join(' | ')}`);
    const got = await ipc(A, 'getSettings');
    const echoed = got.data.apiKeys?.gemini === FAKE_KEY;
    obs(`window.aegis.getSettings() returns the decrypted key to the renderer: ${echoed}`);
    check('decrypted key is NOT returned to the renderer by getSettings', !echoed, 'renderer (and any code injected there) can read the key');
    await A.chrome.click('#settings-btn');
    await A.chrome.waitForSelector('#settings-modal:not(.hidden)');
    const inputVal = await A.chrome.inputValue('#settings-gemini-key');
    obs(`reopened Settings pre-fills the key input with the real key (type=password): ${inputVal === FAKE_KEY}`);
    await A.chrome.fill('#settings-gemini-key', '');
    await A.chrome.click('#save-settings-btn');
    await sleep(1500);
    const after = fs.existsSync(vault) ? fs.readFileSync(vault, 'utf8') : '{}';
    check('clearing the key removes it from the vault', !/"gemini"/.test(after), after.replace(/\s+/g, ' ').slice(0, 80));
    obs(`.aegis-user-data or other writes inside the repo during the run are checked at the end (see repoWrites in report).`);
  });

// ------------------------------------------------------------------ 5 mission with a model (stub, no real key)
await scenario(5, 'Run a mission "open <page> and tell me the heading"; observe step feed, cost counters, tab behaviour, result',
  'With a REAL model this needs a key (none available). Here: Ollama provider pointed at a scripted local stub; checks the loop wiring only.',
  async ({ obs, shots }) => {
    obs('MODEL IS A SCRIPTED LOCAL STUB, NOT A REAL MODEL. No API key and no Ollama install exist in this environment.');
    // configure through the UI exactly as a user would, Ollama URL as the form pre-fills it (no /v1)
    await A.chrome.click('#settings-btn');
    await A.chrome.waitForSelector('#settings-modal:not(.hidden)');
    await A.chrome.selectOption('#settings-provider', 'ollama');
    const defaultUrl = await A.chrome.inputValue('#settings-ollama-url');
    obs(`Ollama URL pre-filled by the form: ${defaultUrl}`);
    await A.chrome.fill('#settings-ollama-url', `http://127.0.0.1:${stub.port}`);
    await A.chrome.click('#test-ollama-btn');
    const tmsg = await waitUntil(async () => { const t = await A.chrome.textContent('#settings-status-msg'); return t && !/^Testing/.test(t) ? t : null; }, 10000);
    check('Test Connection works against /api/tags', tmsg && tmsg.startsWith('✓'), tmsg);
    await A.chrome.click('#save-settings-btn');
    await sleep(1200);
    await A.chrome.waitForSelector('#settings-modal.hidden', { state: 'attached', timeout: 4000 });
    // Attempt 1: leave the model dropdown on its default (gemini-2.0-flash) and base URL without /v1
    const model1 = await A.chrome.inputValue('#model-select');
    stub.requests.length = 0;
    await startViaUi(A, `/do go to ${fixtureUrl} and tell me the page heading`);
    await sleep(6000);
    const m1 = (await missionStates(A))[0]; const attempt1Id = m1?.id;
    obs(`attempt 1 (dropdown=${model1}, URL without /v1): mission state=${m1?.state}; error=${JSON.stringify(m1?.error)}; stub saw: ${JSON.stringify(stub.requests.map(r => ({ path: r.path, model: r.model, wrongPath: r.wrongPath })))}`);
    extra.attempt1 = { state: m1?.state, error: m1?.error, stub: stub.requests.map(r => ({ path: r.path, model: r.model })) };
    check('default Ollama URL (no /v1) + default model dropdown can run a mission against an Ollama-shaped server', m1?.state === 'completed', `state=${m1?.state}; ${m1?.error || ''}`);
    // Attempt 2: fix both by hand (URL /v1, pick the local model). The scripted model's first action is navigate.
    await A.chrome.click('#settings-btn');
    await A.chrome.waitForSelector('#settings-modal:not(.hidden)');
    await A.chrome.fill('#settings-ollama-url', `http://127.0.0.1:${stub.port}/v1`);
    await A.chrome.click('#save-settings-btn');
    await sleep(1200);
    await A.chrome.selectOption('#model-select', 'deepseek-r1:8b');
    stub.requests.length = 0;
    await A.chrome.evaluate(() => { window.__sawCursor = false; new MutationObserver(() => { if (document.querySelector('.__presence_cursor__')) window.__sawCursor = true; }).observe(document.getElementById('presence-overlay'), { childList: true, subtree: true }); });
    const known = new Set((await missionStates(A)).map(m => m.id));
    await startViaUi(A, `/do NAVFIRST go to ${fixtureUrl} and tell me the page heading`);
    await sleep(9000);
    const m2 = (await missionStates(A)).find(m => !known.has(m.id));
    const feed2 = (await timelineItems(A)).slice(0, 6).reverse();
    const approvalButtons = await A.chrome.$$eval('button', els => els.map(e => e.textContent.trim()).filter(t => /approve|allow|deny|confirm/i.test(t)));
    obs(`attempt 2 (agent navigates to a different origin than the current page): mission state=${m2?.state}; newest feed items: ${JSON.stringify(feed2)}`);
    obs(`buttons in the UI that could answer an approval request: ${JSON.stringify(approvalButtons)}`);
    extra.attempt2 = { state: m2?.state, feed: feed2, approvalButtons };
    check('agent can navigate to a new site as its first step without a dead-end', m2?.state === 'running' || m2?.state === 'completed', `state=${m2?.state}; pauses awaiting an approval that has no UI`);
    shots(osShot(A, 'os_05a_navigate_needs_approval').file);
    known.add(m2?.id);
    await A.chrome.click('#cancel-mission-btn'); await sleep(1500);
    obs(`after pressing Cancel on the stuck mission: state=${(await missionStates(A)).find(m => m.id === m2?.id)?.state}`);
    // Attempt 3: put the browser on the fixture page first, then the scripted model clicks the button and finishes.
    await A.chrome.fill('#omnibar-input', fixtureUrl);
    await A.chrome.press('#omnibar-input', 'Enter');
    await waitUntil(async () => (await tabTitles(A)).some(t => t.active && t.title === 'Baseline Fixture Page'), 10000);
    stub.requests.length = 0;
    await startViaUi(A, `/do click the button on this page and tell me its heading`);
    const feedSamples = [];
    const t0 = Date.now();
    let mission;
    while (Date.now() - t0 < 60000) {
      mission = (await missionStates(A)).find(m => !known.has(m.id));
      feedSamples.push({ t: Date.now() - t0, tokens: await A.chrome.textContent('#tokens-stat'), cost: await A.chrome.textContent('#cost-stat'), workers: await A.chrome.textContent('#worker-count-stat') });
      if (mission && ['completed', 'failed', 'cancelled'].includes(mission.state)) break;
      await sleep(700);
    }
    await sleep(800);
    const feed = (await timelineItems(A)).reverse();
    obs(`attempt 3 (page pre-opened, model clicks then finishes): mission state=${mission?.state}; steps=${mission?.stepCount}; error=${JSON.stringify(mission?.error)}; result=${JSON.stringify(mission?.result)}`);
    obs(`step feed, newest 14 of ${feed.length}: ${JSON.stringify(feed.slice(-14))}`);
    const counters = { tokens: await A.chrome.textContent('#tokens-stat'), cost: await A.chrome.textContent('#cost-stat'), workers: await A.chrome.textContent('#worker-count-stat') };
    obs(`counters at end: ${JSON.stringify(counters)} (token counts are the stub's fabricated usage figures; cost is $0 because the Ollama/deepseek model has no price entry)`);
    obs(`tab behaviour: tab strip=${JSON.stringify(await tabTitles(A))}; native pages=${JSON.stringify(nativePages(A).map(p => p.url().slice(0, 50)))}`);
    obs(`stub requests: ${JSON.stringify(stub.requests.map(r => ({ path: r.path, model: r.model, msgs: r.messageCount, tools: r.tools })))}`);
    const clickedOnPage = await nativePages(A).find(p => p.url().startsWith(fixtureUrl))?.textContent('#o').catch(() => null);
    obs(`fixture page #o text after the agent's click (proves a real click reached the page): ${JSON.stringify(clickedOnPage)}`);
    check('mission reaches a terminal state', mission && ['completed', 'failed', 'cancelled'].includes(mission.state), mission?.state);
    check('mission completed', mission?.state === 'completed', `${mission?.state} ${mission?.error || ''}`);
    check('agent click really reached the page', /clicked/.test(clickedOnPage || ''), clickedOnPage);
    check('step feed shows the actions taken', feed.some(t => /\[Action\] click/.test(t)) && feed.some(t => /\[Action\] done/.test(t)));
    check('token counter moved (stub-supplied usage)', !/^0$/.test(counters.tokens), counters.tokens);
    check('cost counter moved', !/^\$0\.0000$/.test(counters.cost), `${counters.cost} (no price table entry for local models)`);
    extra.feedSamples = feedSamples.slice(-4);
    extra.attempt3 = { state: mission?.state, result: mission?.result, steps: mission?.stepCount, counters };
    shots(osShot(A, 'os_05b_mission_finished').file);
    extra.sawCursorDuringMission = await A.chrome.evaluate(() => window.__sawCursor);
    // let the fixture tab stay for later scenarios
  });

// ------------------------------------------------------------------ 9 cursor / presence (uses state from 5)
function pngDiff(fileA, fileB, region) {
  const r = spawnSync('powershell', ['-NoProfile', '-File', path.join(root, 'scripts', 'dev', 'png_diff.ps1'), '-PathA', path.join(OUT, fileA), '-PathB', path.join(OUT, fileB), '-Region', region.join(',')], { encoding: 'utf8' });
  const m = (r.stdout || '').match(/changed=(\d+) total=(\d+)/);
  return m ? { changed: Number(m[1]), total: Number(m[2]) } : { error: (r.stderr || r.stdout).slice(0, 200) };
}
await scenario(9, 'Agent cursor: is it visible over the page content?',
  'A cursor/ripple for agent actions is visible above the page in the real window.',
  async ({ obs, shots }) => {
    obs(`during the stub-driven mission (scenario 5) a .__presence_cursor__ element appeared in the chrome DOM: ${extra.sawCursorDuringMission}`);
    if (extra.sawCursorDuringMission !== undefined) check('a running agent produces a cursor element at all', extra.sawCursorDuringMission === true);
    const grep = spawnSync('git', ['grep', '-n', 'broadcastPresence', '--', 'src'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    obs(`git grep broadcastPresence src: ${grep.replace(/\n/g, ' | ')} (definition only, no caller)`);
    // Pixel experiment on a static page so only the probe can change pixels.
    await A.chrome.click('#layout-stage-btn'); await sleep(500);
    await ipc(A, 'navigateTab', 'data:text/html,<body style="background:%23ffffff"><h1>static probe page</h1></body>');
    await sleep(1500);
    const dpr = await A.chrome.evaluate(() => devicePixelRatio);
    const region = await A.chrome.evaluate(() => { const ov = document.getElementById('presence-overlay').getBoundingClientRect(); return [ov.x + 240, ov.y + 170, 160, 70]; });
    const phys = region.map(v => Math.round(v * dpr));
    const control = async (n, layoutBtn) => {
      await A.chrome.click(layoutBtn); await sleep(1500);
      osShot(A, 'tmp_' + n + '_pre1'); const pre2 = osShot(A, 'tmp_' + n + '_pre2');
      const noise = pngDiff('tmp_' + n + '_pre1.png', 'tmp_' + n + '_pre2.png', phys);
      await A.chrome.evaluate(([x, y]) => {
        const ov = document.getElementById('presence-overlay');
        const c = document.createElement('div'); c.className = '__presence_cursor__'; c.id = '__probe_cursor';
        const chip = document.createElement('span'); chip.className = 'cursor-chip'; chip.textContent = 'PROBE';
        c.appendChild(chip); c.style.transform = 'translate(250px, 180px)'; ov.appendChild(c);
        const red = document.createElement('div'); red.id = '__probe_red';
        red.style.cssText = 'position:fixed;z-index:2147483647;background:#f00;width:60px;height:30px;left:' + (x + 90) + 'px;top:' + (y + 20) + 'px';
        document.body.appendChild(red);
        const top = document.createElement('div'); top.id = '__probe_red_top';
        top.style.cssText = 'position:fixed;z-index:2147483647;background:#f00;width:60px;height:24px;left:600px;top:6px';
        document.body.appendChild(top);
      }, region);
      await sleep(500);
      shots(await cdpShot(A, 'cdp_09_' + n + '_probe_in_chrome_dom'));
      const post = osShot(A, 'os_09_' + n + '_probe'); shots(post.file);
      const curDiff = pngDiff('tmp_' + n + '_pre2.png', 'os_09_' + n + '_probe.png', [phys[0], phys[1], Math.round(85 * dpr), phys[3]]);
      const redDiff = pngDiff('tmp_' + n + '_pre2.png', 'os_09_' + n + '_probe.png', [Math.round((region[0] + 90) * dpr), Math.round((region[1] + 20) * dpr), Math.round(60 * dpr), Math.round(30 * dpr)]);
      const topDiff = pngDiff('tmp_' + n + '_pre2.png', 'os_09_' + n + '_probe.png', [Math.round(600 * dpr), Math.round(6 * dpr), Math.round(60 * dpr), Math.round(24 * dpr)]);
      const nat = (await nativeSize(A)).map(s => [s.w, s.h]);
      await A.chrome.evaluate(() => { for (const id of ['__probe_cursor', '__probe_red', '__probe_red_top']) document.getElementById(id)?.remove(); });
      for (const t of ['pre1', 'pre2']) fs.rmSync(path.join(OUT, 'tmp_' + n + '_' + t + '.png'), { force: true });
      obs(`[${n}] probe region (css px x,y,w,h)=${JSON.stringify(region.map(Math.round))}; Win32 child sizes (stale in Grid)=${JSON.stringify(nat)}; pixels changed between two identical captures (noise)=${JSON.stringify(noise)}; cursor-markup region diff=${JSON.stringify(curDiff)}; 60x30 red chrome-DOM div over the page area diff=${JSON.stringify(redDiff)}; the same kind of red div in the titlebar, where no native view exists (control) diff=${JSON.stringify(topDiff)}`);
      return { noise, curDiff, redDiff, topDiff, nat };
    };
    const stage = await control('stage', '#layout-stage-btn');
    const grid = await control('grid', '#layout-grid-btn');
    await A.chrome.click('#layout-stage-btn'); await sleep(500);
    extra.presenceProbe = { stage, grid };
    check('control: the pixel diff detects a chrome-DOM element where no native view covers it (red div in the titlebar)', (stage.topDiff.changed || 0) > 200 && (stage.noise.changed || 0) < 20, JSON.stringify({ red: stage.topDiff, noise: stage.noise }));
    check('agent cursor markup in #presence-overlay is visible over the page in Stage layout', (stage.curDiff.changed || 0) > 100, JSON.stringify(stage.curDiff));
    check('any chrome-DOM element (red div, z-index max) is visible over the page in Stage layout', (stage.redDiff.changed || 0) > 200, JSON.stringify(stage.redDiff));
    check('agent cursor markup is visible over the page in Grid layout', (grid.curDiff.changed || 0) > 100, JSON.stringify(grid.curDiff));
  });


// ------------------------------------------------------------------ 6 swarm
await scenario(6, '"/swarm compare prices of laptops across stores": what do the workers actually do?',
  'Workers research several stores in parallel and report cited facts. (Provider is the local stub; the swarm path makes no model call at all.)',
  async ({ obs, shots }) => {
    const tabsBefore = nativePages(A).length;
    const known = new Set((await missionStates(A)).map(m => m.id));
    const r = await startViaUi(A, '/swarm compare prices of laptops across stores', { execute: false });
    obs(`plan preview (static template?): ${JSON.stringify(r.plan)}`);
    shots(osShot(A, 'os_06a_swarm_plan_preview').file);
    stub.requests.length = 0;
    await A.chrome.click('#execute-plan-btn');
    const timeline = [];
    const t0 = Date.now();
    let mission; let midShot = false;
    while (Date.now() - t0 < 90000) {
      mission = (await missionStates(A)).find(m => !known.has(m.id) && m.prompt?.includes('laptops'));
      const workers = await A.chrome.$$eval('#worker-cards-container .worker-card', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
      timeline.push({ t: Date.now() - t0, state: mission?.state, tabs: (await tabTitles(A)).map(t => `${t.badge}:${t.title}`), nativeUrls: nativePages(A).map(p => p.url().slice(0, 40)), workers });
      if (!midShot && workers.length > 0) { midShot = true; shots(osShot(A, 'os_06b_swarm_running').file); }
      if (mission && ['completed', 'failed', 'cancelled'].includes(mission.state)) break;
      await sleep(150);
    }
    await sleep(1000);
    const feed = (await timelineItems(A)).reverse();
    obs(`swarm mission state=${mission?.state} after ${((Date.now() - t0) / 1000).toFixed(1)}s; error=${JSON.stringify(mission?.error)}`);
    obs(`evidence feed (${feed.length}): ${JSON.stringify(feed.slice(0, 40))}`);
    obs(`peak concurrent native tabs: ${Math.max(...timeline.map(x => x.nativeUrls.length))} (before: ${tabsBefore}); sample: ${JSON.stringify(timeline.filter((_, i) => i % 6 === 0).slice(0, 6))}`);
    obs(`model-stub requests made by the swarm: ${stub.requests.length}`);
    const rep = path.join(A.profile, 'deliverables', `${mission?.id}_report.md`);
    const report = fs.existsSync(rep) ? fs.readFileSync(rep, 'utf8') : null;
    obs(`deliverable report on disk: ${report ? JSON.stringify(report.slice(0, 1200)) : 'none'}`);
    extra.swarm = { state: mission?.state, evidenceItems: feed.length, stubRequests: stub.requests.length, report };
    check('swarm mission reached a terminal state', mission && ['completed', 'failed', 'cancelled'].includes(mission.state), mission?.state);
    await sleep(3000);
    check('worker views are torn down when the mission ends', nativePages(A).length === tabsBefore, `${tabsBefore} page targets before the mission, ${nativePages(A).length} three seconds after it finished; tab strip shows ${(await tabTitles(A)).length}`);
    check('workers made at least one model call (model-driven work)', stub.requests.length > 0, `${stub.requests.length} model requests`);
    check('workers visited more than one distinct site', new Set(timeline.flatMap(x => x.nativeUrls.map(u => u.replace(/^(https?:\/\/[^/]+).*$/, '$1')))).size > 2, JSON.stringify([...new Set(timeline.flatMap(x => x.nativeUrls.map(u => u.replace(/^(https?:\/\/[^/]+).*$/, '$1'))))]));
    shots(osShot(A, 'os_06c_swarm_finished').file);
  });

// ------------------------------------------------------------------ 7 controls
await scenario(7, 'Pause, Takeover, Hand-back, Cancel, Undo, Steer: visible vs actual effect',
  'Each button changes the real mission state and the agent loop stops/continues accordingly; the UI label matches reality.',
  async ({ obs, shots }) => {
    await A.chrome.click('#layout-stage-btn'); await sleep(500);
    obs('Mission under test is driven by the scripted local stub (3 s per call, answers "wait" forever).');
    const lblPause = () => A.chrome.textContent('#pause-agent-btn'); const lblTake = () => A.chrome.textContent('#takeover-btn');
    // a. no mission running
    await A.chrome.click('#pause-agent-btn');
    const idleLabel = await lblPause();
    obs(`Pause clicked with NO mission running: button label becomes ${JSON.stringify(idleLabel)}`);
    check('Pause with no mission leaves the UI honest (label stays "Pause")', idleLabel === 'Pause', idleLabel);
    await A.chrome.click('#pause-agent-btn'); // restore UI toggle
    // b. start slow mission
    stub.requests.length = 0; stub.inflightClosed = 0;
    await startViaUi(A, `/do SLOWMODE keep waiting on ${fixtureUrl}`);
    const running = await waitUntil(() => stub.requests.length >= 2, 20000, 300);
    check('slow mission is running (>=2 model calls)', running, `${stub.requests.length} calls`);
    const mission = () => missionStates(A).then(l => l.find(m => m.prompt?.includes('SLOWMODE')));
    const mid = (await mission()); obs(`mission id=${mid?.id} state=${mid?.state}`);
    const count = () => stub.requests.filter(r => !r.wrongPath).length;
    // c. Pause
    await A.chrome.click('#pause-agent-btn');
    await sleep(1500);
    const c0 = count(); await sleep(8000); const c1 = count();
    const stPaused = (await mission())?.state;
    obs(`after Pause: label=${await lblPause()}, mission state=${stPaused}, model calls during 8 s pause window: ${c1 - c0}`);
    check('Pause: mission state becomes paused', stPaused === 'paused', stPaused);
    check('Pause: agent stops calling the model', c1 - c0 === 0, `${c1 - c0} calls while paused`);
    shots(osShot(A, 'os_07a_paused').file);
    // d. Resume
    await A.chrome.click('#pause-agent-btn');
    await sleep(500); const r0 = count(); await sleep(7000);
    const stResumed = (await mission())?.state; const r1 = count();
    obs(`after Resume: label=${await lblPause()}, state=${stResumed}, model calls in 7 s: ${r1 - r0}`);
    check('Resume: mission running again and calling the model', stResumed === 'running' && r1 - r0 > 0, `${stResumed}, ${r1 - r0} calls`);
    // e. Takeover
    await A.chrome.click('#takeover-btn');
    await sleep(1500);
    const stTake = (await mission())?.state;
    const feedTake = (await timelineItems(A)).slice(0, 4);
    obs(`after Takeover: takeover label=${await lblTake()}, pause label=${await lblPause()}, state=${stTake}; newest feed items: ${JSON.stringify(feedTake)}`);
    check('Takeover: mission state becomes paused', stTake === 'paused', stTake);
    check('Takeover: Pause button label reflects paused state ("Resume")', (await lblPause()) === 'Resume', await lblPause());
    // f. Hand back
    await A.chrome.click('#takeover-btn');
    await sleep(2500); const h0 = count(); await sleep(7000); const h1 = count();
    const stBack = (await mission())?.state;
    obs(`after Hand Back: label=${await lblTake()}, state=${stBack}, model calls in 7 s: ${h1 - h0}`);
    check('Hand back: mission running again', stBack === 'running' && h1 - h0 > 0, `${stBack}, ${h1 - h0} calls`);
    // g. Steer
    await A.chrome.fill('#steering-input', 'prioritise the second page');
    await A.chrome.click('#steering-send-btn');
    await sleep(8000);
    const steerSeen = stub.requests.some(r => r.lastUserHasSteer);
    obs(`steering message reached the model request: ${steerSeen}`);
    check('Steer: instruction appears in a later model request', steerSeen);
    // h. Undo
    await A.chrome.click('#undo-btn');
    await sleep(1500);
    const undoText = (await timelineItems(A)).find(t => t.startsWith('[Undo]'));
    obs(`Undo feed message: ${JSON.stringify(undoText)}`);
    extra.undoMessage = undoText;
    // i. Cancel
    const preCancel = count();
    await A.chrome.click('#cancel-mission-btn');
    await sleep(500);
    const stCancel = (await mission())?.state;
    await sleep(7000);
    const postCancel = count();
    obs(`after Cancel: state=${stCancel}; model calls in the 7 s after cancel: ${postCancel - preCancel}; in-flight HTTP requests aborted by the app: ${stub.inflightClosed}`);
    check('Cancel: mission state becomes cancelled', stCancel === 'cancelled', stCancel);
    check('Cancel: agent really stops (no further model calls)', postCancel - preCancel <= 1, `${postCancel - preCancel}`);
    shots(osShot(A, 'os_07b_cancelled').file);
    // j. Cancel during a swarm
    const knownSw = new Set((await missionStates(A)).map(m => m.id));
    await startViaUi(A, '/swarm compare prices of laptops across stores');
    await sleep(150);
    const swEv0 = (await timelineItems(A)).length;
    await A.chrome.click('#cancel-mission-btn');
    await sleep(1000);
    const swState = (await missionStates(A)).find(m => !knownSw.has(m.id))?.state;
    const evAtCancel = (await timelineItems(A)).length;
    const tabsAtCancel = nativePages(A).length;
    await sleep(15000);
    const evLater = (await timelineItems(A)).length;
    const tabsLater = nativePages(A).length;
    const finalSw = (await missionStates(A)).find(m => !knownSw.has(m.id));
    obs(`swarm cancel: state right after=${swState}; feed items at cancel=${evAtCancel}, 15 s later=${evLater}; native tabs at cancel=${tabsAtCancel}, later=${tabsLater}; final persisted state=${finalSw?.state}`);
    check('Cancel on a swarm stops swarm activity (no new feed items afterwards)', evLater === evAtCancel, `${evLater - evAtCancel} new items after cancel`);
    extra.swarmCancel = { evAtCancel, evLater, tabsAtCancel, tabsLater, finalState: finalSw?.state };
    shots(osShot(A, 'os_07c_swarm_cancel_after').file);
  });

// ------------------------------------------------------------------ 8 grid
await scenario(8, 'Swarm Grid: are tiles live or static? frame rate? CPU with 3 tabs open',
  'Tiles update continuously (a live stream), cheaply.',
  async ({ obs, shots }) => {
    // Normalise: back to stage, three tabs: ticker, example.com, second fixture
    await A.chrome.click('#layout-stage-btn');
    for (const pg of nativePages(A)) { /* leave */ }
    const tabsNow = await tabTitles(A);
    obs(`tabs at start of scenario: ${JSON.stringify(tabsNow)}`);
    const need = Math.max(0, 3 - tabsNow.length);
    for (let i = 0; i < need; i++) await ipc(A, 'createTab', i === 0 ? tickerUrl : 'https://example.com');
    const act = await A.chrome.$$eval('#tabs-container .tab', els => els.map(e => e.dataset.tabId));
    await ipc(A, 'navigateTab', tickerUrl);
    await sleep(3500);
    const stageCpu = await cpuPercent(A.child.pid, 10000);
    obs(`CPU (all Electron processes), Stage layout, ${(await tabTitles(A)).length} tabs, animated fixture visible, 10 s: ${JSON.stringify(stageCpu)}`);
    await A.chrome.click('#layout-grid-btn');
    await sleep(1500);
    const cards = await A.chrome.$$eval('.swarm-grid-card', els => els.map(e => ({ thumb: e.querySelector('img.swarm-card-thumb') ? 'img' : e.querySelector('.swarm-card-thumb')?.textContent, title: e.querySelector('.swarm-card-title')?.textContent })));
    obs(`grid cards: ${JSON.stringify(cards)}`);
    shots(osShot(A, 'os_08a_grid').file);
    const samples = [];
    const cpuP = cpuPercent(A.child.pid, 10000);
    for (let i = 0; i < 10; i++) {
      const hashes = await A.chrome.$$eval('img.swarm-card-thumb', els => els.map(e => e.src.length + ':' + e.src.slice(-40)));
      samples.push(hashes.map(sha)); await sleep(1000);
    }
    const gridCpu = await cpuP;
    const distinctPerCard = samples[0].map((_, ci) => new Set(samples.map(s => s[ci])).size);
    obs(`10 s of 1 Hz DOM samples of tile images: distinct images per tile = ${JSON.stringify(distinctPerCard)}; tiles with an image=${samples[0].length}/${cards.length}`);
    obs(`CPU in Grid layout, 10 s: ${JSON.stringify(gridCpu)}`);
    obs(`Grid container text: ${JSON.stringify(await A.chrome.evaluate(() => document.querySelector('.swarm-grid-container, #swarm-grid-container, [id*=grid]')?.textContent?.slice(0, 120) ?? null))}`);
    // explicit refresh to see what a thumbnail can contain
    const previewCall = () => A.chrome.evaluate(async () => { const t0 = performance.now(); const r = await Promise.race([window.aegis.getSwarmPreviews(), new Promise(res => setTimeout(() => res('TIMEOUT'), 8000))]); if (r === 'TIMEOUT') return { timedOut: true, ms: 8000 }; const items = r.data || r; return { ms: Math.round(performance.now() - t0), items: items.map(i => ({ title: i.title, hasThumb: !!i.thumbnailBase64, len: (i.thumbnailBase64 || '').length, active: i.isActive })) }; });
    const direct = await previewCall();
    obs(`direct getSwarmPreviews() with ${(await tabTitles(A)).length} tabs open: ${JSON.stringify(direct)}`);
    extra.grid = { stageCpu, gridCpu, distinctPerCard, cards: cards.length, direct };
    check('getSwarmPreviews() returns (does not hang) with several tabs open', !direct.timedOut, JSON.stringify(direct));
    // control: is the hang caused by background tabs? Close all tabs but the active one and call again.
    await A.chrome.click('#layout-stage-btn'); await sleep(500);
    const ids = await A.chrome.$$eval('#tabs-container .tab', els => els.map(e => ({ id: e.dataset.tabId, active: e.classList.contains('active') })));
    for (const t of ids.filter(t => !t.active)) await ipc(A, 'closeTab', t.id);
    await sleep(800);
    const single = await previewCall();
    obs(`control: getSwarmPreviews() with exactly one (active) tab: ${JSON.stringify(single)}`);
    extra.grid.singleTab = single;
    check('control: with a single active tab getSwarmPreviews() returns a thumbnail', !single.timedOut && single.items?.[0]?.hasThumb === true, JSON.stringify(single));
    for (let i = 0; i < 2; i++) await ipc(A, 'createTab', i === 0 ? tickerUrl : 'https://example.com'); await sleep(1500);
    check('every tile shows a thumbnail image', samples[0].length === cards.length && cards.length > 0, `${samples[0].length}/${cards.length}`);
    check('tile of the animated page changes over 10 s (live)', Math.max(0, ...distinctPerCard) > 3, JSON.stringify(distinctPerCard));
    check('Grid costs no more CPU than Stage', gridCpu.percentOfOneCore <= stageCpu.percentOfOneCore, `${gridCpu.percentOfOneCore}% vs ${stageCpu.percentOfOneCore}%`);
    // card click returns to stage
    if (cards.length) { await A.chrome.click('.swarm-grid-card'); await sleep(1000); const sz = await nativeSize(A); obs(`after clicking a tile: layout button active=${await A.chrome.$eval('#layout-stage-btn', e => e.classList.contains('active'))}, native sizes=${JSON.stringify(sz.map(s => [s.w, s.h]))}`); }
  });

// ------------------------------------------------------------------ 10 layouts, resize, scaling
await scenario(10, 'Layout buttons Stage/Grid/Theatre; window resize; minimum size; 125%/150% scaling',
  'Native page view and chrome stay aligned in every layout/size; no clipped controls; scaling works.',
  async ({ obs, shots }) => {
    const measure = async label => {
      const cd = await A.chrome.evaluate(() => ({ w: innerWidth, h: innerHeight, scrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth, dpr: devicePixelRatio, drawer: Math.round(document.getElementById('swarm-drawer').getBoundingClientRect().width), vp: (r => [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)])(document.getElementById('webview-viewport').getBoundingClientRect()) }));
      const ns = (await nativeSize(A)).filter(s => s.w > 0 || s.h >= 0);
      const m = { label, chrome: [cd.w, cd.h], dpr: cd.dpr, horizontalScroll: cd.scrollX, drawer: cd.drawer, domViewport: cd.vp, nativeViews: ns.map(s => [s.w, s.h]) };
      obs(JSON.stringify(m));
      return m;
    };
    const ms = [];
    await A.chrome.click('#layout-stage-btn'); await sleep(800); ms.push(await measure('stage')); shots(osShot(A, 'os_10a_stage').file);
    await A.chrome.click('#layout-theatre-btn'); await sleep(800); ms.push(await measure('theatre')); shots(osShot(A, 'os_10b_theatre').file);
    await A.chrome.click('#layout-grid-btn'); await sleep(1200); ms.push(await measure('grid')); shots(osShot(A, 'os_10c_grid').file);
    await A.chrome.click('#layout-stage-btn'); await sleep(800);
    const mapped = (m, dom) => m.nativeViews.some(v => Math.abs(v[0] - dom[2]) <= 6 && Math.abs(v[1] - dom[3]) <= 6);
    check('Stage: native view fills the DOM viewport area', mapped(ms[0], ms[0].domViewport), `native=${JSON.stringify(ms[0].nativeViews)} dom=${JSON.stringify(ms[0].domViewport)}`);
    check('Theatre: layout differs from Stage and stays inside the viewport', JSON.stringify(ms[1].nativeViews) !== JSON.stringify(ms[0].nativeViews), JSON.stringify(ms[1].nativeViews));
    // resize
    const sizes = [['1000x700', 'resize 1000x700'], ['800x600', 'resize 800x600 (declared minimum)'], ['600x400', 'resize 600x400 (below minimum)']];
    for (const [sz, label] of sizes) {
      const r = setWindowSize(A, sz); await sleep(1200);
      const m = await measure(`${label} -> ${r}`); ms.push(m); shots(osShot(A, `os_10d_${sz}`).file);
    }
    const minBelow = ms[ms.length - 1];
    check('window cannot be resized below the declared minimum 800x600 (chrome width >= 800)', minBelow.chrome[0] >= 800, JSON.stringify(minBelow.chrome));
    for (const m of ms.slice(3)) check(`no horizontal scroll / clipped chrome at ${m.label.split(' ->')[0]}`, !m.horizontalScroll);
    // maximize/restore via the DOM button
    await A.chrome.click('#max-btn'); await sleep(1200); ms.push(await measure('after #max-btn')); shots(osShot(A, 'os_10e_maximised').file);
    await A.chrome.click('#max-btn'); await sleep(1200);
    setWindowSize(A, '1400x816'); await sleep(800);
    extra.layoutMeasures = ms;
  });

// ------------------------------------------------------------------ edge cases
await scenario('E', 'Edge cases: two instances, where user data really goes, CDP port in use',
  'Second instance exits via the single-instance lock; AEGIS_USER_DATA keeps all data out of the default location; a busy CDP port is detected.',
  async ({ obs }) => {
    const runSecond = (aegisProfile, chromiumDir, ms = 12000) => new Promise(resolve => {
      const e2 = { ...process.env, AEGIS_USER_DATA: aegisProfile }; delete e2.ELECTRON_RUN_AS_NODE;
      const c = spawn(electronExe, [`--user-data-dir=${chromiumDir}`, path.join(root, 'dist', 'main', 'index.js')], { env: e2, stdio: 'ignore', cwd: root });
      const t = setTimeout(() => { spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F']); resolve('still-running-after-' + ms + 'ms'); }, ms);
      c.on('exit', code => { clearTimeout(t); resolve('exited:' + code); });
    });
    const same = await runSecond(A.profile, path.join(A.profile, 'chromium'));
    obs(`second instance, same Chromium profile dir: ${same}`);
    check('second instance on the same profile exits (single-instance lock)', same.startsWith('exited'), same);
    const otherProf = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-baseline-other-'));
    const other = await runSecond(otherProf, path.join(otherProf, 'chromium'));
    obs(`second instance with a different AEGIS_USER_DATA and a different --user-data-dir: ${other}`);
    extra.secondInstanceDifferentProfile = other;
    check('first instance still answers IPC after the second launches', (await ipc(A, 'listMissions', 1)).ok);
    obs(`CDP port notes from this run: ${JSON.stringify(portNotes)}`);
    const probe9222 = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { (Get-Process -Id $_.OwningProcess).ProcessName }) -join \',\''], { encoding: 'utf8' }).stdout.trim();
    obs(`listener on 9222 at run time: ${probe9222 || 'none'}`);
    extra.port9222Listener = probe9222;
    // Does AEGIS_USER_DATA keep ALL state out of the default %APPDATA%\autonomous-browser? Launch WITHOUT --user-data-dir.
    const defaultDir = path.join(process.env.APPDATA, 'autonomous-browser');
    const t0 = Date.now() - 1000;
    const p3 = await pickPort();
    const C = await launchApp('noisolate', { cdpPort: p3.port, isolateChromium: false });
    await sleep(4000);
    await closeApp(C);
    const touched = [];
    (function walk(d, depth) { if (depth > 2 || !fs.existsSync(d)) return; for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, n.name); let st; try { st = fs.statSync(p); } catch { continue; } if (st.mtimeMs >= t0) touched.push(path.relative(defaultDir, p)); if (n.isDirectory()) walk(p, depth + 1); } })(defaultDir, 0);
    obs(`launched with AEGIS_USER_DATA=<tmp> but WITHOUT --user-data-dir: entries under ${defaultDir} modified during that launch: ${JSON.stringify(touched.slice(0, 25))}`);
    extra.appDataTouchedDespiteAegisUserData = touched;
    check('AEGIS_USER_DATA keeps every byte out of the default %APPDATA% location', touched.length === 0, `${touched.length} entries written to ${defaultDir}`);
  });


// persist what the main app did, then shut it down
extra.mainAppConsoleMsgs = A.consoleMsgs.slice(0, 200);
extra.modelStubPathsSeen = [...stub.pathsSeen];
const profileTree = [];
(function walk(d, depth = 0) { for (const n of fs.readdirSync(d, { withFileTypes: true })) { if (depth >= 1 && n.isDirectory() && ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnWebGPUCache', 'DawnGraphiteCache', 'Local Storage', 'Session Storage', 'Network', 'blob_storage', 'Shared Dictionary', 'cache', 'session'].includes(n.name)) { profileTree.push(path.relative(A.profile, path.join(d, n.name)) + '/ (chromium cache)'); continue; } const p = path.join(d, n.name); profileTree.push(path.relative(A.profile, p) + (n.isDirectory() ? '/' : '')); if (n.isDirectory()) walk(p, depth + 1); } })(A.profile);
extra.profileTree = profileTree.slice(0, 80);
extra.errorLinesInLog = A.log.split('\n').filter(l => /\[ERROR\]|\[WARN\]/.test(l)).slice(0, 40);
extra.consoleLinesInLog = A.log.split('\n').filter(l => /CONSOLE/.test(l)).slice(0, 40);
await closeApp(A);
extra.mainExit = A.exited;
const gitAfter = spawnSync('git', ['status', '--porcelain', '--ignored'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter(l => l && !l.includes('docs/audits/evidence/run01') && !l.includes('dist/') && !l.includes('.native') && !l.includes('node_modules') && !l.includes('tests/output'));
extra.repoWrites = gitAfter.filter(l => !gitBefore.includes(l));
console.log('repo writes during run:', JSON.stringify(extra.repoWrites));

// ------------------------------------------------------------------ separate launches: 150% scale, --disable-gpu
async function variant(label, extraArgs, id, title) {
  await scenario(id, title, 'App launches and renders correctly with this flag.', async ({ obs, shots }) => {
    const p2 = await pickPort();
    const B = await launchApp(label, { extraArgs, cdpPort: p2.port });
    await sleep(3500);
    const d = await B.chrome.evaluate(() => ({ dpr: devicePixelRatio, inner: [innerWidth, innerHeight], scrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth, titlebarH: document.getElementById('titlebar').offsetHeight, omniH: document.getElementById('omnibar-container').offsetHeight, drawerW: Math.round(document.getElementById('swarm-drawer').getBoundingClientRect().width), runBtnVisible: (r => r.right <= innerWidth && r.width > 0)(document.getElementById('swarm-run-btn').getBoundingClientRect()), settingsVisible: (r => r.right <= innerWidth)(document.getElementById('settings-btn').getBoundingClientRect()) }));
    obs(`${label}: ${JSON.stringify(d)}; native views: ${JSON.stringify((await nativeSize(B)).map(s => [s.w, s.h]))}`);
    check('app launched and chrome rendered', d.titlebarH > 0);
    check('no horizontal overflow; Run and Settings buttons inside the window', !d.scrollX && d.runBtnVisible && d.settingsVisible, JSON.stringify(d));
    const gpuLines = B.log.split('\n').filter(l => /gpu|GPU/.test(l) && /ERROR|exited|crash/i.test(l));
    obs(`GPU-related error lines in log: ${gpuLines.length}`);
    shots(osShot(B, `os_${id}_${label}`).file);
    await closeApp(B);
  });
}
await variant('scale150', ['--force-device-scale-factor=1.5'], '10b', 'Scaling 150% (Chromium --force-device-scale-factor=1.5; not the Windows display setting)');
await variant('disablegpu', ['--disable-gpu'], 'E2', 'Edge case: launch with --disable-gpu');

// ------------------------------------------------------------------ write results
const summary = results.map(r => ({ id: r.id, title: r.title, status: r.status, passed: r.checks.filter(c => c.ok).length, total: r.checks.length }));
fs.writeFileSync(path.join(OUT, 'scenario_results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), environment: env, summary, scenarios: results, extra }, null, 2));
// The evidence is committed: replace the machine user's home directory and name in the text files.
{
  const home = os.homedir(); const user = os.userInfo().username;
  for (const n of fs.readdirSync(OUT)) {
    if (!/\.(log|json)$/.test(n)) continue;
    const p = path.join(OUT, n);
    let t = fs.readFileSync(p, 'utf8');
    t = t.split(home).join('%USERPROFILE%').split(home.replace(/\\/g, '\\\\')).join('%USERPROFILE%').split(home.replace(/\\/g, '/')).join('%USERPROFILE%');
    if (user.length > 2) t = t.split(user).join('<user>');
    fs.writeFileSync(p, t);
  }
}
console.log('\nSUMMARY');
for (const s of summary) console.log(`  ${String(s.id).padEnd(4)} ${s.status.padEnd(8)} ${s.passed}/${s.total}  ${s.title}`);
stub.server.close();
process.exit(0);
