/**
 * Guards for the real-app e2e harness (#254): the test hooks must never ship in, or be reachable from, the product.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

// 1. No product source names the hook modules.
const own = new Set(['src/main/e2e_entry.ts', 'src/main/e2e_hooks.ts'].map(p => path.join(root, p)));
const offenders = walk(path.join(root, 'src')).filter(f => !own.has(f) && /e2e_(entry|hooks)/.test(fs.readFileSync(f, 'utf8')));
assert.deepEqual(offenders.map(f => path.relative(root, f)), [], 'no production module may import or name the e2e hooks');
console.log('ok no product module references e2e_entry / e2e_hooks');

// 2. The product entry is unchanged by the harness, and the packaged app leaves the e2e files out.
assert.equal(pkg.main, 'dist/main/index.js', 'package.json main stays the product entry');
assert.ok((pkg.build.files as string[]).includes('!dist/main/e2e_*'), 'electron-builder files must exclude dist/main/e2e_*');
console.log('ok packaged app excludes dist/main/e2e_*');

// 3. Playwright is pinned (exact), and in lock-step with the already-installed playwright-core.
assert.match(pkg.devDependencies['@playwright/test'], /^\d+\.\d+\.\d+$/, '@playwright/test must be pinned exactly');
assert.equal(pkg.dependencies['playwright-core'], pkg.devDependencies['@playwright/test'], 'playwright-core and @playwright/test must be the same version');
console.log('ok playwright versions pinned together');

// 4. The e2e entry refuses to start without AEGIS_E2E=1 (and never reaches the product entry).
const env = { ...process.env };
delete env.AEGIS_E2E;
const run = spawnSync(process.execPath, [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'src', 'main', 'e2e_entry.ts')], { env, encoding: 'utf8', timeout: 60000 });
assert.equal(run.status, 2, `e2e_entry must exit 2 without AEGIS_E2E=1, got ${run.status}: ${run.stderr}`);
assert.match(run.stderr, /AEGIS_E2E=1 is not set/);
console.log('ok e2e_entry refuses without AEGIS_E2E=1');

console.log('E2E HARNESS GUARD TESTS PASSED');
