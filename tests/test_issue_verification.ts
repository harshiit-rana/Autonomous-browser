/**
 * Issue Verification Audit Test (Issue #222 - [TRU-04])
 *
 * Verifies that all 117 closed historical issues (#101-#217) are audited:
 * - docs/audits/ISSUE_VERIFICATION.md contains all 117 rows
 * - Every row maps to an active completion program issue (#218-#262)
 * - docs/audits/issue_verification.json matches markdown counts
 * - docs/STATUS.md includes the generated summary
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

console.log('--- Testing Issue Verification Audit (#222 - [TRU-04]) ---\n');

function testIssueVerificationLedger() {
  console.log('[#222 TRU-04] Verifying docs/audits/ISSUE_VERIFICATION.md...');
  const mdPath = path.resolve(process.cwd(), 'docs/audits/ISSUE_VERIFICATION.md');
  const jsonPath = path.resolve(process.cwd(), 'docs/audits/issue_verification.json');

  assert.strictEqual(fs.existsSync(mdPath), true, 'docs/audits/ISSUE_VERIFICATION.md must exist');
  assert.strictEqual(fs.existsSync(jsonPath), true, 'docs/audits/issue_verification.json must exist');

  const jsonContent = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.strictEqual(jsonContent.total, 117, 'Total audited issues must be 117');
  assert.strictEqual(jsonContent.verified, 0, 'Verified count must be 0 until #223/#254 are completed');
  assert.strictEqual(jsonContent.partial + jsonContent.notInApp, 117, 'Sum of partial and notInApp must equal 117');
  assert.strictEqual(jsonContent.issues.length, 117, 'Must have 117 issue entries');

  const mdContent = fs.readFileSync(mdPath, 'utf8');

  // Verify each issue from 101 to 217 is present
  for (let num = 101; num <= 217; num++) {
    const issueRegex = new RegExp(`\\|\\s*#${num}\\s*\\|`);
    assert.ok(issueRegex.test(mdContent), `ISSUE_VERIFICATION.md must contain row for #${num}`);
  }

  // Verify every issue row links to an active completion issue (#218-#262)
  for (const item of jsonContent.issues) {
    assert.ok(
      item.number >= 101 && item.number <= 217,
      `Issue number must be between 101 and 217, got ${item.number}`
    );
    assert.ok(item.title && typeof item.title === 'string', `Issue #${item.number} must have title`);
    assert.ok(item.claim && typeof item.claim === 'string', `Issue #${item.number} must have claim`);
    assert.ok(item.howVerified && typeof item.howVerified === 'string', `Issue #${item.number} must describe how verified`);
    assert.ok(
      item.result === 'verified' || item.result === 'partial' || item.result === 'not-in-app',
      `Issue #${item.number} must have valid result (verified/partial/not-in-app), got: ${item.result}`
    );

    // If not verified, must link to an open program issue (#218 - #262)
    if (item.result !== 'verified') {
      const match = item.owningIssue.match(/#(\d+)/);
      assert.ok(match, `Non-verified issue #${item.number} must link to owning issue in program: ${item.owningIssue}`);
      const owningNum = parseInt(match[1], 10);
      assert.ok(
        owningNum >= 218 && owningNum <= 262,
        `Owning issue #${owningNum} for #${item.number} must be within completion program (#218-#262)`
      );
    }
  }

  console.log(`✓ All 117 issues verified: ${jsonContent.verified} verified, ${jsonContent.partial} partial, ${jsonContent.notInApp} not-in-app`);
}

function testStatusDocSummary() {
  console.log('[#222 TRU-04] Verifying legacy verification summary in docs/STATUS.md...');
  const statusPath = path.resolve(process.cwd(), 'docs/STATUS.md');
  assert.strictEqual(fs.existsSync(statusPath), true, 'docs/STATUS.md must exist');

  const content = fs.readFileSync(statusPath, 'utf8');
  assert.ok(
    content.includes('## 3. Legacy Issue Verification Summary (#101 - #217)'),
    'docs/STATUS.md must contain section 3 for Legacy Issue Verification'
  );
  assert.ok(content.includes('**Total Audited**'), 'docs/STATUS.md must contain Total Audited row');
  assert.ok(content.includes('**117**'), 'docs/STATUS.md must reflect 117 audited issues');
  console.log('✓ docs/STATUS.md summary section verified');
}

testIssueVerificationLedger();
testStatusDocSummary();

console.log('======================================================');
console.log('ALL ISSUE VERIFICATION TESTS PASSED (100%)');
console.log('======================================================');
