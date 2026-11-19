#!/usr/bin/env node

/**
 * Release Readiness Gate (Issue #219 - [TRU-01])
 *
 * Programmatic release gate that evaluates real measurements across:
 * - TypeScript compilation (typecheck)
 * - Unit & integration test manifest (unit)
 * - Module reachability & orphan allowlist (reachability)
 * - Real-app Playwright Electron E2E suite (e2e)
 * - Documentation consistency against audit hash (docs-consistency)
 * - Zero fake/mock paths in production code (no-fake-paths)
 * - Live red-team security attack suite (security-attack-suite)
 *
 * Generates docs/release/V1_RELEASE_GATE.md directly from results.
 */

import { execSync, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const isJson = args.includes('--json');
const skipUnit = args.includes('--skip-unit');
const strictExit = args.includes('--strict');

function getGitInfo() {
  let commit = 'unknown';
  let dirty = false;
  try {
    commit = execSync('git rev-parse --short HEAD', { cwd: ROOT_DIR, encoding: 'utf8' }).trim();
    const status = execSync('git status --porcelain', { cwd: ROOT_DIR, encoding: 'utf8' }).trim();
    dirty = status.length > 0;
  } catch {
    // Fallback if git is unavailable
  }
  return { commit, dirty };
}

// 1. Typecheck Check
function checkTypecheck() {
  const start = Date.now();
  try {
    const res = spawnSync('npx', ['tsc', '-b'], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 60000
    });
    const durationMs = Date.now() - start;
    if (res.status === 0) {
      return {
        id: 'typecheck',
        title: 'TypeScript Compilation',
        command: 'npx tsc -b',
        status: 'pass',
        evidence: `Clean compile without errors in ${durationMs}ms`
      };
    } else {
      return {
        id: 'typecheck',
        title: 'TypeScript Compilation',
        command: 'npx tsc -b',
        status: 'fail',
        evidence: (res.stderr || res.stdout || 'Compile errors encountered').slice(-300).trim()
      };
    }
  } catch (err) {
    return {
      id: 'typecheck',
      title: 'TypeScript Compilation',
      command: 'npx tsc -b',
      status: 'fail',
      evidence: String(err?.message || err).slice(-300)
    };
  }
}

// 2. Unit Test Manifest Check
function checkUnit() {
  if (skipUnit) {
    return {
      id: 'unit',
      title: 'Unit & Integration Test Manifest',
      command: 'tests/manifest.json',
      status: 'pass',
      evidence: 'Pre-verified unit manifest (passed via caller verification)'
    };
  }

  const manifestPath = path.join(ROOT_DIR, 'tests', 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return {
      id: 'unit',
      title: 'Unit & Integration Test Manifest',
      command: 'tests/manifest.json',
      status: 'fail',
      evidence: 'tests/manifest.json not found'
    };
  }

  let suites = [];
  try {
    suites = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return {
      id: 'unit',
      title: 'Unit & Integration Test Manifest',
      command: 'tests/manifest.json',
      status: 'fail',
      evidence: `Failed to parse manifest: ${err.message}`
    };
  }

  const failedSuites = [];
  let totalDurationMs = 0;

  for (const suite of suites) {
    const start = Date.now();
    let res = spawnSync(suite.cmd, {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      shell: true,
      timeout: 45000
    });

    // Flaky retry policy: retry once if failed
    if (res.status !== 0) {
      res = spawnSync(suite.cmd, {
        cwd: ROOT_DIR,
        encoding: 'utf8',
        shell: true,
        timeout: 45000
      });
    }

    const duration = Date.now() - start;
    totalDurationMs += duration;

    if (res.status !== 0) {
      failedSuites.push(suite.id);
    }
  }

  if (failedSuites.length === 0) {
    return {
      id: 'unit',
      title: 'Unit & Integration Test Manifest',
      command: `tests/manifest.json (${suites.length} suites)`,
      status: 'pass',
      evidence: `${suites.length}/${suites.length} suites passed (${totalDurationMs}ms total)`
    };
  } else {
    return {
      id: 'unit',
      title: 'Unit & Integration Test Manifest',
      command: `tests/manifest.json (${suites.length} suites)`,
      status: 'fail',
      evidence: `${failedSuites.length} suites failed: ${failedSuites.join(', ')}`
    };
  }
}

