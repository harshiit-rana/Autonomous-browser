import { EnterpriseRBACManager } from '../attic/rbac_policy.js';
import { PageTranslator } from '../attic/page_translator.js';
import { WebEvaluationHarness, BenchmarkTask } from '../src/evaluation/web_eval_harness.js';
import { InterventionAnalytics } from '../src/evaluation/telemetry_analytics.js';
import { StructuredSchemaExtractor, ExtractionSchema } from '../src/data/structured_extractor.js';
import * as assert from 'node:assert';

function testRBAC() {
  console.log('--- Testing Enterprise RBAC ---');
  const rbac = new EnterpriseRBACManager();

  rbac.setUserRole('user_alice', 'operator');
  rbac.setUserRole('user_bob', 'restricted');
  rbac.setUserRole('user_admin', 'admin');

  // Operator cannot checkout
  assert.strictEqual(rbac.isActionAllowed('user_alice', 'checkout'), false);
  assert.strictEqual(rbac.isActionAllowed('user_alice', 'navigate', 'github.com'), true);

  // Admin can checkout
  assert.strictEqual(rbac.isActionAllowed('user_admin', 'checkout'), true);

  // Restricted can only visit allowed domains
  assert.strictEqual(rbac.isActionAllowed('user_bob', 'navigate', 'google.com'), true);
  assert.strictEqual(rbac.isActionAllowed('user_bob', 'navigate', 'evil.com'), false);

  console.log('✓ Enterprise RBAC verified!\n');
}

function testLanguageDetection() {
  console.log('--- Testing PageTranslator Language Detection ---');
  const english = PageTranslator.detectLanguage('Autonomous agent web browser engine with MCTS planning.');
  assert.strictEqual(english.code, 'en');

  const cjk = PageTranslator.detectLanguage('这是一个用于多智能体网络浏览的自主人工智能系统。');
  assert.strictEqual(cjk.code, 'zh');

  const cyrillic = PageTranslator.detectLanguage('Автономный агент для веб-навигации и сбора данных.');
  assert.strictEqual(cyrillic.code, 'ru');

  console.log('✓ Multi-lingual language detection verified!\n');
}

function testWebEvalHarness() {
  console.log('--- Testing WebEvaluationHarness ---');
  const task: BenchmarkTask = {
    id: 'webarena_01',
    dataset: 'webarena',
    goal: 'Navigate to user profile settings',
    startUrl: 'https://shopping.test',
    evaluator: {
      type: 'url_match',
      expectedPattern: '/settings/profile'
    }
  };

  const evalResult = WebEvaluationHarness.evaluateTask(task, {
    url: 'https://shopping.test/settings/profile?tab=general',
    elementTexts: {},
    steps: 4,
    duration: 3200
  });

  assert.strictEqual(evalResult.success, true);
  assert.strictEqual(evalResult.stepsCount, 4);

  const report = WebEvaluationHarness.generateBenchmarkReport([evalResult]);
  assert.strictEqual(report.successRate, 1.0);
  assert.strictEqual(report.totalTasks, 1);
  console.log('✓ WebEvaluationHarness verified!\n');
}

function testInterventionAnalytics() {
  console.log('--- Testing InterventionAnalytics ---');
  const analytics = new InterventionAnalytics();

  analytics.recordTaskCompletion(true); // Task 1 fully autonomous
  analytics.recordTaskCompletion(false); // Task 2 had intervention
  analytics.recordIntervention({
    id: 'int_1',
    taskId: 'task_2',
    url: 'https://bank.com/login',
    reason: 'login_2fa',
    timestamp: Date.now(),
    durationMs: 15000,
    actionsPerformedByUser: 2
  });

  const summary = analytics.getSummary();
  assert.strictEqual(summary.totalTasks, 2);
  assert.strictEqual(summary.autonomousCompleted, 1);
  assert.strictEqual(summary.autonomousCompletionRate, 0.5);
  assert.strictEqual(summary.topInterventionReasons['login_2fa'], 1);
  console.log('✓ InterventionAnalytics verified!\n');
}

function testStructuredExtractor() {
  console.log('--- Testing StructuredSchemaExtractor ---');
  const schema: ExtractionSchema = {
    name: 'FlightOffer',
    description: 'Extracted flight price and airline details',
    properties: {
      airline: { type: 'string', required: true },
      priceUsd: { type: 'number', required: true },
      departureTime: { type: 'string', required: false }
    }
  };

  const validData = { airline: 'Delta Air Lines', priceUsd: 450, departureTime: '08:30 AM' };
  const valRes = StructuredSchemaExtractor.validateOutput(validData, schema);
  assert.strictEqual(valRes.valid, true);

  const invalidData = { departureTime: '08:30 AM' };
  const invalRes = StructuredSchemaExtractor.validateOutput(invalidData, schema);
  assert.strictEqual(invalRes.valid, false);
  assert.strictEqual(invalRes.missingFields.includes('airline'), true);
  assert.strictEqual(invalRes.missingFields.includes('priceUsd'), true);
  console.log('✓ StructuredSchemaExtractor verified!\n');
}

async function main() {
  testRBAC();
  testLanguageDetection();
  testWebEvalHarness();
  testInterventionAnalytics();
  testStructuredExtractor();
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
