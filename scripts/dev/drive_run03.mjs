#!/usr/bin/env node
/**
 * Real-app check for #225 (RUN-03): one mission in the running Electron app with the scripted e2e provider
 * (AEGIS_E2E_MODEL_MODE=scripted, test-only). The mission navigates to the local arena, asks the user a question
 * (answered by clicking the drawer's question card), proposes a wrong answer that the separate verifier rejects,
 * then the right one, which the verifier accepts. No real model is involved; see docs/limitations.md.
 *
 *   npm run build
 *   node scripts/dev/drive_run03.mjs [--out docs/audits/evidence/225] [--port 9346]
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
const outDir = path.resolve(root, arg('out', 'docs/audits/evidence/225'));
const port = Number(arg('port', '9346'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(outDir, { recursive: true });

// The arena server is TypeScript; run it in a child tsx process and read its port.
const arena = spawn(process.execPath, [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '-e',
  "import('./src/testing/arena_server.ts').then(async m => { const S = m.WebArenaServer || m.default.WebArenaServer; const s = new S(); const p = await s.start(0); console.log('ARENA_PORT=' + p); })"],
  { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
const arenaPort = await new Promise((res, rej) => {
  let buf = '';
  arena.stdout.on('data', d => { buf += d; const m = buf.match(/ARENA_PORT=(\d+)/); if (m) res(Number(m[1])); });
  setTimeout(() => rej(new Error('arena did not start')), 20000);
});
const base = `http://127.0.0.1:${arenaPort}`;
const pageUrl = `${base}/agent/nav/a`;
const html = await new Promise((res, rej) => http.get(pageUrl, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => res(s)); }).on('error', rej));
const heading = (html.match(/<h1[^>]*>([^<]*)<\/h1>/i) || [])[1]?.trim() || '';

const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-225-'));
const tc = (name, args) => ({ toolCalls: [{ id: `c_${Math.random().toString(36).slice(2, 8)}`, name, arguments: args }] });
const actor = [
  { text: 'Open the page first.', ...tc('navigate', { url: pageUrl }) },
  tc('ask_user', { question: 'Should I report the page heading or the page title?', options: ['Heading', 'Title'] }),
  tc('done', { result: 'The heading is "Nothing here"', evidence: ['guess'] }),
  tc('done', { result: `The heading is "${heading}"`, evidence: [`h1: ${heading}`] }),
];
const verifier = [
  tc('report_verdict', { pass: false, reasons: ['The page heading in the observation is not "Nothing here"'] }),
  tc('report_verdict', { pass: true, reasons: [`The observed h1 is "${heading}"`] }),
];
const actorPath = path.join(prof, 'actor.json');
const verifierPath = path.join(prof, 'verifier.json');
fs.writeFileSync(actorPath, JSON.stringify(actor, null, 2));
fs.writeFileSync(verifierPath, JSON.stringify(verifier, null, 2));
fs.copyFileSync(actorPath, path.join(outDir, 'actor_script.json'));
fs.copyFileSync(verifierPath, path.join(outDir, 'verifier_script.json'));

const env = { ...process.env, AEGIS_USER_DATA: prof, ELECTRON_ENABLE_LOGGING: '1', AEGIS_E2E_MODEL_MODE: 'scripted', AEGIS_E2E_SCRIPT: actorPath, AEGIS_E2E_VERIFIER_SCRIPT: verifierPath };
delete env.ELECTRON_RUN_AS_NODE;
for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete env[k];

const logStream = fs.createWriteStream(path.join(outDir, 'electron.log'));
let log = '';
const child = spawn(electronExe, [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(prof, 'chromium')}`, '--disable-features=CalculateNativeWinOcclusion', path.join(root, 'dist', 'main', 'index.js')], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
for (const s of [child.stdout, child.stderr]) s.on('data', d => { log += d.toString(); logStream.write(d); });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const shot = name => {
  const r = spawnSync('powershell', ['-NoProfile', '-File', path.join(root, 'scripts/dev/os_screenshot.ps1'), '-ProcessId', String(child.pid), '-Out', path.join(outDir, name)], { encoding: 'utf8' });
  console.log(`screenshot ${name}: ${(r.stdout || r.stderr || '').trim().split('\n').pop()}`);
};

let browser;
try {
  check('arena fixture heading read', heading.length > 0, heading);
  for (let i = 0; i < 60 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 }); } catch { await sleep(500); }
  }
  if (!browser) throw new Error('could not attach CDP');
  let chrome;
  for (let i = 0; i < 60 && !chrome; i++) { chrome = browser.contexts()[0].pages().find(p => p.url().includes('renderer/index.html')); await sleep(250); }
  if (!chrome) throw new Error('chrome renderer not found');
  await sleep(2500);
  const ipc = (fn, ...a) => chrome.evaluate(([f, args]) => window.aegis[f](...args), [fn, a]);

  const started = (await ipc('startMission', 'Open the arena page and report its heading', 'gemini-2.0-flash')).data;
  check('mission started (scripted e2e provider)', started && started.started !== false, JSON.stringify(started).slice(0, 200));

  const waitCard = async (re) => {
    for (let i = 0; i < 80; i++) {
      const vis = await chrome.$eval('#question-card', e => !e.classList.contains('hidden')).catch(() => false);
      const text = vis ? await chrome.$eval('#question-text', e => e.textContent) : '';
      if (vis && re.test(text)) return { vis, text, opts: await chrome.$$eval('#question-options button', els => els.map(e => e.textContent.trim())) };
      await sleep(250);
    }
    return { vis: false, text: '', opts: [] };
  };
  // The agent tab starts on the default home page, so the arena origin is out of scope: the policy asks first.
  const appr = await waitCard(/^Allow navigate/);
  check('policy "ask" for the out-of-scope navigation shows Approve/Deny in the question card', appr.vis && appr.opts.includes('Approve') && appr.opts.includes('Deny'), `${appr.text} [${appr.opts.join(', ')}]`);
  const apprStatus = ((await ipc('listMissions', 5)).data || []).find(m => m.id === started.missionId)?.state;
  check('mission is waiting_user during the approval', apprStatus === 'waiting_user', apprStatus);
  shot('os_00_policy_approval_card.png');
  await chrome.click('#question-options button:has-text("Approve")');

  const q = await waitCard(/heading or the page title/);
  const cardVisible = q.vis, qText = q.text, opts = q.opts;
  check('ask_user shows the question card in the drawer', cardVisible && /heading or the page title/.test(qText), `${qText} [${opts.join(', ')}]`);
  const midStatus = ((await ipc("listMissions", 5)).data || []).find(m => m.id === started.missionId)?.state;
  check('mission is waiting_user while the question is open', midStatus === 'waiting_user', midStatus);
  shot('os_01_question_card.png');
  await chrome.screenshot({ path: path.join(outDir, 'cdp_01_question_card.png') });

  await chrome.click('#question-options button:has-text("Heading")');
  let final;
  for (let i = 0; i < 120; i++) {
    final = ((await ipc("listMissions", 5)).data || []).find(m => m.id === started.missionId);
    if (final && !['running', 'waiting_user', 'planning', 'paused'].includes(final.state)) break;
    await sleep(250);
  }
  const cardHidden = await chrome.$eval('#question-card', e => e.classList.contains('hidden'));
  check('question card closed after the answer', cardHidden);
  check('mission completed (verifier pass after one rejected answer)', final?.state === 'completed', `${final?.state} ${String(final?.result || '').slice(0, 120)}`);
  await sleep(800);
  const feed = await chrome.$$eval('#evidence-feed .evidence-item .ev-text', els => els.map(e => e.textContent));
  check('feed shows the verifier rejecting the first answer', feed.some(t => /\[Verifier\] fail/i.test(t)), feed.filter(t => /Verifier/.test(t)).join(' | ').slice(0, 300));
  check('feed shows the verifier pass', feed.some(t => /\[Verifier\] pass/i.test(t)));
  const statusLine = (log.match(/[^\n]*verifier: pass[^\n]*/) || [''])[0] || feed.find(t => /verifier: pass/.test(t)) || '';
  check('mission status message names the verifier verdict', /verifier: pass/.test(statusLine), statusLine.slice(0, 200));
  shot('os_02_verified_complete.png');
  await chrome.screenshot({ path: path.join(outDir, 'cdp_02_verified_complete.png') });
  fs.writeFileSync(path.join(outDir, 'feed.json'), JSON.stringify(feed, null, 2));

  check('log marks the scripted provider as test-only', /AEGIS_E2E_MODEL_MODE=scripted/.test(log));
  check('log has no unhandled error', !/Unhandled error|render-process-gone|FATAL/.test(log));
} catch (err) {
  check('driver ran to completion', false, err.stack);
} finally {
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ at: new Date().toISOString(), model: 'scripted e2e provider (no real model)', results }, null, 2));
  try { await browser?.close(); } catch {}
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  arena.kill();
  logStream.end();
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