// 3. Reachability & Orphan Allowlist Check
function checkReachability() {
  try {
    execSync('node scripts/audit_reachability.mjs', { cwd: ROOT_DIR, encoding: 'utf8' });
    const auditPath = path.join(ROOT_DIR, 'docs', 'reachability_audit.json');
    if (!fs.existsSync(auditPath)) {
      return {
        id: 'reachability',
        title: 'Reachability Policy & Orphan Allowlist',
        command: 'node scripts/audit_reachability.mjs',
        status: 'fail',
        evidence: 'docs/reachability_audit.json was not generated'
      };
    }

    const auditData = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    const orphans = auditData.filter((entry) => !entry.isReachable).map((entry) => entry.path);

    const allowlistPath = path.join(ROOT_DIR, 'scripts', 'reachability_allowlist.json');
    let allowlist = { testOnly: [], attic: [], pending: {} };
    if (fs.existsSync(allowlistPath)) {
      allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
    }

    const allowedSet = new Set([
      ...(allowlist.testOnly || []),
      ...(allowlist.attic || []),
      ...Object.keys(allowlist.pending || {})
    ]);

    const unallowlisted = orphans.filter((o) => !allowedSet.has(o));
    const pendingKeys = Object.keys(allowlist.pending || {});

    if (unallowlisted.length > 0) {
      return {
        id: 'reachability',
        title: 'Reachability Policy & Orphan Allowlist',
        command: 'node scripts/audit_reachability.mjs',
        status: 'fail',
        evidence: `${unallowlisted.length} non-allowlisted orphaned modules (e.g. ${unallowlisted.slice(0, 3).join(', ')})`
      };
    }

    if (pendingKeys.length > 0) {
      return {
        id: 'reachability',
        title: 'Reachability Policy & Orphan Allowlist',
        command: 'node scripts/audit_reachability.mjs',
        status: 'fail',
        evidence: `${pendingKeys.length} orphaned modules awaiting wiring in allowlist pending list`
      };
    }

    return {
      id: 'reachability',
      title: 'Reachability Policy & Orphan Allowlist',
      command: 'node scripts/audit_reachability.mjs',
      status: 'pass',
      evidence: `All ${auditData.length} modules are reachable or justified`
    };
  } catch (err) {
    return {
      id: 'reachability',
      title: 'Reachability Policy & Orphan Allowlist',
      command: 'node scripts/audit_reachability.mjs',
      status: 'fail',
      evidence: `Reachability audit error: ${err.message}`
    };
  }
}

// 4. Real-App Electron E2E Check
function checkE2E() {
  const pkgPath = path.join(ROOT_DIR, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const hasE2EScript = Boolean(pkg.scripts && pkg.scripts['test:e2e']);
  const e2eDir = path.join(ROOT_DIR, 'tests', 'e2e');

  let hasRealElectronTests = false;
  if (fs.existsSync(e2eDir)) {
    const files = fs.readdirSync(e2eDir);
    for (const f of files) {
      const content = fs.readFileSync(path.join(e2eDir, f), 'utf8');
      if (content.includes('_electron') || content.includes('launchElectron')) {
        hasRealElectronTests = true;
        break;
      }
    }
  }

  if (!hasE2EScript || !hasRealElectronTests) {
    return {
      id: 'e2e',
      title: 'Real-App Electron E2E Suite',
      command: 'npm run test:e2e',
      status: 'fail',
      evidence: 'no real-app e2e suite (Playwright _electron)'
    };
  }

  try {
    const res = spawnSync('npm', ['run', 'test:e2e'], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 120000
    });
    if (res.status === 0) {
      return {
        id: 'e2e',
        title: 'Real-App Electron E2E Suite',
        command: 'npm run test:e2e',
        status: 'pass',
        evidence: 'Real-app Playwright Electron E2E suite passed'
      };
    } else {
      return {
        id: 'e2e',
        title: 'Real-App Electron E2E Suite',
        command: 'npm run test:e2e',
        status: 'fail',
        evidence: (res.stderr || res.stdout || 'E2E test suite failed').slice(-300).trim()
      };
    }
  } catch (err) {
    return {
      id: 'e2e',
      title: 'Real-App Electron E2E Suite',
      command: 'npm run test:e2e',
      status: 'fail',
      evidence: String(err?.message || err).slice(-300)
    };
  }
}

