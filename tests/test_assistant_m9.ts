/**
 * Test Suite for Milestone M9: Legacy Triage & Continuous Assistant (#192, #193, #212)
 */

import { ContinuousAssistant, StandingWatch } from '../src/assistant/continuous_assistant.js';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

console.log('--- Testing Milestone M9: Legacy Triage & Continuous Assistant (#192, #193, #212) ---\n');

function testLegacyTriageVerification() {
  console.log('[#192, #193] Testing Legacy Triage & Attic Disposition...');

  const atticDir = path.resolve(process.cwd(), 'attic');
  assert.strictEqual(fs.existsSync(atticDir), true, 'attic directory must exist');

  // Verify all 5 triaged modules are safely in attic
  const expectedAtticFiles = [
    'mobile_sync.ts',
    'audio_loopback.ts',
    'synchronized_tester.ts',
    'rbac_policy.ts',
    'accessibility_audit.ts',
    'page_translator.ts',
    'README.md'
  ];

  for (const file of expectedAtticFiles) {
    const filePath = path.join(atticDir, file);
    assert.strictEqual(fs.existsSync(filePath), true, `Expected ${file} to be safely quarantined in attic/`);
  }

  // Verify ADR-006 exists and documents disposition
  const adrPath = path.resolve(process.cwd(), 'docs/decisions/ADR-006-legacy-triage-disposition.md');
  assert.strictEqual(fs.existsSync(adrPath), true, 'ADR-006 must exist');
  const adrContent = fs.readFileSync(adrPath, 'utf8');
  assert.strictEqual(adrContent.includes('Audio Loopback & Meeting Transcription'), true);
  assert.strictEqual(adrContent.includes('Enterprise RBAC & SSO Stubs'), true);

  console.log('✓ Legacy modules successfully quarantined to attic/ with ADR-006 disposition documentation\n');
}

function testStandingWatchesAndBudgets() {
  console.log('[#212 AST-01] Testing Standing Watches & Hard Daily Budgets...');

  const assistant = new ContinuousAssistant({
    config: {
      globalDailyCostCapUSD: 2.0,
      globalDailyTokenCap: 100_000,
      maxConsecutiveFailuresBeforeDisable: 3
    }
  });

  // 1. Register a standing watch
  const watch = assistant.registerWatch({
    name: 'Competitor Price Tracker',
    goal: 'Check Amazon RTX 4090 prices hourly',
    allowedDomains: ['amazon.com', 'bestbuy.com'],
    intervalMinutes: 60,
    budget: {
      dailyCostCapUSD: 0.20,
      dailyTokenCap: 10_000,
      maxActionsPerDay: 50
    },
    notificationRule: 'on_change_only'
  });

  assert.strictEqual(watch.name, 'Competitor Price Tracker');
  assert.strictEqual(watch.enabled, true);
  assert.strictEqual(watch.allowedDomains.includes('amazon.com'), true);

  // 2. Can execute initially
  let canRun = assistant.canExecuteWatch(watch.id);
  assert.strictEqual(canRun.canRun, true);

  // 3. Record execution consuming cost up to budget cap
  assistant.recordWatchExecution(watch.id, {
    success: true,
    tokensUsed: 4_000,
    costUSD: 0.15,
    actionsTaken: 10,
    executionTimeMinutes: 2,
    detectedChange: false,
    summary: 'Price stable at $1,599',
    missionId: 'm_watch_01'
  });

  // Should still run (spent $0.15 of $0.20)
  canRun = assistant.canExecuteWatch(watch.id);
  assert.strictEqual(canRun.canRun, true);

  // Consume another $0.10 -> total $0.25 (exceeds $0.20 cap)
  assistant.recordWatchExecution(watch.id, {
    success: true,
    tokensUsed: 3_000,
    costUSD: 0.10,
    actionsTaken: 5,
    executionTimeMinutes: 1,
    detectedChange: true,
    summary: 'Price dropped to $1,499!',
    missionId: 'm_watch_02'
  });

  // Budget cap must now strictly deny execution
  canRun = assistant.canExecuteWatch(watch.id);
  assert.strictEqual(canRun.canRun, false);
  assert.strictEqual(canRun.reason?.includes('daily cost cap'), true);

  console.log('✓ Standing watch registration and daily budget enforcement verified\n');
}

