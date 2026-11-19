#!/usr/bin/env node
/**
 * Real-app check for #224 (RUN-02): fresh profile, no API key, press Run -> Settings opens with
 * "Add an API key to run missions", no mission starts, no scripted provider in the log; then the labelled Replay demo.
 *
 *   npm run build
 *   node scripts/dev/drive_first_run.mjs [--out docs/audits/evidence/224] [--port 9345]
 *
 * Recipe and caveats: docs/dev/RUN_RECIPE.md. Screenshots are OS captures of the real window (native page view included).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const electronExe = require('electron');
const root = path.resolve(import.meta.dirname, '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const outDir = path.resolve(root, arg('out', 'docs/audits/evidence/224'));
const port = Number(arg('port', '9345'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(outDir, { recursive: true });

const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-224-'));
const env = { ...process.env, AEGIS_USER_DATA: prof, ELECTRON_ENABLE_LOGGING: '1' };
delete env.ELECTRON_RUN_AS_NODE;
for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AEGIS_E2E_MODEL_MODE']) delete env[k];

const logPath = path.join(outDir, 'electron.log');
const logStream = fs.createWriteStream(logPath);
let log = '';
const child = spawn(electronExe, [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(prof, 'chromium')}`, '--disable-features=CalculateNativeWinOcclusion', path.join(root, 'dist', 'main', 'index.js')], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
for (const s of [child.stdout, child.stderr]) s.on('data', d => { log += d.toString(); logStream.write(d); });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const shot = name => {
  const out = path.join(outDir, name);
  const r = spawnSync('powershell', ['-NoProfile', '-File', path.join(root, 'scripts/dev/os_screenshot.ps1'), '-ProcessId', String(child.pid), '-Out', out], { encoding: 'utf8' });
  console.log(`screenshot ${name}: ${(r.stdout || r.stderr || '').trim().split('\n').pop()}`);
};

let browser;
try {
  for (let i = 0; i < 60 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 }); } catch { await sleep(500); }
  }
  if (!browser) throw new Error('could not attach CDP');
  let chrome;
  for (let i = 0; i < 60 && !chrome; i++) { chrome = browser.contexts()[0].pages().find(p => p.url().includes('renderer/index.html')); await sleep(250); }
  if (!chrome) throw new Error('chrome renderer not found');
  await sleep(2500);
  const ipc = (fn, ...a) => chrome.evaluate(([f, args]) => window.aegis[f](...args), [fn, a]);

  const st = (await ipc('getSettings')).data;
  check('fresh profile: no key, no demoMode setting', Object.keys(st.apiKeys || {}).length === 0 && st.demoMode === undefined, JSON.stringify({ provider: st.modelProvider, keys: Object.keys(st.apiKeys || {}) }));

  // 1. Press Run with no key
  await chrome.fill('#omnibar-input', '/do open example.com and report the page heading');
  await chrome.click('#swarm-run-btn').catch(async () => chrome.press('#omnibar-input', 'Enter'));
  await sleep(2500);
  const settingsOpen = !(await chrome.$eval('#settings-modal', e => e.classList.contains('hidden')));
  const notice = (await chrome.$eval('#settings-notice', e => e.textContent)).trim();
  const planOpen = !(await chrome.$eval('#plan-preview-modal', e => e.classList.contains('hidden')));
  check('Settings modal opened on Run with no key', settingsOpen);
  check('notice says "Add an API key to run missions"', notice.includes('Add an API key to run missions'), notice);
  check('plan preview did not open', !planOpen);
  const provider = await chrome.$eval('#settings-provider', e => e.value);
  check('provider section is the one needing the key', provider === 'gemini', provider);
  shot('os_01_settings_opened_no_key.png');
  await chrome.screenshot({ path: path.join(outDir, 'cdp_01_settings_opened_no_key.png') });
  const missions = (await ipc('listMissions', 5)).data || [];
  check('no mission was created', missions.length === 0, `missions=${missions.length}`);
  const direct = (await ipc('startMission', 'open example.com', 'gemini-2.0-flash')).data;
  check('startMission returns typed MODEL_NOT_CONFIGURED (no throw)', direct.started === false && direct.code === 'MODEL_NOT_CONFIGURED' && direct.provider === 'gemini', JSON.stringify(direct));
  check('main process still answers IPC', (await ipc('getSettings')).ok);

  // 2. Replay demo
  await chrome.click('#cancel-settings-btn');
  const started = (await ipc('startDemo')).data;
  check('replay demo starts', started.started === true, JSON.stringify(started));
  await sleep(1500);
  const bannerVisible = await chrome.$eval('#demo-banner', e => !e.classList.contains('hidden') && getComputedStyle(e).display !== 'none');
  const bannerText = await chrome.$eval('#demo-banner', e => e.textContent);
  check('DEMO banner visible in the titlebar', bannerVisible && bannerText === 'DEMO - recorded session, no AI model is running', bannerText);
  shot('os_02_replay_demo_banner.png');
  await sleep(4500);
  const feed = await chrome.evaluate(() => [...document.querySelectorAll('#timeline-feed, .timeline-item, [class*="timeline"] li')].map(e => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(-8));
  check('feed shows the recorded result with the demo label', feed.some(t => /DEMO/.test(t)), feed.slice(-2).join(' | ').slice(0, 200));
  shot('os_03_replay_demo_finished.png');
  const after = (await ipc('listMissions', 5)).data || [];
  check('replay demo created no mission row (nothing persisted)', after.length === 0, `missions=${after.length}`);
  await ipc('stopDemo');

  check('log has no scripted/mock provider line', !/scripted|MockModelProvider|Mock task finished/i.test(log.replace(/\[DEMO\][^\n]*/g, '')), (log.match(/.*(scripted|MockModelProvider).*/i) || [''])[0].slice(0, 160));
  check('log has no unhandled error', !/Unhandled error|render-process-gone|FATAL/.test(log));
} catch (err) {
  check('driver ran to completion', false, err.stack);
} finally {
  fs.writeFileSync(path.join(outDir, 'first_run_results.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  try { await browser?.close(); } catch {}
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  logStream.end();
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
