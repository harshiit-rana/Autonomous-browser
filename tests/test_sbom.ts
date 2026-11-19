/**
 * SBOM, licence gate and third-party notices test (Issue #260 - [PKG-03]).
 *
 * Expectations are derived from package-lock.json at run time (not hardcoded numbers):
 * - the SBOM must list every production package in the lockfile
 * - a forbidden licence must make the gate fail (fake lockfile through the real CLI)
 * - the committed THIRD_PARTY_NOTICES.md must match what the generator produces
 */

import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildSpdx,
  checkLicences,
  loadPolicy,
  productionPackages,
  readElectronRuntime,
  renderNotices,
  ROOT_DIR
} from '../scripts/supply_chain.mjs';

console.log('--- Testing SBOM, Licence Gate & Notices (#260 - [PKG-03]) ---\n');

const normalise = (s: string) => s.replace(/\r\n/g, '\n');
const lockPath = path.join(ROOT_DIR, 'package-lock.json');
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
const policy = loadPolicy();

// Independent derivation of the production set straight from the lockfile.
const expectedProd = Object.entries(lock.packages as Record<string, any>)
  .filter(([k, v]) => k !== '' && !v.dev && !v.devOptional)
  .map(([k, v]) => `${k.replace(/^.*node_modules\//, '')}@${v.version}`)
  .sort();

function testSbomCountMatchesLockfile() {
  console.log('[#260] SBOM component count equals lockfile production packages...');
  assert.ok(expectedProd.length > 0, 'lockfile must contain production packages');

  const components = productionPackages(lock);
  assert.strictEqual(components.length, expectedProd.length);
  assert.deepStrictEqual(components.map((c) => `${c.name}@${c.version}`).sort(), expectedProd);

  const runtime = readElectronRuntime(lock);
  const spdx = buildSpdx({ pkg, components, runtime, created: new Date(0).toISOString() });
  const npmEntries = spdx.packages.filter((p: any) => p.SPDXID.startsWith('SPDXRef-Npm-'));
  assert.strictEqual(npmEntries.length, expectedProd.length, 'SBOM must list every production package');
  assert.deepStrictEqual(
    npmEntries.map((p: any) => `${p.name}@${p.versionInfo}`).sort(),
    expectedProd
  );

  const electron = spdx.packages.find((p: any) => p.name === 'electron');
  assert.strictEqual(electron?.versionInfo, lock.packages['node_modules/electron'].version);
  const chromium = spdx.packages.find((p: any) => p.name === 'chromium');
  assert.ok(chromium, 'SBOM must include the Chromium runtime');
  assert.match(chromium.versionInfo, /^\d+\.\d+\.\d+\.\d+$/);

  console.log(`✓ SBOM lists ${npmEntries.length} npm packages (= lockfile production set) + Electron ${electron.versionInfo} + Chromium ${chromium.versionInfo}\n`);
}

function testRealLockfilePassesLicencePolicy() {
  console.log('[#260] Production licences pass the allowlist...');
  const violations = checkLicences(productionPackages(lock), policy);
  assert.deepStrictEqual(
    violations.map((v) => `${v.name}@${v.version}`),
    [],
    'every production licence must be allowed or an explicit reviewed exception'
  );
  console.log('✓ No production package violates the licence policy\n');
}

function testLicencePolicyUnit() {
  console.log('[#260] Licence policy rejects forbidden and undeclared licences...');
  const fake = (license: string | null) => ({ name: 'fake-pkg', version: '1.0.0', path: 'node_modules/fake-pkg', license, resolved: null, integrity: null });
  assert.strictEqual(checkLicences([fake('MIT')], policy).length, 0);
  assert.strictEqual(checkLicences([fake('MIT OR GPL-3.0')], policy).length, 0, 'OR with an allowed branch passes');
  assert.strictEqual(checkLicences([fake('MIT AND GPL-3.0')], policy).length, 1, 'AND with a forbidden branch fails');
  assert.strictEqual(checkLicences([fake('GPL-3.0')], policy).length, 1, 'copyleft GPL-3.0 fails');
  assert.strictEqual(checkLicences([fake('AGPL-3.0-only')], policy).length, 1, 'AGPL fails');
  assert.strictEqual(checkLicences([fake(null)], policy).length, 1, 'undeclared licence fails');
  console.log('✓ Policy unit cases behave as specified\n');
}

function testForbiddenLicenceFailsCli() {
  console.log('[#260] CI gate fails on a forbidden licence (fake package in a fake lockfile)...');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbom-fake-'));
  const fakeLock = {
    name: 'fake-app',
    lockfileVersion: 3,
    packages: {
      '': { name: 'fake-app', version: '0.0.1', dependencies: { 'gpl-lib': '1.0.0' } },
      'node_modules/gpl-lib': { version: '1.0.0', license: 'GPL-3.0', resolved: 'https://example.invalid/gpl-lib.tgz' }
    }
  };
  const lockFile = path.join(dir, 'package-lock.json');
  fs.writeFileSync(lockFile, JSON.stringify(fakeLock), 'utf8');
  const run = spawnSync(process.execPath, [path.join(ROOT_DIR, 'scripts', 'supply_chain.mjs'), '--lock', lockFile], { encoding: 'utf8' });
  assert.notStrictEqual(run.status, 0, 'gate must exit non-zero for GPL-3.0');
  assert.match(run.stderr, /gpl-lib@1\.0\.0/);
  assert.strictEqual(fs.existsSync(path.join(dir, 'release', 'sbom.spdx.json')), false, 'no SBOM may be written when the gate fails');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✓ Fake GPL-3.0 package makes the gate exit non-zero and writes no SBOM\n');
}

function testCommittedNoticesMatchGenerator() {
  console.log('[#260] Committed THIRD_PARTY_NOTICES.md matches the generator...');
  const components = productionPackages(lock);
  const runtime = readElectronRuntime(lock);
  const generated = renderNotices({ pkg, components, runtime, policy });
  const committed = fs.readFileSync(path.join(ROOT_DIR, 'docs', 'legal', 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.strictEqual(normalise(committed), normalise(generated), 'run node scripts/supply_chain.mjs --write-notices and commit');
  console.log('✓ Notices are in sync with package-lock.json\n');
}

function testLicenceFileMatchesPackageJson() {
  console.log('[#260] LICENSE file matches the licence declared in package.json...');
  const licence = fs.readFileSync(path.join(ROOT_DIR, 'LICENSE'), 'utf8');
  assert.strictEqual(pkg.license, 'MIT', 'package.json declares MIT');
  assert.strictEqual(licence.split(/\r?\n/)[0].trim(), 'MIT License');
  console.log('✓ LICENSE is the MIT licence declared in package.json\n');
}

testSbomCountMatchesLockfile();
testRealLockfilePassesLicencePolicy();
testLicencePolicyUnit();
testForbiddenLicenceFailsCli();
testCommittedNoticesMatchGenerator();
testLicenceFileMatchesPackageJson();

console.log('✓ All SBOM / licence / notices tests passed!');
