#!/usr/bin/env node
/**
 * Fetches the Electron-ABI prebuilt of better-sqlite3 into `.native/` WITHOUT disturbing
 * the Node-ABI binary in node_modules (which tests and CI use).
 *
 *   node scripts/sqlite_native.mjs electron   -> .native/electron-abi<N>-<platform>-<arch>/better_sqlite3.node
 *   node scripts/sqlite_native.mjs verify     -> loads it inside the real Electron runtime and runs SQL (incl. FTS5)
 *
 * src/infrastructure/db.ts picks the `.native` binary automatically when running under Electron.
 * Packaged builds do not use this: electron-builder rebuilds/unpacks better-sqlite3 itself (see package.json "build").
 * There is deliberately no postinstall hook so `npm ci` never produces an Electron-only binary.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sqliteDir = path.dirname(require.resolve('better-sqlite3/package.json', { paths: [root] }));
const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const mode = process.argv[2] || 'electron';

export function nativeDir(abi) {
  return path.join(root, '.native', `electron-abi${abi}-${process.platform}-${process.arch}`);
}

function electronAbi() {
  // Electron's embedded Node ABI (NODE_MODULE_VERSION), obtained from the real runtime.
  const electronExe = require(path.join(root, 'node_modules', 'electron'));
  const r = spawnSync(electronExe, ['-e', 'process.stdout.write(process.versions.modules)'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8'
  });
  if (r.status !== 0) throw new Error(`Cannot query Electron ABI: ${r.stderr}`);
  return r.stdout.trim();
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
}

if (mode === 'electron') {
  const abi = electronAbi();
  const dest = nativeDir(abi);
  const nodeBinary = path.join(sqliteDir, 'build', 'Release', 'better_sqlite3.node');
  const backup = nodeBinary + '.node-abi.bak';
  fs.copyFileSync(nodeBinary, backup);
  try {
    const prebuild = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'prebuild-install.cmd' : 'prebuild-install');
    run(prebuild, ['--runtime', 'electron', '--target', electronVersion, '--force'], sqliteDir);
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(nodeBinary, path.join(dest, 'better_sqlite3.node'));
    console.log(`Electron ${electronVersion} (ABI ${abi}) binary stored at ${dest}`);
  } finally {
    fs.copyFileSync(backup, nodeBinary); // always restore the Node-ABI binary used by tests
    fs.rmSync(backup);
  }
} else if (mode === 'verify') {
  const abi = electronAbi();
  const binding = path.join(nativeDir(abi), 'better_sqlite3.node');
  if (!fs.existsSync(binding)) throw new Error(`Missing ${binding}; run: npm run rebuild`);
  const electronExe = require(path.join(root, 'node_modules', 'electron'));
  const script = `
    const D = require(${JSON.stringify(path.join(sqliteDir, 'lib', 'index.js'))});
    const d = new D(':memory:', { nativeBinding: ${JSON.stringify(binding)} });
    d.exec('CREATE VIRTUAL TABLE t USING fts5(a)');
    d.exec("INSERT INTO t VALUES ('hello electron')");
    const hit = d.prepare("SELECT a FROM t WHERE t MATCH 'electron'").get();
    process.stdout.write(JSON.stringify({ electron: process.versions.electron, node: process.versions.node, abi: process.versions.modules, sqlite: d.prepare('select sqlite_version() v').get().v, fts5: hit }));
  `;
  const r = spawnSync(electronExe, ['-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    process.exit(1);
  }
  console.log(r.stdout);
} else {
  console.error('usage: sqlite_native.mjs electron|verify');
  process.exit(2);
}
