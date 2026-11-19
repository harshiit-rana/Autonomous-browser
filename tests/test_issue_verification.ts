/**
 * Issue verification ledger test (#222 - [TRU-04]).
 *
 * Independent of the generator's own checks, this test:
 *  - recomputes the ledger and requires the committed files to be identical (no stale / hand-edited ledger)
 *  - re-checks with fs that EVERY path cited in the ledger exists
 *  - requires 117 rows (#101-#217), valid results, and an owning issue in #218-#262 for each non-verified row
 *  - requires "verified" rows to have an evidence file, and evidence files to correspond to "verified" rows
 *  - requires docs/STATUS.md to carry the generated counts
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
// @ts-ignore - plain ESM script
import { computeLedger } from '../scripts/build_issue_verification.mjs';

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/
/g, '
'); // checkouts may use CRLF
console.log('--- Issue verification ledger (#222 TRU-04) ---');

const { json, md } = computeLedger() as { json: any; md: string };

assert.strictEqual(read('docs/audits/issue_verification.json'), JSON.stringify(json, null, 2) + '\n', 'issue_verification.json is stale: run node scripts/build_issue_verification.mjs');
assert.strictEqual(read('docs/audits/ISSUE_VERIFICATION.md'), md, 'ISSUE_VERIFICATION.md is stale: run node scripts/build_issue_verification.mjs');

assert.strictEqual(json.total, 117);
assert.strictEqual(json.issues.length, 117);
assert.strictEqual(json.verified + json.partial + json.notInApp, 117);

let cited = 0;
for (let n = 101; n <= 217; n++) {
  const row = json.issues.find((i: any) => i.number === n);
  assert.ok(row, `missing row #${n}`);
  assert.ok(['verified', 'partial', 'not-in-app'].includes(row.result), `#${n}: bad result ${row.result}`);
  assert.ok(row.title && row.gap, `#${n}: title and gap required`);
  assert.ok(new RegExp(`\\| #${n} \\|`).test(read('docs/audits/ISSUE_VERIFICATION.md')), `#${n}: not rendered in markdown`);
  for (const ev of row.evidence) {
    cited++;
    assert.ok(fs.existsSync(path.join(root, ev.path)), `#${n}: cited path does not exist: ${ev.path}`);
  }
  const hasEvidenceFile = fs.existsSync(path.join(root, `docs/audits/evidence/${n}.md`));
  assert.strictEqual(row.result === 'verified', hasEvidenceFile, `#${n}: "verified" requires docs/audits/evidence/${n}.md and vice versa`);
  assert.ok(row.owningIssues.length > 0, `#${n}: needs an owning program issue`);
  for (const o of row.owningIssues) assert.ok(o >= 218 && o <= 262, `#${n}: owning issue #${o} outside #218-#262`);
}
assert.ok(cited > 200, `expected >200 cited paths, got ${cited}`);

// Every path-looking token in the rendered markdown must exist (guards hand-edits of the .md).
const tokens = [...md.matchAll(/`((?:src|tests|scripts|docs|attic|fixtures|\.github)\/[^`\s]+)`/g)].map((m) => m[1]);
for (const t of new Set(tokens.filter((x) => !x.includes("<")))) assert.ok(fs.existsSync(path.join(root, t)), `markdown cites a missing path: ${t}`);

const status = read('docs/STATUS.md');
assert.ok(status.includes('## 3. Legacy Issue Verification Summary (#101 - #217)'), 'STATUS.md section 3 missing');
assert.ok(status.includes(`| **Partial** | ${json.partial} |`), 'STATUS.md partial count differs from ledger');
assert.ok(status.includes(`| **Not in App** | ${json.notInApp} |`), 'STATUS.md not-in-app count differs from ledger');

console.log(`✓ ${json.total} rows, ${cited} cited paths all exist: ${json.verified} verified, ${json.partial} partial, ${json.notInApp} not-in-app`);
console.log('ISSUE VERIFICATION TESTS PASSED');
