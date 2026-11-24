import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

function newestMtime(target: string): number {
  if (!fs.existsSync(target)) return 0;
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of fs.readdirSync(target)) newest = Math.max(newest, newestMtime(path.join(target, entry)));
  return newest;
}

function run(command: string, label: string): void {
  const res = spawnSync(command, { cwd: ROOT, shell: true, stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`${label} failed (exit ${res.status}). Command: ${command}`);
}

/**
 * Builds once per run, and only when dist/ is missing or older than the sources (vite rewrites dist/renderer/index.html
 * on every full build, so it is the stamp). Set AEGIS_E2E_SKIP_BUILD=1 to use dist/ as it is.
 */
export default async function globalSetup(): Promise<void> {
  const entry = path.join(ROOT, 'dist', 'main', 'e2e_entry.js');
  const stamp = path.join(ROOT, 'dist', 'renderer', 'index.html');
  const preload = path.join(ROOT, 'dist', 'main', 'preload.js');
  // `tsc -b` (also run by `npm test`) overwrites the bundled preload with an unbundled one that cannot load in the sandboxed
  // chrome window, leaving `window.aegis` undefined. Treat that as a stale build.
  const preloadBundled = (): boolean => fs.existsSync(preload) && !/require\(\s*["']\.{1,2}\//.test(fs.readFileSync(preload, 'utf8'));

  if (process.env.AEGIS_E2E_SKIP_BUILD === '1') {
    if (!fs.existsSync(entry) || !fs.existsSync(stamp)) throw new Error('AEGIS_E2E_SKIP_BUILD=1 but dist/ is not built. Run `npm run build`.');
    return;
  }

  const sourcesNewest = Math.max(
    newestMtime(path.join(ROOT, 'src')),
    newestMtime(path.join(ROOT, 'fixtures')),
    newestMtime(path.join(ROOT, 'vite.config.ts')),
    newestMtime(path.join(ROOT, 'tsconfig.json')),
    newestMtime(path.join(ROOT, 'scripts', 'copy_assets.mjs')),
    newestMtime(path.join(ROOT, 'scripts', 'bundle_preload.mjs'))
  );
  if (!fs.existsSync(entry) || !fs.existsSync(stamp) || fs.statSync(stamp).mtimeMs < sourcesNewest || !preloadBundled()) {
    console.log('[e2e] dist/ is missing or stale: running `npm run build`');
    run('npm run build', 'Build');
  } else {
    console.log('[e2e] dist/ is fresh; skipping build');
  }

  // The app cannot open its database without the Electron-ABI better-sqlite3 in .native/ (see scripts/sqlite_native.mjs).
  const verify = spawnSync('node scripts/sqlite_native.mjs verify', { cwd: ROOT, shell: true, encoding: 'utf8' });
  if (verify.status !== 0) {
    console.log('[e2e] Electron-ABI better-sqlite3 missing: running `npm run rebuild`');
    run('node scripts/sqlite_native.mjs electron', 'Electron-ABI better-sqlite3 fetch');
    run('node scripts/sqlite_native.mjs verify', 'Electron-ABI better-sqlite3 verify');
  }
}