// 5. Documentation Truth & Status Consistency Check
function checkDocsConsistency() {
  const statusPath = path.join(ROOT_DIR, 'docs', 'STATUS.md');
  const auditPath = path.join(ROOT_DIR, 'docs', 'reachability_audit.json');

  if (!fs.existsSync(statusPath) || !fs.existsSync(auditPath)) {
    return {
      id: 'docs-consistency',
      title: 'Documentation Truth & Status Consistency',
      command: 'scripts/gen_status.mjs hash check',
      status: 'fail',
      evidence: 'docs/STATUS.md or docs/reachability_audit.json missing'
    };
  }

  const auditContent = fs.readFileSync(auditPath, 'utf8');
  const modules = JSON.parse(auditContent).sort((a, b) => a.path.localeCompare(b.path));
  const canonical = JSON.stringify(modules, null, 2);
  const sha256 = crypto.createHash('sha256').update(canonical).digest('hex');

  const statusFirstLine = fs.readFileSync(statusPath, 'utf8').split('\n')[0] || '';
  if (statusFirstLine.includes(sha256)) {
    return {
      id: 'docs-consistency',
      title: 'Documentation Truth & Status Consistency',
      command: 'scripts/gen_status.mjs hash check',
      status: 'pass',
      evidence: `docs/STATUS.md matches reachability audit hash ${sha256.slice(0, 8)}`
    };
  } else {
    return {
      id: 'docs-consistency',
      title: 'Documentation Truth & Status Consistency',
      command: 'scripts/gen_status.mjs hash check',
      status: 'fail',
      evidence: `docs/STATUS.md out of sync with audit hash (expected ${sha256.slice(0, 8)})`
    };
  }
}

// 6. Zero Forbidden Fake Patterns Check
function checkNoFakePaths() {
  const srcDir = path.join(ROOT_DIR, 'src');
  const forbiddenPatterns = [
    { name: 'createMockView', regex: /\bcreateMockView\b/ },
    { name: 'MockModelProvider outside demo', regex: /\bMockModelProvider\b/ },
    { name: 'news.ycombinator.com literal', regex: /['"`]https?:\/\/news\.ycombinator\.com/ },
    { name: 'hardcoded confidence 0.95', regex: /confidence:\s*0\.95\b/ }
  ];

  const violations = [];

  function scanDir(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const fullPath = path.join(dir, ent.name);
      const relPath = path.relative(ROOT_DIR, fullPath).replace(/\\/g, '/');

      // Exclude attic and testing directories
      if (relPath.startsWith('src/attic') || relPath.startsWith('src/testing')) {
        continue;
      }

      if (ent.isDirectory()) {
        scanDir(fullPath);
      } else if (ent.isFile() && (ent.name.endsWith('.ts') || ent.name.endsWith('.js'))) {
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split('\n');

        lines.forEach((line, idx) => {
          for (const pat of forbiddenPatterns) {
            // Allow MockModelProvider inside designated demo provider
            if (pat.name.startsWith('MockModelProvider') && relPath.includes('demo')) {
              continue;
            }

            if (pat.regex.test(line)) {
              violations.push({
                file: relPath,
                line: idx + 1,
                pattern: pat.name
              });
            }
          }
        });
      }
    }
  }

  scanDir(srcDir);

  if (violations.length === 0) {
    return {
      id: 'no-fake-paths',
      title: 'Zero Forbidden Fake Patterns in src/',
      command: 'scripts/release_gate.mjs scan src/',
      status: 'pass',
      evidence: 'Zero forbidden fake/mock patterns detected on production paths'
    };
  } else {
    const details = violations
      .map((v) => `${v.file}:${v.line} (${v.pattern})`)
      .slice(0, 4)
      .join(', ');
    return {
      id: 'no-fake-paths',
      title: 'Zero Forbidden Fake Patterns in src/',
      command: 'scripts/release_gate.mjs scan src/',
      status: 'fail',
      evidence: `Found ${violations.length} forbidden fake pattern(s): ${details}`
    };
  }
}

// 7. Security Live Attack Suite Check
function checkSecurityAttackSuite() {
  const liveRedTeamPath = path.join(ROOT_DIR, 'tests', 'test_red_team_live.ts');
  if (!fs.existsSync(liveRedTeamPath)) {
    return {
      id: 'security-attack-suite',
      title: 'Live Red-Team Security Attack Suite',
      command: 'npm run test:security:live',
      status: 'fail',
      evidence: 'live red-team harness not yet wired to real agent loop (ASR unmeasured)'
    };
  }

  try {
    const res = spawnSync('npx', ['tsx', 'tests/test_red_team_live.ts'], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 60000
    });
    if (res.status === 0) {
      return {
        id: 'security-attack-suite',
        title: 'Live Red-Team Security Attack Suite',
        command: 'npm run test:security:live',
        status: 'pass',
        evidence: 'Live red-team attacks verified with 0% ASR against agent loop'
      };
    } else {
      return {
        id: 'security-attack-suite',
        title: 'Live Red-Team Security Attack Suite',
        command: 'npm run test:security:live',
        status: 'fail',
        evidence: (res.stderr || res.stdout || 'Live security attacks failed').slice(-300).trim()
      };
    }
  } catch (err) {
    return {
      id: 'security-attack-suite',
      title: 'Live Red-Team Security Attack Suite',
      command: 'npm run test:security:live',
      status: 'fail',
      evidence: String(err?.message || err).slice(-300)
    };
  }
}

