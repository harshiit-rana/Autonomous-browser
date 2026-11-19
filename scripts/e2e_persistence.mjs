#!/usr/bin/env node
/**
 * Real-app e2e for Issue #239 (PST-01): drives the built Electron app (dist/) with Playwright `_electron`.
 *
 *   npm run build && npm run rebuild && node scripts/e2e_persistence.mjs [--out <dir>]
 *
 * 1. Launch app on a throw-away profile (AEGIS_USER_DATA), point the provider at an unreachable Ollama URL so the
 *    mission really runs and really fails (no mock provider), and read back the recorded events over IPC.
 * 2. Quit, relaunch the same profile, open the History panel in the UI and assert the DOM shows exactly the same
 *    events (seq, kind, text). A second launched instance must exit (single-instance lock).
 * 3. Export data from the Settings dialog (native dialog stubbed), verify the zip holds no secrets.
 * 4. Import that zip into an empty profile through the UI and confirm its history shows the same mission.
 * Exit code 0 only if every assertion holds. Requires a desktop session (xvfb on Linux).
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { _electron: electron } = require('playwright-core');
const electronExe = require(path.join(root, 'node_modules', 'electron'));
const { unzipSync } = require(path.join(root, 'node_modules', 'fflate'));

const outIdx = process.argv.indexOf('--out');
const outDir = path.resolve(outIdx > 0 ? process.argv[outIdx + 1] : path.join(root, 'tests', 'output', 'e2e_persistence'));
fs.mkdirSync(outDir, { recursive: true });

const SECRET = 'sk-e2e-SECRET-should-never-be-exported';
function cleanEnv(profile) {
  const env = { ...process.env, AEGIS_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE; // must be absent, not empty
  return env;
}
const mkProfile = n => fs.mkdtempSync(path.join(os.tmpdir(), `aegis-e2e-${n}-`));

async function launch(profile) {
  const app = await electron.launch({
    executablePath: electronExe,
    args: [path.join(root, 'dist', 'main', 'index.js')],
    env: cleanEnv(profile),
    timeout: 60000
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => Boolean(window.aegis && window.aegis.listMissions), null, { timeout: 30000 });
  return { app, page };
}

async function ipc(page, fn, ...args) {
  const res = await page.evaluate(([name, a]) => window.aegis[name](...a), [fn, args]);
  assert.ok(res && res.ok, `IPC ${fn} failed: ${JSON.stringify(res)}`);
  return res.data;
}

async function allEvents(page, missionId) {
  const out = [];
  let after = 0;
  for (;;) {
    const d = await ipc(page, 'getMissionEvents', missionId, after, 500);
    out.push(...d.events);
    if (d.nextAfterSeq === null) return out;
    after = d.nextAfterSeq;
  }
}

function eventText(e) {
  const d = e.data || {};
  const c = s => String(s ?? '').replace(/[\u0000-\u001F\u007F-\u009F‎‏‪-‮]/g, ' ').trim();
  if (e.kind === 'evidence') return c(d.text);
  if (e.kind === 'status') return `${c(d.status)}: ${c(d.message)}`;
  if (e.kind === 'worker') return `${c(d.name || d.id)} - ${c(d.task)} (${c(d.status)}, ${c(d.progress)}%)`;
  if (e.kind === 'telemetry') return `tokens ${c(d.tokensTotal)}, cost $${c(d.costTotal)}`;
  return c(JSON.stringify(d));
}

async function domHistory(page, missionId) {
  await page.click('#history-btn');
  await page.waitForSelector(`.history-mission[data-mission-id="${missionId}"]`, { timeout: 15000 });
  await page.click(`.history-mission[data-mission-id="${missionId}"]`);
  await page.waitForSelector('.history-event', { timeout: 15000 });
  await page.waitForFunction(() => /event\(s\) shown/.test(document.getElementById('history-status-msg').textContent), null, { timeout: 15000 });
  return page.$$eval('.history-event', els => els.map(el => ({
    seq: Number(el.dataset.seq),
    kind: el.querySelector('.history-event-kind').textContent,
    text: el.querySelector('.history-event-text').textContent
  })));
}

const report = {};

// ---------------------------------------------------------------- run 1: real mission, real events
const profile = mkProfile('a');
let missionId;
let recorded;
{
  const { app, page } = await launch(profile);
  await ipc(page, 'updateSettings', { modelProvider: 'ollama', ollamaBaseUrl: 'http://127.0.0.1:9/v1', apiKeys: { openai: SECRET } });
  const started = await ipc(page, 'startMission', 'persistence e2e: summarise the current page', 'llama3');
  assert.ok(started.started, `mission did not start: ${JSON.stringify(started)}`);
  missionId = started.missionId;

  const deadline = Date.now() + 120000;
  let mission;
  while (Date.now() < deadline) {
    const list = await ipc(page, 'listMissions', 20);
    mission = list.find(m => m.id === missionId);
    if (mission && ['completed', 'failed', 'cancelled'].includes(mission.state)) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  assert.ok(mission && ['completed', 'failed', 'cancelled'].includes(mission.state), `mission never finished: ${JSON.stringify(mission)}`);
  recorded = await allEvents(page, missionId);
  assert.ok(recorded.length >= 4, `expected several recorded events, got ${recorded.length}`);
  assert.deepEqual(recorded.map(e => e.seq), recorded.map((_, i) => i + 1), 'seq is gap-free');
  assert.ok(recorded.some(e => e.kind === 'status') && recorded.some(e => e.kind === 'evidence'));
  report.run1 = { missionId, state: mission.state, error: mission.error ?? null, events: recorded.length };
  await page.screenshot({ path: path.join(outDir, '1-before-quit.png') });
  await app.close();
}
console.log('run 1 (mission executed and recorded):', JSON.stringify(report.run1));
assert.ok(fs.existsSync(path.join(profile, 'aegis.sqlite')), 'aegis.sqlite exists in the profile');
assert.ok(!fs.existsSync(path.join(profile, 'missions', `${missionId}.json`)), 'no JSON checkpoint is written any more');
assert.ok(!fs.readFileSync(path.join(profile, 'aegis.sqlite')).includes(SECRET), 'API key is not in the database file');

// ---------------------------------------------------------------- run 2: restart, history in the UI
{
  const { app, page } = await launch(profile);
  const settings = await ipc(page, 'getSettings');
  assert.equal(settings.modelProvider, 'ollama', 'settings survived the restart');
  assert.equal(settings.ollamaBaseUrl, 'http://127.0.0.1:9/v1');

  const dom = await domHistory(page, missionId);
  const expected = recorded.map(e => ({ seq: e.seq, kind: e.kind, text: eventText(e) }));
  assert.deepEqual(dom, expected, 'UI history shows exactly the events recorded before the restart');
  await page.screenshot({ path: path.join(outDir, '2-history-after-restart.png') });
  report.run2 = { eventsInUi: dom.length, identical: true };
  await page.click('#close-history-btn');

  // Second instance must not start (requestSingleInstanceLock).
  const second = spawn(electronExe, [path.join(root, 'dist', 'main', 'index.js')], { env: cleanEnv(profile), stdio: 'ignore' });
  const exit = await new Promise(resolve => {
    const t = setTimeout(() => { second.kill(); resolve('still-running'); }, 20000);
    second.on('exit', code => { clearTimeout(t); resolve(`exited:${code}`); });
  });
  assert.ok(exit.startsWith('exited'), `second instance should quit, got ${exit}`);
  report.run2.secondInstance = exit;
  assert.equal((await ipc(page, 'listMissions', 5)).length >= 1, true, 'first instance still healthy');

  // Export from the Settings dialog (native save dialog stubbed to a fixed path).
  const zipPath = path.join(outDir, 'export.zip');
  fs.rmSync(zipPath, { force: true });
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, zipPath);
  await page.click('#settings-btn');
  await page.waitForSelector('#settings-modal:not(.hidden)');
  await page.click('#export-data-btn');
  await page.waitForFunction(() => /Exported \d+ files/.test(document.getElementById('settings-status-msg').textContent), null, { timeout: 30000 });
  await page.screenshot({ path: path.join(outDir, '3-export.png') });
  assert.ok(fs.existsSync(zipPath));
  const entries = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
  assert.ok(entries['aegis.sqlite'] && entries['manifest.json']);
  for (const [name, data] of Object.entries(entries)) assert.ok(!Buffer.from(data).includes(SECRET), `secret found in export entry ${name}`);
  report.run2.export = { entries: Object.keys(entries), secretsFound: false };
  await app.close();
}
console.log('run 2 (restart + UI history + single instance + export):', JSON.stringify(report.run2));

// ---------------------------------------------------------------- run 3/4: import into an empty profile
{
  const fresh = mkProfile('b');
  const zipPath = path.join(outDir, 'export.zip');
  let { app, page } = await launch(fresh);
  assert.equal((await ipc(page, 'listMissions', 5)).length, 0, 'fresh profile starts empty');
  await app.evaluate(({ dialog, app: a }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
    dialog.showMessageBoxSync = () => 0; // confirm "Import and restart"
    a.relaunch = () => {}; // the test relaunches explicitly below
  }, zipPath);
  await page.click('#settings-btn');
  await page.waitForSelector('#settings-modal:not(.hidden)');
  const closed = new Promise(resolve => app.process().once('exit', resolve));
  await page.click('#import-data-btn');
  await closed; // main process exits itself after a successful import
  ({ app, page } = await launch(fresh));
  const dom = await domHistory(page, missionId);
  assert.deepEqual(dom, recorded.map(e => ({ seq: e.seq, kind: e.kind, text: eventText(e) })), 'imported profile shows the same mission events');
  await page.screenshot({ path: path.join(outDir, '4-history-after-import.png') });
  report.run3 = { importedEvents: dom.length, identical: true };
  await app.close();
}
console.log('run 3 (import into empty profile):', JSON.stringify(report.run3));

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log('\nE2E PERSISTENCE: ALL ASSERTIONS PASSED');
