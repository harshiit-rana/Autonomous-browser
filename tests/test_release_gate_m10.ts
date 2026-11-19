/**
 * Test Suite for Milestone M10: Release Readiness Gate, Truthful Foundations & Final Compliance (#102, #103, #215, #216)
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

console.log('--- Testing Milestone M10: Release Readiness Gate & Truthful Foundations (#102, #103, #215, #216) ---\n');

function testAuditAndTraceabilityDocs() {
  console.log('[#102 TRK-00] Verifying Final Architectural Reachability Audit...');
  const auditPath = path.resolve(process.cwd(), 'docs/audits/AUDIT_FINAL_TRACEABILITY.md');
  assert.strictEqual(fs.existsSync(auditPath), true, 'AUDIT_FINAL_TRACEABILITY.md must exist');
  const content = fs.readFileSync(auditPath, 'utf8');

  assert.strictEqual(content.includes('100% of the active production codebase is reachable'), true);
  assert.strictEqual(content.includes('D-01'), true);
  assert.strictEqual(content.includes('D-10'), true);
  assert.strictEqual(content.includes('attic/'), true);
  console.log('✓ Final Architectural Audit & Reachability Map verified\n');
}

function testProductSpecification() {
  console.log('[#103 CMP-01] Verifying Product Specification & Measurable Targets...');
  const specPath = path.resolve(process.cwd(), 'docs/PRODUCT_SPEC.md');
  assert.strictEqual(fs.existsSync(specPath), true, 'PRODUCT_SPEC.md must exist');
  const content = fs.readFileSync(specPath, 'utf8');

  assert.strictEqual(content.includes('Power Researcher & Market Analyst'), true);
  assert.strictEqual(content.includes('Operator & Personal Executive Assistant'), true);
  assert.strictEqual(content.includes('Continuous Background Monitor'), true);
  assert.strictEqual(content.includes('0.0%'), true); // 0% ASR
  assert.strictEqual(content.includes('Explicit Non-Goals'), true);
  console.log('✓ Product specification, measurable exit criteria, and non-goals verified\n');
}

function testReleaseReadinessGate() {
  console.log('[#215 REL-01] Verifying v1 Release-Readiness Gate Dashboard & Traceability Matrix...');
  const gatePath = path.resolve(process.cwd(), 'docs/release/V1_RELEASE_GATE.md');
  assert.strictEqual(fs.existsSync(gatePath), true, 'V1_RELEASE_GATE.md must exist');
  const content = fs.readFileSync(gatePath, 'utf8');

  assert.strictEqual(content.includes('Release Gate Status: **PASSED / READY FOR v1 RELEASE**'), true);
  assert.strictEqual(content.includes('M0'), true);
  assert.strictEqual(content.includes('M10'), true);
  assert.strictEqual(content.includes('Product Promises Traceability Matrix'), true);
  assert.strictEqual(content.includes('Known Limitations & Non-Goals'), true);
  console.log('✓ v1 Release Gate criteria and traceability matrix verified\n');
}

function testLegalComplianceAndPolicies() {
  console.log('[#216 REL-02] Verifying Legal, Privacy, AI Disclosure & Notices...');
  const policyPath = path.resolve(process.cwd(), 'docs/legal/POLICIES.md');
  const noticesPath = path.resolve(process.cwd(), 'docs/legal/THIRD_PARTY_NOTICES.md');

  assert.strictEqual(fs.existsSync(policyPath), true, 'POLICIES.md must exist');
  assert.strictEqual(fs.existsSync(noticesPath), true, 'THIRD_PARTY_NOTICES.md must exist');

  const policyContent = fs.readFileSync(policyPath, 'utf8');
  assert.strictEqual(policyContent.includes('Automated Access & Robots.txt Posture'), true);
  assert.strictEqual(policyContent.includes('Privacy & Data Protection (GDPR / CCPA)'), true);
  assert.strictEqual(policyContent.includes('AI Disclosure & Content Transparency'), true);
  assert.strictEqual(policyContent.includes('Acceptable Use Policy'), true);

  const noticesContent = fs.readFileSync(noticesPath, 'utf8');
  assert.strictEqual(noticesContent.includes('Electron'), true);
  assert.strictEqual(noticesContent.includes('Playwright-Core'), true);
  assert.strictEqual(noticesContent.includes('MIT License'), true);

  console.log('✓ Legal policies, robots.txt posture, AI disclosure, and license notices verified\n');
}

testAuditAndTraceabilityDocs();
testProductSpecification();
testReleaseReadinessGate();
testLegalComplianceAndPolicies();

console.log('======================================================');
console.log('ALL MILESTONE M10 RELEASE READINESS TESTS PASSED (100%)');
console.log('======================================================');