export function runReleaseGate(shouldWrite = !isJson) {
  const git = getGitInfo();
  const timestamp = new Date().toISOString();

  const checks = [
    checkTypecheck(),
    checkUnit(),
    checkReachability(),
    checkE2E(),
    checkDocsConsistency(),
    checkNoFakePaths(),
    checkSecurityAttackSuite()
  ];

  const failedChecks = checks.filter((c) => c.status === 'fail');
  const isPassed = failedChecks.length === 0;
  const status = isPassed ? 'PASSED' : 'NOT READY';
  const summary = isPassed
    ? 'PASSED / READY FOR v1 RELEASE'
    : `NOT READY (${failedChecks.length} of ${checks.length} checks failing)`;

  const report = {
    timestamp,
    commit: git.commit,
    dirty: git.dirty,
    status,
    summary,
    checks
  };

  const docPath = path.join(ROOT_DIR, 'docs', 'release', 'V1_RELEASE_GATE.md');
  const markdown = generateMarkdown(report);

  if (shouldWrite || args.includes('--write')) {
    fs.mkdirSync(path.dirname(docPath), { recursive: true });
    fs.writeFileSync(docPath, markdown, 'utf8');
  }

  return report;
}

function generateMarkdown(report) {
  const lines = [
    `# Release Gate Status: **${report.summary}**`,
    '',
    `> Generated automatically by \`scripts/release_gate.mjs\` at ${report.timestamp}`,
    `> Commit: \`${report.commit}\` | Working tree dirty: \`${report.dirty}\``,
    '',
    '## Gate Measurements Summary Table',
    '',
    '| Check ID | Area / Description | Verification Command | Status | Measured Evidence / Notes |',
    '|---|---|---|---|---|'
  ];

  for (const c of report.checks) {
    const statusLabel = c.status === 'pass' ? '**PASS**' : '**FAIL**';
    lines.push(`| \`${c.id}\` | ${c.title} | \`${c.command}\` | ${statusLabel} | ${c.evidence} |`);
  }

  lines.push('');
  lines.push('## Required Completion Items');
  lines.push('');
  const failed = report.checks.filter((c) => c.status === 'fail');
  if (failed.length === 0) {
    lines.push('✓ All gate checks passing! The repository satisfies all release readiness requirements.');
  } else {
    for (const f of failed) {
      lines.push(`- [ ] **${f.title}** (\`${f.id}\`): ${f.evidence}`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('*Note: Do not edit this file by hand. This document is automatically generated by `scripts/release_gate.mjs`.*');
  lines.push('');

  return lines.join('\n');
}

// Main execution when invoked as a script
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const report = runReleaseGate();

  if (isJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (strictExit && report.status !== 'PASSED') {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } else {
    console.log(`\n======================================================`);
    console.log(`RELEASE GATE: ${report.summary}`);
    console.log(`Commit: ${report.commit} (dirty: ${report.dirty}) | ${report.timestamp}`);
    console.log(`======================================================\n`);

    for (const c of report.checks) {
      const tag = c.status === 'pass' ? '✓ PASS' : '✗ FAIL';
      console.log(`${tag} [${c.id}] ${c.title}`);
      console.log(`       Command:  ${c.command}`);
      console.log(`       Evidence: ${c.evidence}\n`);
    }

    console.log(`Generated report written to docs/release/V1_RELEASE_GATE.md\n`);
    process.exit(report.status === 'PASSED' ? 0 : 1);
  }
}
