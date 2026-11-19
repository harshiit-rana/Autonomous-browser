/**
 * Milestone M8: Quality, Evals, Benchmarks & Edge-Cases Test Harness (#194 - #205, #217)
 */

import { WebArenaServer } from '../fixtures/arena_server.js';
import { E2EHarness } from './e2e/e2e_harness.js';
import { AgentBenchmarkRunner, BenchmarkTask } from '../src/evaluation/agent_benchmarks.js';
import { runRegressionSuite } from './regression_suite.js';
import { FaultInjector } from '../src/testing/fault_injector.js';
import * as assert from 'node:assert';

console.log('--- Testing Milestone M8: Quality, Evals & Edge-Cases (#194 - #205, #217) ---\n');

async function testWebArenaAndE2EHarness() {
  console.log('[#194, #195] Testing Web Arena Server & Real E2E Scripted Mission...');

  const arena = new WebArenaServer();
  const port = await arena.start();
  assert.strictEqual(port > 0, true, 'Arena server must bind to a positive loopback port');
  const baseUrl = arena.getBaseUrl();

  try {
    const harness = new E2EHarness(arena, { mode: 'scripted', maxCostUSD: 0.50 });

    // Execute multi-step mission against Web Arena
    const missionRes = await harness.executeScriptedMission('m_e2e_shop', [
      { tool: 'navigate', args: { url: `${baseUrl}/shop` }, delayMs: 10 },
      { tool: 'click', args: { ref: 'buy-p1' }, delayMs: 10 }
    ]);

    assert.strictEqual(missionRes.success, true);
    assert.strictEqual(missionRes.stepsExecuted, 2);
    assert.strictEqual(missionRes.costUSD > 0, true);

    const events = harness.getEvents();
    assert.strictEqual(events.some(e => e.type === 'mission_started'), true);
    assert.strictEqual(events.some(e => e.type === 'mission_completed'), true);

    console.log('✓ Web Arena server and E2E scripted mission harness verified\n');
  } finally {
    await arena.stop();
  }
}

async function testAgentBenchmarks() {
  console.log('[#196 QA-03] Testing Agent Benchmark Runner & Independent Oracles...');

  const arena = new WebArenaServer();
  await arena.start();
  const baseUrl = arena.getBaseUrl();

  try {
    const runner = new AgentBenchmarkRunner(arena);

    const testTasks: BenchmarkTask[] = [
      {
        id: 'task_shop_order',
        suite: 'internal_fixtures',
        name: 'Order RTX 4090 on Shop Fixture',
        goal: 'Purchase the GPU',
        startUrl: `${baseUrl}/shop`,
        maxSteps: 5,
        maxCostUSD: 0.10,
        oracleEvaluator: (oracleState) => {
          const hasOrder = oracleState.orders.some(o => o.item.includes('RTX 4090'));
          return { success: hasOrder, reason: hasOrder ? undefined : 'No order recorded in server oracle' };
        }
      }
    ];

    const report = await runner.runSuite(testTasks, async (task) => {
      // Simulate agent sending POST /shop/checkout
      await fetch(`${baseUrl}/shop/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: 'NVIDIA RTX 4090', price: 1599, address: 'Test Lab' })
      });
      return { steps: 2 };
    });

    assert.strictEqual(report.totalTasks, 1);
    assert.strictEqual(report.successCount, 1);
    assert.strictEqual(report.successRatePct, 100);

    const htmlReport = AgentBenchmarkRunner.generateHTMLReport(report);
    assert.strictEqual(htmlReport.includes('Agent Evaluation Benchmark Report'), true);

    console.log('✓ Agent Benchmark runner and HTML reporting verified\n');
  } finally {
    await arena.stop();
  }
}

function testFaultInjectionCorpus() {
  console.log('[#199 QA-06] Testing Fault Injection Corpus...');

  const injector = new FaultInjector();
  injector.injectFault('net_offline');
  assert.strictEqual(injector.isFaultActive('net_offline'), true);
  injector.clearFault('net_offline');
  assert.strictEqual(injector.isFaultActive('net_offline'), false);

  const corpus = FaultInjector.getFaultCorpus();
  assert.strictEqual(corpus.length >= 40, true);
  console.log(`✓ FaultInjector active state and ${corpus.length} chaos scenarios verified\n`);
}

async function main() {
  await testWebArenaAndE2EHarness();
  await testAgentBenchmarks();
  testFaultInjectionCorpus();
  runRegressionSuite();

  console.log('======================================================');
  console.log('ALL MILESTONE M8 QUALITY & EVALS TESTS PASSED (100%)');
  console.log('======================================================');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
