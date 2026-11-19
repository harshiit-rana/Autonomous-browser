#!/usr/bin/env node

/**
 * Supply-chain gate: SBOM, licence allowlist and third-party notices (Issue #260 - [PKG-03]).
 *
 * Every number comes from package-lock.json (production = entries that are neither
 * `dev` nor `devOptional`) plus the Electron runtime that the installer actually ships.
 *
 * CLI:
 *   node scripts/supply_chain.mjs                 write release/sbom.spdx.json and fail on forbidden licences
 *   node scripts/supply_chain.mjs --write-notices also regenerate docs/legal/THIRD_PARTY_NOTICES.md
 *   node scripts/supply_chain.mjs --lock <file>   use another lockfile (used by tests with fake packages)
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

/** Lockfile entries that ship in the installer (no dev / devOptional flag). */
export function productionPackages(lock) {
  return Object.entries(lock.packages)
    .filter(([key, entry]) => key !== '' && !entry.dev && !entry.devOptional)
    .map(([key, entry]) => ({
      name: key.replace(/^.*node_modules\//, ''),
      version: entry.version,
      path: key,
      license: entry.license ?? null,
      resolved: entry.resolved ?? null,
      integrity: entry.integrity ?? null
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Reads the Electron version from the lockfile and the Chromium version from the
 * Electron binary that is installed in node_modules (process.versions.chrome).
 * Throws if the installed Electron does not match the lockfile.
 */
export function readElectronRuntime(lock, root = ROOT_DIR) {
  const entry = lock.packages['node_modules/electron'];
  if (!entry) throw new Error('package-lock.json has no node_modules/electron entry');
  const electronDir = path.join(root, 'node_modules', 'electron');
  const pathTxt = path.join(electronDir, 'path.txt');
  if (!fs.existsSync(pathTxt)) {
    throw new Error('Electron binary is not installed (node_modules/electron/path.txt missing); run npm ci');
  }
  const binary = path.join(electronDir, 'dist', fs.readFileSync(pathTxt, 'utf8').trim());
  const installed = fs.readFileSync(path.join(electronDir, 'dist', 'version'), 'utf8').trim();
  if (installed !== entry.version) {
    throw new Error(`Installed Electron ${installed} does not match lockfile ${entry.version}`);
  }
  const run = spawnSync(binary, ['-p', 'process.versions.chrome'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 60000
  });
  const chromium = (run.stdout || '').trim().split(/\r?\n/).pop();
  if (run.status !== 0 || !/^\d+\.\d+\.\d+\.\d+$/.test(chromium || '')) {
    throw new Error(`Could not read Chromium version from ${binary}: ${run.stderr || run.error}`);
  }
  return {
    electron: { name: 'electron', version: entry.version, license: entry.license ?? null },
    chromium: { name: 'chromium', version: chromium }
  };
}

/** Evaluates a single SPDX identifier or a flat "A OR B" / "A AND B" expression. */
function isAllowedAtom(id, policy) {
  return policy.allowed.includes(id.trim());
}

export function isAllowedLicence(expr, policy) {
  if (!expr) return false;
  let e = expr.trim();
  while (e.startsWith('(') && e.endsWith(')')) e = e.slice(1, -1).trim();
  if (/[()]/.test(e)) return false; // nested expressions are not evaluated; treat as unknown
  if (/\s+OR\s+/.test(e)) return e.split(/\s+OR\s+/).some((p) => isAllowedLicence(p, policy));
  if (/\s+AND\s+/.test(e)) return e.split(/\s+AND\s+/).every((p) => isAllowedLicence(p, policy));
  return isAllowedAtom(e, policy);
}

/**
 * Returns the list of production components that violate the licence policy.
 * A component passes if its licence expression is allowed, or if an explicit,
 * reviewed exception names its exact name, version and licence.
 */
export function checkLicences(components, policy) {
  const violations = [];
  for (const c of components) {
    if (!c.license) {
      violations.push({ ...c, reason: 'no licence declared' });
      continue;
    }
    if (isAllowedLicence(c.license, policy)) continue;
    const exc = (policy.exceptions || []).find(
      (x) => x.name === c.name && x.version === c.version && x.license === c.license
    );
    if (exc) continue;
    violations.push({ ...c, reason: `licence "${c.license}" is not on the allowlist` });
  }
  return violations;
}

export function loadPolicy(file = path.join(ROOT_DIR, 'scripts', 'licence_policy.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha512Hex(integrity) {
  const m = /^sha512-(.+)$/.exec(integrity || '');
  return m ? Buffer.from(m[1], 'base64').toString('hex') : null;
}

export function buildSpdx({ pkg, components, runtime, created }) {
  const packages = [
    {
      name: pkg.name,
      SPDXID: 'SPDXRef-Package-AutonomousBrowser',
      versionInfo: pkg.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: pkg.license,
      licenseDeclared: pkg.license,
      copyrightText: 'NOASSERTION'
    }
  ];
  components.forEach((c, i) => {
    const checksum = sha512Hex(c.integrity);
    packages.push({
      name: c.name,
      SPDXID: `SPDXRef-Npm-${i}`,
      versionInfo: c.version,
      downloadLocation: c.resolved || 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: c.license || 'NOASSERTION',
      licenseDeclared: c.license || 'NOASSERTION',
      copyrightText: 'NOASSERTION',
      externalRefs: [
        { referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: `pkg:npm/${encodeURIComponent(c.name).replace('%2F', '/')}@${c.version}` }
      ],
      ...(checksum ? { checksums: [{ algorithm: 'SHA512', checksumValue: checksum }] } : {})
    });
  });
  packages.push({
    name: 'electron',
    SPDXID: 'SPDXRef-Runtime-Electron',
    versionInfo: runtime.electron.version,
    downloadLocation: 'https://github.com/electron/electron',
    filesAnalyzed: false,
    licenseConcluded: runtime.electron.license || 'NOASSERTION',
    licenseDeclared: runtime.electron.license || 'NOASSERTION',
    copyrightText: 'NOASSERTION',
    comment: 'Shipped runtime (devDependency in package.json, bundled by electron-builder).'
  });
  packages.push({
    name: 'chromium',
    SPDXID: 'SPDXRef-Runtime-Chromium',
    versionInfo: runtime.chromium.version,
    downloadLocation: 'https://www.chromium.org/',
    filesAnalyzed: false,
    licenseConcluded: 'NOASSERTION',
    licenseDeclared: 'NOASSERTION',
    copyrightText: 'NOASSERTION',
    comment: 'Read from process.versions.chrome of the installed Electron. Licences: node_modules/electron/dist/LICENSES.chromium.html.'
  });
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: pkg.name,
    documentNamespace: `https://spdx.org/spdxdocs/${pkg.name}-${pkg.version}-${created.replace(/[^0-9A-Za-z]/g, '')}`,
    creationInfo: {
      creators: ['Tool: scripts/supply_chain.mjs', `Person: ${pkg.author}`],
      created
    },
    documentDescribes: ['SPDXRef-Package-AutonomousBrowser'],
    packages,
    relationships: packages
      .slice(1)
      .map((p) => ({ spdxElementId: 'SPDXRef-Package-AutonomousBrowser', relationshipType: 'DEPENDS_ON', relatedSpdxElement: p.SPDXID }))
  };
}

/** Deterministic Markdown notices (no timestamps) so the committed file can be drift-checked. */
export function renderNotices({ pkg, components, runtime, policy }) {
  const rows = components
    .map((c) => `| ${c.name} | ${c.version} | ${c.license} |`)
    .join('\n');
  const exceptionNote = (policy.exceptions || []).length
    ? '\n\nReviewed exceptions (open decision, see `scripts/licence_policy.json`):\n\n' +
      policy.exceptions.map((x) => `- ${x.name}@${x.version} (${x.license}): ${x.reason}`).join('\n')
    : '';
  return `# Third-Party Notices

Autonomous Browser (\`${pkg.name}\` ${pkg.version}) is licensed under the ${pkg.license} License (see \`LICENSE\`).

This file is generated by \`scripts/supply_chain.mjs\` from \`package-lock.json\`. Do not edit it by hand.

Legal status: this is an engineering inventory, **not legal advice**. Licence compatibility and redistribution obligations require counsel review (Issue #260).

## Shipped runtime

| Component | Version | Licence |
|---|---|---|
| Electron | ${runtime.electron.version} | ${runtime.electron.license} |
| Chromium | ${runtime.chromium.version} | See \`LICENSES.chromium.html\` shipped inside the Electron distribution |

## Production npm dependencies (${components.length})

Licence values are the \`license\` field recorded in \`package-lock.json\`. Allowed licences: ${policy.allowed.join(', ')}.

| Package | Version | Licence |
|---|---|---|
${rows}${exceptionNote}
`;
}

export function generateSbom({ lockPath = path.join(ROOT_DIR, 'package-lock.json'), root = ROOT_DIR, policy = loadPolicy(), runtime } = {}) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const components = productionPackages(lock);
  const violations = checkLicences(components, policy);
  const rt = runtime ?? readElectronRuntime(lock, root);
  return { lock, pkg, components, violations, runtime: rt, policy };
}

function main(argv) {
  const lockIdx = argv.indexOf('--lock');
  const lockPath = lockIdx >= 0 ? path.resolve(argv[lockIdx + 1]) : path.join(ROOT_DIR, 'package-lock.json');
  const root = lockIdx >= 0 ? path.dirname(lockPath) : ROOT_DIR;
  const policy = loadPolicy();

  // Licence gate first: a forbidden licence fails the run before anything is written.
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const components = productionPackages(lock);
  const violations = checkLicences(components, policy);
  if (violations.length > 0) {
    console.error(`[LICENCE] ${violations.length} production package(s) fail the licence policy:`);
    for (const v of violations) console.error(`  - ${v.name}@${v.version}: ${v.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ Licence policy: ${components.length} production packages, all allowed or reviewed.`);

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const runtime = readElectronRuntime(lock, root);
  const sbom = buildSpdx({ pkg, components, runtime, created: new Date().toISOString() });

  // Honesty gate: the SBOM must list every production package in the lockfile.
  const npmPackages = sbom.packages.filter((p) => p.SPDXID.startsWith('SPDXRef-Npm-'));
  if (npmPackages.length !== components.length) {
    throw new Error(`SBOM lists ${npmPackages.length} npm packages but lockfile has ${components.length} production packages`);
  }

  const sbomDir = path.join(root, 'release');
  fs.mkdirSync(sbomDir, { recursive: true });
  const sbomPath = path.join(sbomDir, 'sbom.spdx.json');
  fs.writeFileSync(sbomPath, JSON.stringify(sbom, null, 2), 'utf8');
  console.log(`✓ SPDX SBOM written to ${sbomPath}: ${npmPackages.length} npm packages + Electron ${runtime.electron.version} + Chromium ${runtime.chromium.version}`);

  if (argv.includes('--write-notices')) {
    const noticesPath = path.join(root, 'docs', 'legal', 'THIRD_PARTY_NOTICES.md');
    fs.writeFileSync(noticesPath, renderNotices({ pkg, components, runtime, policy }), 'utf8');
    console.log(`✓ Third-party notices written to ${noticesPath}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
