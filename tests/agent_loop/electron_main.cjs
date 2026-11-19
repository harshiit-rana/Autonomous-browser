/**
 * Electron main-process entry for suites that must run against real Chromium pages (issue #225).
 * Loaded by tests/agent_loop/launch.ts as `electron tests/agent_loop/electron_main.cjs --suite=<name>`.
 * The suite module (`tests/agent_loop/<name>.ts`, loaded through tsx) exports `run(): Promise<object>`; its result is
 * printed as one `__RESULT__<json>` line. App code is imported from `src/` directly, so the suite never runs a stale build.
 */
require('tsx/cjs');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { app } = require('electron');

const suiteArg = process.argv.find(a => a.startsWith('--suite='));
const suite = suiteArg ? suiteArg.slice('--suite='.length) : '';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-agentloop-'));
app.setPath('userData', profile);
process.env.AEGIS_USER_DATA = process.env.AEGIS_USER_DATA || profile;
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.on('window-all-closed', () => { /* the suite decides when to quit */ });

function emit(obj) {
  process.stdout.write('\n__RESULT__' + JSON.stringify(obj) + '\n');
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    if (!/^[a-z0-9_]+$/.test(suite)) throw new Error(`bad --suite=${suite}`);
    const mod = require(path.join(__dirname, `${suite}.ts`));
    const result = await mod.run();
    emit(result);
  } catch (err) {
    code = 1;
    emit({ fatal: String(err && err.stack || err) });
  }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked files on Windows */ }
  app.exit(code);
});
