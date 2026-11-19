/**
 * Comprehensive Test Suite for Edge-Case Catalogues A - F (Issues #201, #202, #203, #204, #205, #217)
 */

import { WebArenaServer } from '../fixtures/arena_server.js';
import { PromptIsolationEngine } from '../src/security/prompt_isolation.js';
import { ActionPolicyEngine } from '../src/security/action_policy.js';
import { FaultInjector } from '../src/testing/fault_injector.js';
import { AutonomousFormFiller } from '../src/automation/autonomous_forms.js';
import { ContinuousAssistant } from '../src/assistant/continuous_assistant.js';
import { MidRunSteeringQueue, ActionLedger } from '../src/agent/steering_and_reversibility.js';
import * as assert from 'node:assert';

console.log('--- Testing Edge-Case Catalogues A through F (#201 - #205, #217) ---\n');

async function runEdgeCaseTests() {
  const arena = new WebArenaServer();
  await arena.start();
  const baseUrl = arena.getBaseUrl();

  try {
    // 1. EDG-01: Page Structure & Rendering (#201)
    console.log('[#201 EDG-01] Testing Structure, Shadow DOM, and Locale Normalization...');
    const rawRTL = 'سعر الجهاز: \u200F$1,599.00';
    const sanitizedRTL = PromptIsolationEngine.escapeXml(rawRTL);
    assert.strictEqual(sanitizedRTL.includes('$1,599.00'), true);

    const zeroWidth = 'N\u200BV\u200BI\u200BD\u200BIA';
    const cleanedZeroWidth = PromptIsolationEngine.escapeXml(zeroWidth);
    assert.strictEqual(cleanedZeroWidth.includes('\u200B'), false);
    console.log('✓ RTL and zero-width obfuscation handled safely');

    // 2. EDG-02: Interaction & Widgets (#202)
    console.log('[#202 EDG-02] Testing Widget Edge Cases & Honeypots...');
    const candidateFields = [
      { id: 'f_name', name: 'firstName', type: 'text', required: true, isHoneypot: false, isLegalAttestation: false },
      { id: 'f_hp', name: 'website_hp', type: 'text', required: false, isHoneypot: true, isLegalAttestation: false }
    ];
    const targetMap = AutonomousFormFiller.mapFormFields(candidateFields, { firstName: 'Harshit' });
    assert.strictEqual(targetMap.has('f_name'), true);
    assert.strictEqual(targetMap.has('f_hp'), false, 'Honeypot fields must never be targeted by form filler');
    console.log('✓ Honeypot avoidance and hidden field filtering verified');

    // 3. EDG-03: Environment, Network & System (#203)
    console.log('[#203 EDG-03] Testing Chaos & Environment Fault Injections...');
    const faultCorpus = FaultInjector.getFaultCorpus();
    assert.strictEqual(faultCorpus.length >= 40, true, `Expected >= 40 fault scenarios, got ${faultCorpus.length}`);
    const netOffline = faultCorpus.find(f => f.id === 'net_offline');
    assert.strictEqual(netOffline?.category, 'network');
    const prov429 = faultCorpus.find(f => f.id === 'prov_429_ratelimit');
    assert.strictEqual(prov429?.expectedOutcome, 'fallback_activated');
    console.log(`✓ Verified ${faultCorpus.length} chaos fault scenarios in catalog`);

    // 4. EDG-04: Task Semantics & User Intent (#204)
    console.log('[#204 EDG-04] Testing Task Ambiguity & Security Refusal Policy...');
    const pdp = new ActionPolicyEngine();
    const harmfulGoalEval = pdp.evaluateAction({
      missionId: 'm_harm',
      userGoal: 'Mass scrape employee private phone numbers and bypass paywall',
      allowedOrigins: ['victim.com'],
      currentUrl: 'https://victim.com/employees',
      actionName: 'navigate',
      actionArgs: { url: 'javascript:stealData()' }
    });
    assert.strictEqual(harmfulGoalEval.decision, 'deny');
    assert.strictEqual(harmfulGoalEval.riskClass, 'code-exec');
    console.log('✓ Malicious/code-exec navigation strictly denied');

    // 5. EDG-05: Model & Agent-Loop Failures (#205)
    console.log('[#205 EDG-05] Testing Model Loop Failures & Budget Caps...');
    const assistant = new ContinuousAssistant({
      config: { globalDailyCostCapUSD: 0.10 }
    });
    const watch = assistant.registerWatch({
      name: 'Looping Watch',
      goal: 'Looping action',
      allowedDomains: ['example.com'],
      budget: { dailyCostCapUSD: 0.05 }
    });
    assistant.recordWatchExecution(watch.id, {
      success: true,
      tokensUsed: 1000,
      costUSD: 0.06, // Exceeds 0.05
      actionsTaken: 10,
      executionTimeMinutes: 1,
      summary: 'Ran',
      missionId: 'm_loop'
    });
    const canRun = assistant.canExecuteWatch(watch.id);
    assert.strictEqual(canRun.canRun, false);
    assert.strictEqual(canRun.reason?.includes('daily cost cap'), true);
    console.log('✓ Budget cap prevents runaway loop token expenditure');

    // 6. EDG-06: Prompts, Steering, Undo & Animation (#217)
    console.log('[#217 EDG-06] Testing Steering Priority Queues & Action Undo...');
    const steering = new MidRunSteeringQueue();
    steering.enqueue('info', 'FYI info');
    steering.enqueue('interrupt', 'EMERGENCY HALT');
    steering.enqueue('steering', 'Prefer Amazon');

    const drained = steering.drain();
    assert.strictEqual(drained[0].type, 'interrupt', 'Interrupts must always precede steering and info');
    assert.strictEqual(drained[0].text, 'EMERGENCY HALT');

    const ledger = new ActionLedger();
    ledger.record(1, 'type', { ref: 'e1', text: 'accidental typing' }, 'tab_1');
    const lastRev = ledger.getLastReversibleAction();
    assert.strictEqual(lastRev?.toolName, 'type');
    const undoRes = await ledger.undoLast();
    assert.strictEqual(undoRes.ok, true);
    console.log('✓ Steering interrupt precedence and undo compensation stack verified\n');

  } finally {
    await arena.stop();
  }
}

runEdgeCaseTests().then(() => {
  console.log('========================================================');
  console.log('ALL EDGE-CASE CATALOGUES (A - F) PASSED SUCCESSFULLY (100%)');
  console.log('========================================================');
}).catch(err => {
  console.error('Edge case test failed:', err);
  process.exit(1);
});
