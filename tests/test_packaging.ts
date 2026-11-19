/**
 * Packaging pipeline tests (Issue #258 - [PKG-01]).
 *
 * Everything here runs against real artifacts: a real Electron binary gets its fuses flipped and
 * read back, the real preload bundle step (scripts/bundle_preload.mjs) is run and its output executed under a sandbox-style `require`,
 * and the real icon files are parsed. The packaged-app launch itself is covered by
 * scripts/smoke_packaged.mjs (release workflow), because it needs a full electron-builder run.
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { applyFuses, verifyFuses } from '../scripts/fuses.mjs';
import { findPackagedApp, FuseV1Options, getFuseSet, resolveFuseTarget, resolveLaunchBinary } from '../scripts/packaging.mjs';
import { assertPrepack, collectProblems, longestRelativePath } from '../scripts/assert_prepack.mjs';

const ROOT = path.resolve(process.cwd());
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg01-'));

function mkProject(opts: { renderer?: boolean; badAsset?: boolean; icons?: boolean; deepPath?: string } = {}): string {
  const { renderer = true, badAsset = false, icons = true, deepPath } = opts;
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'proj-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', main: 'dist/main/index.js' }));
  fs.mkdirSync(path.join(dir, 'dist', 'main'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'main', 'index.js'), '');
  fs.writeFileSync(path.join(dir, 'dist', 'main', 'preload.js'), '');
  if (renderer) {
    fs.mkdirSync(path.join(dir, 'dist', 'renderer', 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'renderer', 'assets', 'a.js'), '');
    const asset = badAsset ? './assets/missing.js' : './assets/a.js';
    fs.writeFileSync(path.join(dir, 'dist', 'renderer', 'index.html'), `<html><script type="module" src="${asset}"></script></html>`);
  }
  if (icons) {
    fs.mkdirSync(path.join(dir, 'build'));
    for (const f of ['icon.ico', 'icon.icns', 'icon.png']) fs.writeFileSync(path.join(dir, 'build', f), 'x');
  }
  if (deepPath) fs.mkdirSync(path.join(dir, 'node_modules', deepPath), { recursive: true });
  return dir;
}

function electronBinaryCopy(): string {
  const distDir = path.join(ROOT, 'node_modules', 'electron', 'dist');
  const out = fs.mkdtempSync(path.join(tmpRoot, 'bin-'));
  if (process.platform === 'darwin') {
    const fw = path.join(distDir, 'Electron.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework');
    const app = path.join(out, 'Test.app');
    const dst = path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(fw, dst); // the fuse wire lives in this binary
    return app;
  }
  const exe = path.join(distDir, process.platform === 'win32' ? 'electron.exe' : 'electron');
  const dst = path.join(out, path.basename(exe));
  fs.copyFileSync(exe, dst);
  return dst;
}

async function testFusesRealBinary() {
  console.log('[#258] Flip fuses on a real Electron binary and read them back...');
  const target = electronBinaryCopy();

  const before = await verifyFuses(target);
  assert.strictEqual(before.ok, false, 'stock Electron must NOT pass verification');
  assert.ok(before.problems[0].includes('RunAsNode'), `RunAsNode must be reported first, got: ${before.problems[0]}`);

  await applyFuses(target);
  const after = await verifyFuses(target);
  assert.deepStrictEqual(after.problems, [], 'hardened binary must pass');
  const want = getFuseSet(process.platform) as Record<number, boolean>;
  for (const row of after.rows) assert.strictEqual(typeof row.actual, 'boolean');
  assert.strictEqual(after.rows.find((r: any) => r.name === 'RunAsNode')?.actual, false);
  assert.strictEqual(after.rows.find((r: any) => r.name === 'EnableCookieEncryption')?.actual, true);
  assert.strictEqual(after.rows.length, Object.keys(want).length);

  // Re-enabling RunAsNode must make verification fail loudly (the CI step relies on this).
  await applyFuses(target, process.platform, { [FuseV1Options.RunAsNode]: true });
  const tampered = await verifyFuses(target);
  assert.strictEqual(tampered.ok, false);
  assert.ok(/RunAsNode fuse is ENABLED/.test(tampered.problems[0]));
  console.log('✓ real binary: stock fails, hardened passes, re-enabled RunAsNode fails');
}

function testFuseSetPerPlatform() {
  console.log('[#258] Fuse set per platform...');
  for (const p of ['win32', 'darwin', 'linux']) {
    const set = getFuseSet(p) as Record<number, boolean>;
    assert.strictEqual(set[FuseV1Options.RunAsNode], false, `${p}: RunAsNode must be off`);
    assert.strictEqual(set[FuseV1Options.EnableCookieEncryption], true, `${p}: cookie encryption on`);
    assert.strictEqual(set[FuseV1Options.OnlyLoadAppFromAsar], true);
    assert.strictEqual(set[FuseV1Options.EnableNodeCliInspectArguments], false);
    assert.strictEqual(set[FuseV1Options.EnableNodeOptionsEnvironmentVariable], false);
    assert.strictEqual(set[FuseV1Options.GrantFileProtocolExtraPrivileges], true, `${p}: file protocol privileges needed to load app.asar renderer`);
  }
  // asar integrity is unsupported on Linux: must not be forced there, must be on for win/mac
  assert.strictEqual((getFuseSet('linux') as any)[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], undefined);
  assert.strictEqual((getFuseSet('win32') as any)[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], true);
  assert.strictEqual((getFuseSet('darwin') as any)[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], true);
  console.log('✓ fuse sets');
}

function testExecutablePaths() {
  console.log('[#258] Per-platform executable resolution...');
  assert.strictEqual(resolveFuseTarget('/o', 'win32', 'App X', undefined), path.join('/o', 'App X.exe'));
  assert.strictEqual(resolveFuseTarget('/o', 'darwin', 'App X', undefined), path.join('/o', 'App X.app'));
  assert.strictEqual(resolveFuseTarget('/o', 'linux', 'App X', 'app-x'), path.join('/o', 'app-x'));
  assert.strictEqual(
    resolveLaunchBinary('/o', 'darwin', 'App X', undefined),
    path.join('/o', 'App X.app', 'Contents', 'MacOS', 'App X')
  );
  assert.throws(() => findPackagedApp(path.join(tmpRoot, 'no-release'), 'win32'), /No packaged win32 app found/);
  console.log('✓ executable paths and missing-release error');
}

function testPrepack() {
  console.log('[#258] Pre-pack assertions (missing renderer, bad assets, icons, long paths)...');
  assert.deepStrictEqual(collectProblems(mkProject(), { platform: 'linux' }), []);
  assert.doesNotThrow(() => assertPrepack(mkProject(), { platform: 'linux' }));

  const noRenderer = collectProblems(mkProject({ renderer: false }), { platform: 'linux' });
  assert.strictEqual(noRenderer.length, 1);
  assert.ok(noRenderer[0].includes('dist/renderer/index.html is missing') && noRenderer[0].includes('vite build') === false && noRenderer[0].includes('npm run build'));
  assert.throws(() => assertPrepack(mkProject({ renderer: false }), { platform: 'linux' }), /Pre-pack check failed/);

  const badAsset = collectProblems(mkProject({ badAsset: true }), { platform: 'linux' });
  assert.ok(badAsset.some((p: string) => p.includes('assets/missing.js')), 'dangling asset reference must be reported');

  // an unbundled preload (relative require) must be rejected
  const rawPreload = mkProject();
  fs.writeFileSync(path.join(rawPreload, 'dist', 'main', 'preload.js'), 'const c = require("../ipc/contract.js");');
  assert.ok(collectProblems(rawPreload, { platform: 'linux' }).some((p: string) => p.includes('still requires relative modules')));

  // migrations present in src but not copied to dist must be rejected
  const noMig = mkProject();
  fs.mkdirSync(path.join(noMig, 'src', 'infrastructure', 'migrations'), { recursive: true });
  assert.ok(collectProblems(noMig, { platform: 'linux' }).some((p: string) => p.includes('migrations has no .sql')));
  fs.mkdirSync(path.join(noMig, 'dist', 'infrastructure', 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(noMig, 'dist', 'infrastructure', 'migrations', '001.sql'), '');
  assert.deepStrictEqual(collectProblems(noMig, { platform: 'linux' }), []);

  const noIcons = collectProblems(mkProject({ icons: false }), { platform: 'linux' });
  assert.strictEqual(noIcons.length, 3);

  // Windows long paths: a very deep node_modules entry must trip the budget on win32 only
  const deep = mkProject({ deepPath: Array.from({ length: 6 }, (_, i) => `very-long-directory-name-${i}-xxxxxxxxxxxxxxxxxx`).join('/') });
  const longest = longestRelativePath(deep, ['dist', 'node_modules']);
  assert.ok(longest.length > 200, `deep path should be long, was ${longest.length}`);
  const winProblems = collectProblems(deep, { platform: 'win32' });
  assert.ok(winProblems.some((p: string) => p.includes('Windows budget')), 'win32 must flag long paths');
  assert.deepStrictEqual(collectProblems(deep, { platform: 'linux' }), [], 'linux has no MAX_PATH problem');
  console.log('✓ pre-pack assertions');
}

async function testPreloadBundleWorksInSandbox() {
  console.log('[#258] Preload must load under a sandbox-style require (only electron allowed)...');
  const work = path.join(tmpRoot, 'preload-work');
  fs.mkdirSync(work, { recursive: true });
  const tscBin = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  // Compile just the preload (and what it imports) exactly like the app build does: CommonJS, relative requires.
  execFileSync(process.execPath, [
    tscBin, path.join(ROOT, 'src', 'main', 'preload.ts'), '--outDir', path.join(work, 'dist'), '--rootDir', path.join(ROOT, 'src'),
    '--module', 'commonjs', '--moduleResolution', 'node', '--target', 'ES2022', '--esModuleInterop', '--skipLibCheck', '--lib', 'ES2022,DOM'
  ], { cwd: ROOT, stdio: 'pipe' });
  const preloadFile = path.join(work, 'dist', 'main', 'preload.js');

  const exposed: Record<string, any> = {};
  const sandboxRequire = (id: string) => {
    if (id === 'electron') {
      return {
        contextBridge: { exposeInMainWorld: (k: string, v: any) => (exposed[k] = v) },
        ipcRenderer: { invoke: async () => undefined, on() {}, removeListener() {}, send() {} }
      };
    }
    throw new Error(`sandboxed preload cannot require "${id}"`);
  };
  const runInSandbox = (file: string) => {
    const module = { exports: {} as any };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: sandboxRequire, module, exports: module.exports, process: { platform: process.platform, env: {} }, console });
  };

  // Regression proof: the raw tsc output cannot load in the sandbox, so window.aegis would be missing.
  assert.throws(() => runInSandbox(preloadFile), /sandboxed preload cannot require/);
  assert.strictEqual(exposed.aegis, undefined);

  // The project's bundle step (run in the temp tree because it uses cwd-relative dist/main/preload.js) fixes it.
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'bundle_preload.mjs')], { cwd: work, stdio: 'pipe' });
  runInSandbox(preloadFile);
  assert.strictEqual(typeof exposed.aegis, 'object', 'window.aegis must be exposed after bundling');
  assert.strictEqual(typeof exposed.aegis.minimize, 'function');

  // And the pre-pack check would have caught the unbundled file.
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'x', main: 'dist/main/index.js' }));
  fs.writeFileSync(path.join(work, 'dist', 'main', 'index.js'), '');
  const bundled = collectProblems(work, { platform: 'linux' }).filter((p: string) => p.includes('preload.js'));
  assert.deepStrictEqual(bundled, [], 'bundled preload must pass the pre-pack check');
  console.log('✓ preload: raw tsc output fails in the sandbox, bundled output exposes window.aegis');
}

function testPngIcoIcns() {
  console.log('[#258] Parse committed icons...');
  const dir = path.join(ROOT, 'build');
  const png = fs.readFileSync(path.join(dir, 'icon.png'));
  assert.strictEqual(png.subarray(1, 4).toString('ascii'), 'PNG');
  assert.strictEqual(png.readUInt32BE(16), 1024);
  assert.strictEqual(png.readUInt32BE(20), 1024);

  const ico = fs.readFileSync(path.join(dir, 'icon.ico'));
  assert.strictEqual(ico.readUInt16LE(0), 0);
  assert.strictEqual(ico.readUInt16LE(2), 1);
  const count = ico.readUInt16LE(4);
  const sizes: number[] = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const w = ico[e] === 0 ? 256 : ico[e];
    const len = ico.readUInt32LE(e + 8);
    const off = ico.readUInt32LE(e + 12);
    assert.strictEqual(ico.subarray(off + 1, off + 4).toString('ascii'), 'PNG', 'ico entry must hold a PNG');
    assert.strictEqual(ico.readUInt32BE(off + 16), w, 'ico entry dimension matches directory');
    assert.ok(off + len <= ico.length);
    sizes.push(w);
  }
  assert.ok(sizes.includes(256) && sizes.includes(16) && sizes.includes(48), `ico sizes: ${sizes}`);

  const icns = fs.readFileSync(path.join(dir, 'icon.icns'));
  assert.strictEqual(icns.subarray(0, 4).toString('ascii'), 'icns');
  assert.strictEqual(icns.readUInt32BE(4), icns.length);
  let pos = 8;
  const types: string[] = [];
  while (pos < icns.length) {
    types.push(icns.subarray(pos, pos + 4).toString('ascii'));
    pos += icns.readUInt32BE(pos + 4);
  }
  assert.strictEqual(pos, icns.length, 'icns chunks must tile the file exactly');
  assert.ok(types.includes('ic10'), 'icns needs the 1024px entry');
  console.log('✓ icons valid');
}

async function testConfigAndScripts() {
  console.log('[#258] electron-builder config and npm script wiring...');
  const b = pkg.build;
  const afterPack = path.join(ROOT, b.afterPack);
  assert.ok(fs.existsSync(afterPack), 'afterPack hook file exists');
  const mod = await import(pathToFileURL(afterPack).href);
  assert.strictEqual(typeof mod.default, 'function');
  for (const f of [b.win.icon, b.mac.icon, b.linux.icon, b.mac.entitlements]) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
  assert.strictEqual(b.nsis.oneClick, false);
  assert.strictEqual(b.nsis.deleteAppDataOnUninstall, false, 'uninstaller must keep user data');
  assert.strictEqual(b.mac.hardenedRuntime, true);
  assert.deepStrictEqual(b.linux.target.sort(), ['AppImage', 'deb']);
  assert.ok(b.deb.depends.includes('libsecret-1-0'), 'deb must depend on libsecret for safeStorage');
  assert.strictEqual(b.extraMetadata?.version, undefined, 'version must come from package.json only');
  assert.ok(/^tsc -b && vite build && vite build --config vite\.preload\.config\.ts$/.test(pkg.scripts.build));

  // Every `npm run <script>` referenced by the release workflow and the releasing doc must exist.
  const referenced: Array<[string, string]> = [];
  for (const file of ['.github/workflows/release.yml', 'docs/RELEASING.md']) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of text.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) referenced.push([file, m[1]]);
  }
  assert.ok(referenced.length > 0);
  for (const [file, script] of referenced) {
    assert.ok(pkg.scripts[script], `${file} references missing npm script "${script}"`);
  }
  console.log(`✓ config valid; ${referenced.length} workflow/doc script references resolve`);
}

async function main() {
  console.log('--- Testing packaging pipeline (#258 - [PKG-01]) ---\n');
  try {
    testFuseSetPerPlatform();
    testExecutablePaths();
    testPrepack();
    testPngIcoIcns();
    await testConfigAndScripts();
    await testPreloadBundleWorksInSandbox();
    await testFusesRealBinary();
    console.log('\nAll packaging tests passed.');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
