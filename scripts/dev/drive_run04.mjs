#!/usr/bin/env node
/**
 * Real-app check for #226 (RUN-04): mission lifecycle in the running Electron app, driven through the real UI.
 * The model is the scripted e2e provider (AEGIS_E2E_MODEL_MODE=scripted, test-only): it proves lifecycle behaviour, NOT
 * answer quality. The app process is really killed (taskkill /T /F) and relaunched on the same profile.
 *
 *   npm run build
 *   node scripts/dev/drive_run04.mjs [--out docs/audits/evidence/226] [--port 9361]
 *
 * Launch A: approval card, Pause/Resume/Takeover/Hand Back label sync, MISSION_ACTIVE toast, then KILL after the order.
 * Launch B: relaunch -> "Resume interrupted mission" banner -> resume -> completes; the order count stays 1.
 * Launch C: cancel during a tool -> idle < 1 s -> start again; tab crash (CDP Page.crash) -> banner -> Reload page.
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
const outDir = path.resolve(root, arg('out', 'docs/audits/evidence/226'));
let nextPort = Number(arg('port', '9361'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); return ok; };
const waitUntil = async (fn, ms = 15000, every = 150) => { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t0 > ms) return null; await sleep(every); } };

// ---------------------------------------------------------------- fixture shop (separate process: it outlives the app kill)
const shopProc = spawn(process.execPath, [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'tests', 'helpers', 'fixture_shop.ts')], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
const shopPort = await new Promise((res, rej) => {
  let buf = '';
  shopProc.stdout.on('data', d => { buf += d; const m = buf.match(/SHOP_PORT=(\d+)/); if (m) res(Number(m[1])); });
  setTimeout(() => rej(new Error('fixture shop did not start')), 20000);
});
const shop = `http://127.0.0.1:${shopPort}`;
const orders = () => new Promise((res, rej) => http.get(`${shop}/orders`, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => res(JSON.parse(s).orders)); }).on('error', rej));

// ---------------------------------------------------------------- profile + scripts
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-226-'));
const call = (name, args) => ({ toolCalls: [{ id: `c_${Math.random().toString(36).slice(2, 8)}`, name, arguments: args }] });
const waitStep = () => call('wait', { ms: 5000 });
const scripts = {
  A: { actor: [call('navigate', { url: `${shop}/shop` }), call('click', { ref: '{{ref:Place order}}' }), ...Array.from({ length: 12 }, waitStep)], verifier: [] },
  B: { actor: [call('done', { result: 'The order was confirmed (resumed after the app was killed)', evidence: ['Order confirmed'] })], verifier: [call('report_verdict', { pass: true, reasons: ['The page shows Order confirmed'] })] },
  C: { actor: [call('navigate', { url: `${shop}/shop` }), waitStep(), waitStep(), waitStep(), call('done', { result: 'Fixture shop reached; mission survived the crash', evidence: ['Fixture shop'] })], verifier: [call('report_verdict', { pass: true, reasons: ['ok'] })] }
};
for (const [k, s] of Object.entries(scripts)) {
  fs.writeFileSync(path.join(prof, `actor_${k}.json`), JSON.stringify(s.actor, null, 2));
  fs.writeFileSync(path.join(prof, `verifier_${k}.json`), JSON.stringify(s.verifier, null, 2));
  fs.copyFileSync(path.join(prof, `actor_${k}.json`), path.join(outDir, `actor_script_${k}.json`));
}

// ---------------------------------------------------------------- app launch
async function launch(label, key) {
  const port = nextPort++;
  const env = { ...process.env, AEGIS_USER_DATA: prof, ELECTRON_ENABLE_LOGGING: '1', AEGIS_E2E_MODEL_MODE: 'scripted', AEGIS_E2E_SCRIPT: path.join(prof, `actor_${key}.json`), AEGIS_E2E_VERIFIER_SCRIPT: path.join(prof, `verifier_${key}.json`) };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete env[k];
  const logStream = fs.createWriteStream(path.join(outDir, `electron_${label}.log`));
  const child = spawn(electronExe, [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(prof, 'chromium')}`, '--disable-features=CalculateNativeWinOcclusion', path.join(root, 'dist', 'main', 'index.js')], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const app = { label, child, log: '' };
  for (const s of [child.stdout, child.stderr]) s.on('data', d => { app.log += d.toString(); logStream.write(d); });
  for (let i = 0; i < 60 && !app.browser; i++) { try { app.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 }); } catch { await sleep(500); } }
  if (!app.browser) throw new Error(`could not attach CDP on ${port}`);
  for (let i = 0; i < 80 && !app.chrome; i++) { app.chrome = app.browser.contexts()[0].pages().find(p => p.url().includes('renderer/index.html')); await sleep(250); }
  await app.chrome.waitForSelector('#titlebar', { timeout: 20000 });
  await app.chrome.waitForFunction(() => Boolean(window.aegis), null, { timeout: 15000 });
  await sleep(2000);
  app.ipc = (fn, ...a) => app.chrome.evaluate(([f, args]) => window.aegis[f](...args), [fn, a]);
  return app;
}
const kill = app => { spawnSync('taskkill', ['/PID', String(app.child.pid), '/T', '/F']); };
const shot = (app, name) => {
  const r = spawnSync('powershell', ['-NoProfile', '-File', path.join(root, 'scripts/dev/os_screenshot.ps1'), '-ProcessId', String(app.child.pid), '-Out', path.join(outDir, name)], { encoding: 'utf8' });
  console.log(`  screenshot ${name}: ${(r.stdout || r.stderr || '').trim().split('\n').pop()}`);
};
async function startViaUi(app, prompt) {
  await app.chrome.fill('#omnibar-input', prompt);
  await app.chrome.press('#omnibar-input', 'Enter');
  const modal = await waitUntil(async () => !(await app.chrome.$eval('#plan-preview-modal', e => e.classList.contains('hidden'))), 10000);
  if (!modal) return false;
  await app.chrome.click('#execute-plan-btn');
  return true;
}
const missions = app => app.ipc('listMissions', 20).then(r => (r && r.data) || []);
const statusEvents = async (app, id) => ((await app.ipc('getMissionEvents', id, 0, 500)).data?.events || []).filter(e => e.kind === 'status').map(e => e.data);
const pauseLabel = app => app.chrome.$eval('#pause-agent-btn', e => ({ text: e.textContent.trim(), disabled: e.disabled }));
const takeoverLabel = app => app.chrome.$eval('#takeover-btn', e => ({ text: e.textContent.trim(), disabled: e.disabled }));
const questionCard = app => app.chrome.evaluate(() => { const c = document.getElementById('question-card'); return c && !c.classList.contains('hidden') ? { kind: document.getElementById('question-kind').textContent, text: document.getElementById('question-text').textContent, options: [...document.querySelectorAll('#question-options button')].map(b => b.textContent.trim()) } : null; });
const ckptFiles = () => { const d = path.join(prof, 'missions'); try { return fs.readdirSync(d).map(i => path.join(d, i, 'checkpoint.json')).filter(f => fs.existsSync(f)); } catch { return []; } };

let appA, appB, appC;
try {
  // ================================================================ Launch A
  appA = await launch('A', 'A');
  const goal = `Buy Widget Pro at ${shop}/shop and report the confirmation`;
  check('A: mission started from the omnibar + plan preview', await startViaUi(appA, goal));
  const earlier = [];
  const approval = await waitUntil(async () => {
    const q = await questionCard(appA);
    if (!q) return null;
    if (/Place order/.test(q.text)) return q;
    // An earlier card (the agent tab starts on the home page, so the first navigation to the shop is asked about): approve it.
    earlier.push(`${q.kind}: ${q.text.slice(0, 100)}`);
    await appA.chrome.click('#question-options button').catch(() => {});
    await sleep(800);
    return null;
  }, 60000);
  fs.writeFileSync(path.join(outDir, 'earlier_cards_A.json'), JSON.stringify(earlier, null, 2));
  check('A: policy approval card for the financial click', approval && approval.kind === 'Approval needed' && approval.options.includes('Approve'), JSON.stringify(approval));
  const mA = (await missions(appA))[0];
  const evA0 = await statusEvents(appA, mA.id);
  check('A: status during the approval is waiting_approval (own state, not waiting_user)', evA0.at(-1)?.status === 'waiting_approval', evA0.map(e => e.status).join('>'));
  const pl0 = await pauseLabel(appA);
  check('A: Pause button is disabled while waiting for approval (label cannot lie)', pl0.disabled === true && pl0.text === 'Pause', JSON.stringify(pl0));
  shot(appA, 'os_01_approval_card.png');
  await appA.chrome.click('#question-options button:has-text("Approve")');
  check('A: the order was placed exactly once after approval', await waitUntil(async () => (await orders()) === 1, 20000), `orders=${await orders()}`);
  check('A: a checkpoint with the done click exists in the app data dir (not the repo)', await waitUntil(() => ckptFiles().some(f => { const c = JSON.parse(fs.readFileSync(f, 'utf8')); return c.actions.some(a => a.tool === 'click' && a.phase === 'done' && a.sideEffect); }), 20000), ckptFiles().join(', '));

  await waitUntil(async () => (await pauseLabel(appA)).disabled === false, 15000);
  await appA.chrome.click('#pause-agent-btn');
  const paused = await waitUntil(async () => (await pauseLabel(appA)).text === 'Resume', 5000);
  check('A: Pause -> button reads Resume and the mission state is paused', paused && (await missions(appA))[0].state === 'paused', JSON.stringify(await pauseLabel(appA)));
  shot(appA, 'os_02_paused.png');
  await appA.chrome.click('#pause-agent-btn');
  check('A: Resume -> button reads Pause, state running', await waitUntil(async () => (await pauseLabel(appA)).text === 'Pause' && (await missions(appA))[0].state === 'running', 5000));
  await appA.chrome.click('#takeover-btn');
  const tk = await waitUntil(async () => (await takeoverLabel(appA)).text === 'Hand Back', 5000);
  check('A: Takeover -> button reads Hand Back, state takeover, Pause disabled', tk && (await missions(appA))[0].state === 'takeover' && (await pauseLabel(appA)).disabled === true, JSON.stringify([await takeoverLabel(appA), await pauseLabel(appA)]));
  shot(appA, 'os_03_takeover.png');
  await appA.chrome.click('#takeover-btn');
  check('A: Hand Back -> button reads Takeover, state running', await waitUntil(async () => (await takeoverLabel(appA)).text === 'Takeover' && (await missions(appA))[0].state === 'running', 8000));
  const ev = await statusEvents(appA, mA.id);
  check('A: one mission:status event per transition, seq gapless from 1', ev.every((e, i) => e.seq === i + 1) && ev.map(e => e.status).join('>').includes('paused>running>takeover>running'), ev.map(e => `${e.seq}:${e.status}(${e.reason})`).join(' '));
  fs.writeFileSync(path.join(outDir, 'status_events_A.json'), JSON.stringify(ev, null, 2));

  await startViaUi(appA, 'Second mission while the first is running');
  const toast = await waitUntil(() => appA.chrome.$eval('.aegis-toast', e => e.textContent), 8000);
  check('A: a second start shows the MISSION_ACTIVE toast and starts nothing', toast && /already running/.test(toast) && (await missions(appA)).length === 1, toast);
  shot(appA, 'os_04_mission_active_toast.png');

  const ckptCopy = ckptFiles()[0];
  fs.copyFileSync(ckptCopy, path.join(outDir, 'checkpoint_at_kill.json'));
  const ordersAtKill = await orders();
  kill(appA);
  console.log('  >>> app process tree killed (taskkill /T /F) mid-mission');
  await sleep(1500);

  // ================================================================ Launch B
  appB = await launch('B', 'B');
  const banner = await waitUntil(() => appB.chrome.$eval('#interrupted-banner', e => e.textContent), 15000);
  check('B: relaunch offers "Resume interrupted mission"', banner && /Interrupted mission/.test(banner) && /1 with side effects that will NOT be repeated/.test(banner), banner);
  shot(appB, 'os_05_resume_banner.png');
  const failedOld = (await missions(appB)).find(m => m.id === mA.id);
  check('B: the killed mission itself stays recorded as failed/interrupted in history', failedOld && failedOld.state === 'failed' && /Interrupted/.test(failedOld.error || ''), `${failedOld?.state} ${failedOld?.error}`);
  await appB.chrome.click('#interrupted-resume-btn');
  const fin = await waitUntil(async () => (await missions(appB)).find(m => m.id !== mA.id && m.state === 'completed'), 40000);
  check('B: the resumed mission completed', Boolean(fin), `${fin?.state} ${String(fin?.result || '').slice(0, 100)}`);
  check('B: the order was NOT placed again (orders still 1)', (await orders()) === 1 && ordersAtKill === 1, `orders=${await orders()}`);
  check('B: banner gone, old checkpoint consumed', !(await appB.chrome.$('#interrupted-banner')) && !ckptFiles().some(f => f.includes(mA.id)));
  const feedB = await appB.chrome.$$eval('#evidence-feed .evidence-item .ev-text', els => els.map(e => e.textContent));
  fs.writeFileSync(path.join(outDir, 'feed_B.json'), JSON.stringify(feedB, null, 2));
  shot(appB, 'os_06_resumed_complete.png');
  kill(appB);
  await sleep(1500);

  // ================================================================ Launch C
  appC = await launch('C', 'C');
  check('C: no banner after a resumed mission (offered once)', !(await appC.chrome.$('#interrupted-banner')));
  const r1 = (await appC.ipc('startMission', `Open ${shop}/shop and wait`, 'gemini-2.0-flash')).data;
  check('C: mission 1 started', r1?.started === true, JSON.stringify(r1));
  await waitUntil(async () => (await appC.chrome.$$eval('#evidence-feed .evidence-item .ev-text', els => els.map(e => e.textContent))).some(t => /\[Action\] wait/.test(t)), 30000);
  const t0 = Date.now();
  await appC.chrome.click('#cancel-mission-btn');
  const cancelled = await waitUntil(async () => (await missions(appC)).find(m => m.id === r1.missionId)?.state === 'cancelled', 3000, 25);
  const dt = Date.now() - t0;
  check('C: Cancel during a 5 s tool -> cancelled and runtime idle in < 1 s', cancelled && dt < 1000, `${dt} ms`);
  const r2 = (await appC.ipc('startMission', `Open ${shop}/shop and survive a crash`, 'gemini-2.0-flash')).data;
  check('C: a new mission can start right after the cancel (no MISSION_ACTIVE)', r2?.started === true && !r2?.code, JSON.stringify(r2));
  await waitUntil(async () => (await appC.chrome.$$eval('#evidence-feed .evidence-item .ev-text', els => els.map(e => e.textContent))).some(t => /\[Action\] wait/.test(t)), 30000);
  const tabPage = appC.browser.contexts()[0].pages().find(p => /^https?:/.test(p.url()));
  check('C: found the mission tab page to crash', Boolean(tabPage), tabPage?.url());
  const cdp = await appC.browser.contexts()[0].newCDPSession(tabPage);
  await cdp.send('Page.crash').catch(() => {});
  const crash = await waitUntil(async () => { const q = await questionCard(appC); return q && q.kind === 'Page crashed' ? q : null; }, 15000);
  check('C: renderer crash -> banner with Reload page / Skip, mission paused', crash && crash.options.join() === 'Reload page,Skip' && (await missions(appC)).find(m => m.id === r2.missionId)?.state === 'paused', JSON.stringify(crash));
  const evC = await statusEvents(appC, r2.missionId);
  check('C: the pause reason is tab_crashed', evC.some(e => e.status === 'paused' && e.reason === 'tab_crashed'), evC.map(e => `${e.status}(${e.reason})`).join(' '));
  shot(appC, 'os_07_crash_banner.png');
  await appC.chrome.click('#question-options button:has-text("Reload page")');
  const done = await waitUntil(async () => (await missions(appC)).find(m => m.id === r2.missionId && m.state === 'completed'), 60000);
  check('C: after Reload page the mission continued and completed', Boolean(done), `${done?.state}`);
  const evC2 = await statusEvents(appC, r2.missionId);
  fs.writeFileSync(path.join(outDir, 'status_events_C_crash.json'), JSON.stringify(evC2, null, 2));
  check('C: crash_reload transition recorded', evC2.some(e => e.reason === 'crash_reload'), evC2.map(e => `${e.seq}:${e.status}(${e.reason})`).join(' '));
  shot(appC, 'os_08_after_crash_complete.png');
  check('C: no unhandled error in any log', ![appA, appB, appC].some(a => /Unhandled (Promise|error)|FATAL/.test(a.log)));
} catch (err) {
  check('driver ran to completion', false, err.stack);
} finally {
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ at: new Date().toISOString(), model: 'scripted e2e provider (no real model)', shop: 'tests/helpers/fixture_shop.ts', results }, null, 2));
  for (const a of [appA, appB, appC]) { if (a) { try { await a.browser?.close(); } catch {} kill(a); } }
  shopProc.kill();
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
