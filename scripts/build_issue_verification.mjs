#!/usr/bin/env node
/**
 * Issue verification ledger generator (#222 - [TRU-04]).
 *
 * Inputs (all in the repository):
 *   scripts/issue_verification_map.json   curated pointers: issue -> code/tests/files + observed gap + owning program issues
 *   docs/reachability_audit.json          which src modules are reachable from the app entry points
 *   tests/manifest.json + package.json    which tests run in `npm test`
 *   docs/audits/evidence/<n>.md           running-app evidence; the ONLY way a row becomes "verified"
 *
 * The map asserts no result. Every cited path is checked with fs.existsSync and the generator THROWS if one is
 * missing, so the ledger cannot cite files that do not exist. Results are computed:
 *   verified    docs/audits/evidence/<n>.md exists (running-app log/screenshots from #223 / #254)
 *   partial     at least one cited src module is reachable from the app (or a process deliverable whose files exist)
 *   not-in-app  no cited src module is reachable (orphaned / test-only / attic / document-only)
 *
 * Usage: node scripts/build_issue_verification.mjs [--check] [--verify-open]
 *   --check        compute and compare with the committed files; exit 1 if they differ
 *   --verify-open  also confirm with the GitHub CLI that every owning issue is open
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), '..');
const REPO = 'harshiit-rana/Autonomous-browser';
const PROGRAM_MIN = 218;
const PROGRAM_MAX = 262;

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8'));
const exists = (rel) => fs.existsSync(path.join(ROOT_DIR, rel));

export function computeLedger() {
  const map = readJson('scripts/issue_verification_map.json');
  const audit = readJson('docs/reachability_audit.json');
  const reach = new Map(audit.map((m) => [m.path, m.isReachable]));
  const testChain = readJson('package.json').scripts.test;
  const manifest = fs.readFileSync(path.join(ROOT_DIR, 'tests', 'manifest.json'), 'utf8');
  const inSuite = (rel) => manifest.includes(rel) || testChain.includes(rel);

  const problems = [];
  const issues = [];
  const seen = new Set();
  for (const e of map.issues) {
    if (seen.has(e.n)) problems.push(`duplicate issue ${e.n}`);
    seen.add(e.n);
    const evidence = [];
    for (const m of e.modules) {
      const rel = `src/${m}`;
      if (!exists(rel)) { problems.push(`#${e.n}: module does not exist: ${rel}`); continue; }
      if (!reach.has(m)) problems.push(`#${e.n}: module missing from reachability audit: ${m}`);
      evidence.push({ path: rel, type: 'module', reachable: reach.get(m) === true });
    }
    for (const t of e.tests) {
      const rel = `tests/${t}`;
      if (!exists(rel)) { problems.push(`#${e.n}: test does not exist: ${rel}`); continue; }
      evidence.push({ path: rel, type: 'test', inSuite: inSuite(rel) });
    }
    for (const f of e.files) {
      if (!exists(f)) { problems.push(`#${e.n}: file does not exist: ${f}`); continue; }
      evidence.push({ path: f, type: 'file' });
    }
    for (const o of e.owning) {
      if (!(o >= PROGRAM_MIN && o <= PROGRAM_MAX)) problems.push(`#${e.n}: owning issue #${o} is outside the completion program`);
    }
    if (!e.owning.length) problems.push(`#${e.n}: no owning issue`);
    if (!e.gap) problems.push(`#${e.n}: no gap text`);

    const evidenceFile = `docs/audits/evidence/${e.n}.md`;
    const reachableModules = evidence.filter((x) => x.type === 'module' && x.reachable).length;
    let result;
    if (exists(evidenceFile)) result = 'verified';
    else if (reachableModules > 0) result = 'partial';
    else if (e.kind === 'process' && e.files.length > 0) result = 'partial';
    else result = 'not-in-app';
    issues.push({ number: e.n, title: e.title, kind: e.kind, result, evidence, gap: e.gap, owningIssues: e.owning });
  }
  for (let n = 101; n <= 217; n++) if (!seen.has(n)) problems.push(`issue #${n} missing from map`);
  if (problems.length) throw new Error('Ledger inputs are inconsistent:\n  ' + problems.join('\n  '));

  issues.sort((a, b) => a.number - b.number);
  const count = (r) => issues.filter((i) => i.result === r).length;
  const json = {
    total: issues.length,
    verified: count('verified'),
    partial: count('partial'),
    notInApp: count('not-in-app'),
    issues,
  };
  return { json, md: renderMarkdown(json) };
}

function renderEvidence(ev) {
  return ev
    .map((x) => {
      if (x.type === 'module') return `\`${x.path}\` (${x.reachable ? 'reachable' : 'orphaned'})`;
      if (x.type === 'test') return `\`${x.path}\` (${x.inSuite ? 'in npm test' : 'not run by npm test'})`;
      return `\`${x.path}\``;
    })
    .join('<br>');
}

function renderMarkdown(j) {
  const esc = (s) => String(s).replace(/\|/g, '\\|');
  const link = (n) => `[#${n}](https://github.com/${REPO}/issues/${n})`;
  const out = [
    '# Legacy Issue Verification Ledger (#101 - #217)',
    '',
    '<!-- generated by scripts/build_issue_verification.mjs; do not edit -->',
    '',
    `Owner: [#222 - TRU-04](https://github.com/${REPO}/issues/222). Program rules: [#218](https://github.com/${REPO}/issues/218).`,
    '',
    `- Total audited: **${j.total}**`,
    `- Verified in the running app: **${j.verified}**`,
    `- Partial: **${j.partial}**`,
    `- Not in app: **${j.notInApp}**`,
    '',
    '## How rows are computed',
    '',
    'Pointers come from `scripts/issue_verification_map.json`. The generator fails if any cited path does not exist, then',
    'derives each result from repository data (no result is typed by hand):',
    '',
    '- `verified`: `docs/audits/evidence/<n>.md` exists (a running-app log or screenshots from #223 / the e2e suite from #254). None exist yet.',
    '- `partial`: at least one cited `src/` module is reachable from the app entry points per `docs/reachability_audit.json`, or the row is a process deliverable whose files exist. Reachable code is not proof that it works in the app.',
    '- `not-in-app`: no cited `src/` module is reachable (orphaned, test-only, moved to `attic/`, or a document-only deliverable).',
    '',
    'Old issues stay closed as history. Each non-verified row names the open program issue(s) that own the remaining work.',
    '',
    '## Ledger',
    '',
    '| # | Title | Evidence checked | Gap observed | Result | Owning program issue(s) |',
    '|:--|:--|:--|:--|:--:|:--|',
  ];
  for (const i of j.issues) {
    out.push(`| #${i.number} | ${esc(i.title)} | ${renderEvidence(i.evidence) || '-'} | ${esc(i.gap)} | \`${i.result}\` | ${i.owningIssues.map(link).join(', ')} |`);
  }
  out.push('');
  return out.join('\n');
}

export function buildIssueVerification() {
  const { json, md } = computeLedger();
  const jsonPath = path.join(ROOT_DIR, 'docs', 'audits', 'issue_verification.json');
  const mdPath = path.join(ROOT_DIR, 'docs', 'audits', 'ISSUE_VERIFICATION.md');
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
  fs.writeFileSync(mdPath, md, 'utf8');
  return { jsonPath, mdPath, total: json.total, verified: json.verified, partial: json.partial, notInApp: json.notInApp };
}

function verifyOpen(ledger) {
  const owners = [...new Set(ledger.json.issues.flatMap((i) => i.owningIssues))].sort((a, b) => a - b);
  const bad = [];
  for (const n of owners) {
    const r = spawnSync('gh', ['issue', 'view', String(n), '-R', REPO, '--json', 'state', '--jq', '.state'], { encoding: 'utf8' });
    const state = (r.stdout || '').trim();
    if (state !== 'OPEN') bad.push(`#${n}: ${state || r.stderr.trim()}`);
  }
  if (bad.length) throw new Error('Owning issues that are not open:\n  ' + bad.join('\n  '));
  console.log(`✓ all ${owners.length} owning issues are open`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const ledger = computeLedger();
  if (process.argv.includes('--verify-open')) verifyOpen(ledger);
  if (process.argv.includes('--check')) {
    const jsonPath = path.join(ROOT_DIR, 'docs', 'audits', 'issue_verification.json');
    const mdPath = path.join(ROOT_DIR, 'docs', 'audits', 'ISSUE_VERIFICATION.md');
    const stale =
      !fs.existsSync(jsonPath) || !fs.existsSync(mdPath) ||
      fs.readFileSync(jsonPath, 'utf8').replace(/\r\n/g, '\n') !== JSON.stringify(ledger.json, null, 2) + '\n' ||
      fs.readFileSync(mdPath, 'utf8').replace(/\r\n/g, '\n') !== ledger.md;
    if (stale) {
      console.error('✗ docs/audits/ISSUE_VERIFICATION.md or issue_verification.json is stale; run node scripts/build_issue_verification.mjs');
      process.exit(1);
    }
    console.log('✓ issue verification ledger is up to date');
  } else {
    const res = buildIssueVerification();
    console.log(`✓ Built ${path.relative(ROOT_DIR, res.mdPath)} (${res.total} issues: ${res.verified} verified, ${res.partial} partial, ${res.notInApp} not-in-app)`);
  }
}