function testConsecutiveFailuresAutoDisable() {
  console.log('[#212 AST-01] Testing Consecutive Failures Auto-Disable...');

  const assistant = new ContinuousAssistant({
    config: { maxConsecutiveFailuresBeforeDisable: 3 }
  });

  const watch = assistant.registerWatch({
    name: 'Flaky Portal Watcher',
    goal: 'Scrape internal dashboard',
    allowedDomains: ['internal.corp']
  });

  // 2 failures: should stay enabled
  assistant.recordWatchExecution(watch.id, {
    success: false,
    tokensUsed: 500,
    costUSD: 0.01,
    actionsTaken: 1,
    executionTimeMinutes: 0.5,
    error: '503 Service Unavailable',
    summary: 'Service down',
    missionId: 'm_flaky_1'
  });
  assistant.recordWatchExecution(watch.id, {
    success: false,
    tokensUsed: 500,
    costUSD: 0.01,
    actionsTaken: 1,
    executionTimeMinutes: 0.5,
    error: '503 Service Unavailable',
    summary: 'Service down',
    missionId: 'm_flaky_2'
  });

  assert.strictEqual(assistant.getWatch(watch.id)?.enabled, true);

  // 3rd failure: must trip circuit breaker and auto-disable with reason
  assistant.recordWatchExecution(watch.id, {
    success: false,
    tokensUsed: 500,
    costUSD: 0.01,
    actionsTaken: 1,
    executionTimeMinutes: 0.5,
    error: 'Cloudflare blocked automation',
    summary: 'Blocked by Cloudflare',
    missionId: 'm_flaky_3'
  });

  const updated = assistant.getWatch(watch.id);
  assert.strictEqual(updated?.enabled, false);
  assert.strictEqual(updated?.autoDisabledReason?.includes('Auto-disabled after 3 consecutive failures'), true);

  const canRun = assistant.canExecuteWatch(watch.id);
  assert.strictEqual(canRun.canRun, false);

  console.log('✓ Consecutive failure circuit breaker and automatic shutdown verified\n');
}

function testActivityInboxAndAwayDigest() {
  console.log('[#212 AST-01] Testing Unified Activity Inbox & Truthful Away Digest...');

  const assistant = new ContinuousAssistant();
  assistant.recordUserActivity(); // Set last active mark

  // Simulate background watch events
  const watch = assistant.registerWatch({
    name: 'Hardware Monitor',
    goal: 'Check inventory',
    allowedDomains: ['retailer.com'],
    notificationRule: 'always'
  });

  // 1. Run completed with change
  assistant.recordWatchExecution(watch.id, {
    success: true,
    tokensUsed: 1200,
    costUSD: 0.02,
    actionsTaken: 4,
    executionTimeMinutes: 1,
    detectedChange: true,
    summary: 'Stock replenished for item #99',
    evidenceItems: [{ label: 'Item 99 in stock', url: 'https://retailer.com/item/99' }],
    missionId: 'm_hw_1'
  });

  // 2. Action needing human review/approval
  assistant.recordWatchExecution(watch.id, {
    success: true,
    tokensUsed: 1500,
    costUSD: 0.03,
    actionsTaken: 6,
    executionTimeMinutes: 1.5,
    needsHumanAction: true,
    summary: 'Action requires user 2FA confirmation',
    missionId: 'm_hw_2'
  });

  // Check inbox sorting: needsHumanAction must sort to the top!
  const inboxItems = assistant.getInboxItems();
  assert.strictEqual(inboxItems.length, 2);
  assert.strictEqual(inboxItems[0].needsHumanAction, true);
  assert.strictEqual(inboxItems[0].category, 'approval_needed');

  // Test Snooze functionality
  assistant.markItemStatus(inboxItems[0].id, 'snoozed', 60);
  const snoozedItem = assistant.getInboxItems().find(i => i.id === inboxItems[0].id);
  assert.strictEqual(snoozedItem?.status, 'snoozed');

  // Test Truthful Away Digest
  const digest = assistant.generateAwayDigest();
  assert.strictEqual(digest.completedRunsCount, 1);
  assert.strictEqual(digest.actionsNeedingReviewCount, 1);
  assert.strictEqual(digest.summaryLines.some(l => l.includes('1 runs completed while you were away')), true);
  assert.strictEqual(digest.summaryLines.some(l => l.includes('1 item(s) require your review or approval')), true);

  console.log('✓ Activity inbox priority sorting, snoozing, and truthful away digest verified\n');
}

function testPanicKillSwitch() {
  console.log('[#212 AST-01] Testing Panic Kill Switch (Pause Everything)...');

  const assistant = new ContinuousAssistant();
  const watch = assistant.registerWatch({
    name: 'Critical Task',
    goal: 'Monitor status',
    allowedDomains: ['safe.com']
  });

  assert.strictEqual(assistant.canExecuteWatch(watch.id).canRun, true);

  // Trigger Panic Kill-Switch
  assistant.pauseAll();
  assert.strictEqual(assistant.isPanicPaused(), true);

  const canRun = assistant.canExecuteWatch(watch.id);
  assert.strictEqual(canRun.canRun, false);
  assert.strictEqual(canRun.reason?.includes('kill-switch is active'), true);

  // Resume
  assistant.resumeAll();
  assert.strictEqual(assistant.isPanicPaused(), false);
  assert.strictEqual(assistant.canExecuteWatch(watch.id).canRun, true);

  console.log('✓ Panic kill-switch successfully halts and resumes all background execution\n');
}

// Execute all tests
testLegacyTriageVerification();
testStandingWatchesAndBudgets();
testConsecutiveFailuresAutoDisable();
testActivityInboxAndAwayDigest();
testPanicKillSwitch();

console.log('======================================================');
console.log('ALL MILESTONE M9 TRIAGE & ASSISTANT TESTS PASSED (100%)');
console.log('======================================================');
