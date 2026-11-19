#!/usr/bin/env node
/**
 * Packaged-app smoke test (#258). Launches the real packaged binary, attaches over the
 * Chrome DevTools Protocol, and checks that the product actually came up:
 *   1. the chrome window page loads from the packaged asar and has the expected <title>
 *   2. the preload bridge (window.aegis) is present and the renderer JS ran (a tab appeared)
 *   3. `Electron app ready` is in the app log written to the isolated user-data dir
 * then quits the app. Exit code 0 only if all of that holds.
 *
 * usage: node scripts/smoke_packaged.mjs [path-to-binary] [--screenshot out.png]
 * Requires Node >= 22 (global WebSocket). On Linux CI run under xvfb-run.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { findPackagedApp, ROOT_DIR } from './packaging.mjs';

const args = process.argv.slice(2);
const shotIdx = args.indexOf('--screenshot');
const screenshotPath = shotIdx >= 0 ? path.resolve(args[shotIdx + 1]) : null;
const positional = args.filter((a, i) => !a.startsWith('--') && i !== shotIdx + 1);
const binary = positional[0] ? path.resolve(positional[0]) : findPackagedApp().launchBinary;
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 90000);

function fail(msg) {
  console.error(`SMOKE FAILED: ${msg}`);
  return 1;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('CDP websocket error')));
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }, 20000);
        pending.set(id, {
          resolve: (v) => (clearTimeout(timer), resolve(v)),
          reject: (e) => (clearTimeout(timer), reject(e))
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close()
  };
}

async function main() {
  if (typeof WebSocket === 'undefined') return fail('global WebSocket missing: run with Node >= 22');
  if (!fs.existsSync(binary)) return fail(`binary not found: ${binary}`);

  const expectedTitle = /<title>([^<]*)<\/title>/.exec(
    fs.readFileSync(path.join(ROOT_DIR, 'src', 'renderer', 'index.html'), 'utf8')
  )?.[1];
  if (!expectedTitle) return fail('could not read expected <title> from src/renderer/index.html');

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-smoke-'));
  const port = await freePort();
  const launchArgs = [`--remote-debugging-port=${port}`, '--remote-allow-origins=*', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
  if (process.platform === 'linux') launchArgs.push('--no-sandbox'); // CI containers lack the SUID chrome-sandbox helper

  console.log(`Launching ${binary}\n  user data: ${userData}\n  CDP port: ${port}`);
  const child = spawn(binary, launchArgs, {
    env: { ...process.env, AEGIS_E2E: '0', AEGIS_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  let exited = null;
  child.on('exit', (code, signal) => (exited = { code, signal }));

  let cdp = null;
  let exitCode = 0;
  try {
    // 1. find the chrome page
    const deadline = Date.now() + TIMEOUT_MS;
    let page = null;
    while (Date.now() < deadline && !page) {
      if (exited) throw new Error(`app exited early (code=${exited.code} signal=${exited.signal}). Output:\n${output.slice(-3000)}`);
      try {
        const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
        page = targets.find((t) => t.type === 'page' && /renderer[\\/]index\.html/.test(decodeURIComponent(t.url))) ?? null;
      } catch {
        /* debugger port not up yet */
      }
      if (!page) await sleep(500);
    }
    if (!page) throw new Error(`chrome renderer page never appeared. Output:\n${output.slice(-3000)}`);
    while (Date.now() < deadline && page.title !== expectedTitle) {
      await sleep(500); // the title is only reported once the document has loaded
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      page = targets.find((t) => t.id === page.id) ?? page;
    }
    console.log(`Page: ${page.url}\nTitle: ${page.title}`);
    if (!page.url.includes('.asar')) throw new Error(`renderer was not loaded from the packaged asar: ${page.url}`);
    if (page.title !== expectedTitle) throw new Error(`title mismatch: got "${page.title}", expected "${expectedTitle}"`);

    // 2. renderer JS ran and the preload bridge exists
    cdp = cdpClient(page.webSocketDebuggerUrl);
    await cdp.ready;
    const evalJs = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
    let state = null;
    while (Date.now() < deadline) {
      state = await evalJs(
        `({ bridge: typeof window.aegis, omnibar: !!document.getElementById('omnibar-input'), tabs: document.querySelectorAll('#tabs-container > *').length, bg: getComputedStyle(document.body).backgroundColor })`
      );
      if (state?.bridge === 'object' && state.omnibar && state.tabs > 0) break;
      await sleep(500);
    }
    console.log(`Renderer state: ${JSON.stringify(state)}`);
    if (state?.bridge !== 'object') throw new Error('preload bridge window.aegis is missing');
    if (!state.omnibar) throw new Error('omnibar not rendered');
    if (!(state.tabs > 0)) throw new Error('no tab appeared: renderer JS or IPC did not run');

    if (screenshotPath) {
      await cdp.send('Page.bringToFront').catch(() => {});
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      fs.writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));
      console.log(`Screenshot written to ${screenshotPath}`);
    }

    // 3. app log
    const logFile = path.join(userData, 'logs', 'app.log');
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    if (!log.includes('Electron app ready')) throw new Error(`"Electron app ready" not found in ${logFile}`);
    if (!/Chrome renderer loaded successfully/.test(log)) throw new Error('renderer load not logged');
    const fatal = log.split('\n').filter((l) => l.includes('"level":"error"'));
    if (fatal.length) console.warn(`WARNING: ${fatal.length} error-level log line(s), first: ${fatal[0].slice(0, 300)}`);
    console.log('SMOKE PASSED: packaged app started, UI rendered, "Electron app ready" logged.');
  } catch (err) {
    exitCode = fail(err.message);
  } finally {
    // quit: ask the browser to close, fall back to a hard kill
    try {
      if (!exited) {
        const info = await getJson(`http://127.0.0.1:${port}/json/version`).catch(() => null);
        if (info?.webSocketDebuggerUrl) {
          const b = cdpClient(info.webSocketDebuggerUrl);
          await b.ready;
          b.send('Browser.close').catch(() => {});
        }
        for (let i = 0; i < 20 && !exited; i++) await sleep(500);
      }
    } catch {
      /* fall through to kill */
    }
    if (!exited) {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else child.kill('SIGKILL');
      for (let i = 0; i < 10 && !exited; i++) await sleep(300);
    }
    try {
      fs.rmSync(userData, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  return exitCode;
}

process.exit(await main());
