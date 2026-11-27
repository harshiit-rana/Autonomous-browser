/**
 * Unit tests for #228 [SWX-02]: Model-driven orchestrator replacing regex routing and hardcoded templates.
 */
import assert from 'node:assert/strict';
import {
  planWithOrchestrator,
  validateOrchestratorPlan,
  PlanValidationError,
  diffPlans,
  SUBMIT_PLAN_TOOL
} from '../src/swarm/orchestrator.js';
import { SwarmCoordinator } from '../src/swarm/coordinator.js';
import { SwarmManager } from '../src/swarm/swarm_manager.js';
import { fakeWorkerFactory } from './helpers/fake_worker_host.js';
import { PromptRegistry } from '../src/agent/steering_and_reversibility.js';
import { migrateSettings, SettingsManager, CURRENT_SETTINGS_VERSION } from '../src/infrastructure/settings.js';
import type { IModelProvider, ModelRequest, ModelResponse } from '../src/models/types.js';

function fakeProvider(responses: ModelResponse[], seenRequests?: ModelRequest[]): IModelProvider {
  let i = 0;
  return {
    providerName: 'test-orchestrator',
    modelName: 'gemini-2.0-flash',
    async generate(req: ModelRequest): Promise<ModelResponse> {
      seenRequests?.push(req);
      const r = responses[i++];
      if (!r) throw new Error(`Unexpected extra orchestrator call #${i}`);
      return r;
    }
  };
}

async function run(): Promise<void> {
  // 1. PromptRegistry exposes editable 'orchestrator' role
  const reg = PromptRegistry.getInstance();
  const orchPrompt = reg.getEffectivePrompt('orchestrator');
  assert.strictEqual(orchPrompt.lockedSectionsCount, 3, 'orchestrator prompt has 3 locked policy sections');
  assert(orchPrompt.systemPrompt.includes('submit_plan'), 'orchestrator prompt must explain submit_plan');
  assert(orchPrompt.systemPrompt.includes('Orchestrator Trust Boundary'), 'orchestrator prompt must have trust boundary');
  console.log('✓ PromptRegistry exposes orchestrator role');

  // 2. Validation rejects malformed / unsafe plans
  const tooMany = validateOrchestratorPlan({
    mode: 'swarm',
    justification: 'Split across 8 origins',
    stages: [{
      name: 'extract',
      parallelism: 5,
      tasks: [{ id: 't1', name: 'A', role: 'extractor', goal: 'Read A', dependsOn: [], effectClass: 'read' }]
    }]
  }, { maxWorkers: 3, missionId: 'm1', goal: 'test' });
  assert.strictEqual(tooMany.ok, false);
  assert(tooMany.errors.some(e => e.includes('settings.maxWorkers (3)')), `expected maxWorkers error, got ${tooMany.errors}`);

  const cycle = validateOrchestratorPlan({
    mode: 'swarm',
    justification: 'Cycle check',
    stages: [{
      name: 's1',
      parallelism: 2,
      tasks: [
        { id: 't1', name: 'A', role: 'extractor', goal: 'Read A', dependsOn: ['t2'], effectClass: 'read' },
        { id: 't2', name: 'B', role: 'extractor', goal: 'Read B', dependsOn: ['t1'], effectClass: 'read' }
      ]
    }]
  }, { maxWorkers: 4, missionId: 'm2', goal: 'test' });
  assert.strictEqual(cycle.ok, false);
  assert(cycle.errors.some(e => e.includes('Dependency cycle detected')), `expected cycle error, got ${cycle.errors}`);

  const mutatingNoApproval = validateOrchestratorPlan({
    mode: 'single',
    justification: 'Submit order',
    stages: [{
      name: 'act',
      parallelism: 1,
      tasks: [{ id: 't1', name: 'Buy', role: 'actor', goal: 'Buy item', dependsOn: [], effectClass: 'financial' }]
    }]
  }, { maxWorkers: 2, missionId: 'm3', goal: 'buy' });
  assert.strictEqual(mutatingNoApproval.ok, false);
  assert(mutatingNoApproval.errors.some(e => e.includes('requiresApproval: true')));

  const badUrlAndRole = validateOrchestratorPlan({
    mode: 'single',
    justification: 'Bad url and role',
    stages: [{
      name: 's1',
      parallelism: 1,
      tasks: [{ id: 't1', name: 'Bad', role: 'hacker', goal: 'Run', startUrl: 'file:///etc/passwd', dependsOn: ['missing'], effectClass: 'read' }]
    }]
  }, { maxWorkers: 2, missionId: 'm4', goal: 'bad' });
  assert.strictEqual(badUrlAndRole.ok, false);
  assert(badUrlAndRole.errors.some(e => e.includes('invalid role')));
  assert(badUrlAndRole.errors.some(e => e.includes('invalid startUrl')));
  assert(badUrlAndRole.errors.some(e => e.includes('unknown task "missing"')));
  console.log('✓ Plan validator rejects maxWorkers overflow, cycles, missing approval markers, invalid URLs/roles/deps');

  // 3. Single vs swarm decision without regex heuristics + prompt-injection isolation
  const requests: ModelRequest[] = [];
  const pSingle = fakeProvider([{
    text: '',
    toolCalls: [{
      id: 'c1',
      name: 'submit_plan',
      arguments: {
        mode: 'single',
        justification: 'One target page question requires a single agent.',
        stages: [{
          name: 'read',
          parallelism: 1,
          tasks: [{ id: 't1', name: 'Read heading', role: 'researcher', goal: 'Read page heading', startUrl: 'https://example.com', dependsOn: [], effectClass: 'read' }]
        }]
      }
    }],
    finishReason: 'tool_calls'
  }], requests);
  const singleRes = await planWithOrchestrator({
    provider: pSingle,
    missionId: 'm_single',
    goal: 'what is the heading on example.com',
    model: 'gemini-2.0-flash',
    maxWorkers: 3
  });
  assert.strictEqual(singleRes.mode, 'single');
  assert.strictEqual(requests[0].tools?.[0]?.name, SUBMIT_PLAN_TOOL.name);
  assert(!JSON.stringify(requests[0].messages).includes('<div>'), 'orchestrator must only see brief, never raw DOM');

  // 4. Prose / invalid first response -> 1 repair turn -> succeeds
  const repairRequests: ModelRequest[] = [];
  const pRepair = fakeProvider([
    { text: 'Sure, here is my plan: I will search both sites.', toolCalls: [], finishReason: 'stop' },
    {
      text: '',
      toolCalls: [{
        id: 'c2',
        name: 'submit_plan',
        arguments: {
          mode: 'swarm',
          justification: 'Parallel extraction across 2 shops.',
          stages: [{
            name: 'extract',
            parallelism: 2,
            tasks: [
              { id: 't1', name: 'Shop A', role: 'extractor', goal: 'Read A', startUrl: 'https://a.test', dependsOn: [], effectClass: 'read' },
              { id: 't2', name: 'Shop B', role: 'extractor', goal: 'Read B', startUrl: 'https://b.test', dependsOn: [], effectClass: 'read' }
            ]
          }]
        }
      }],
      finishReason: 'tool_calls'
    }
  ], repairRequests);
  const repaired = await planWithOrchestrator({
    provider: pRepair,
    missionId: 'm_repair',
    goal: 'compare shops',
    model: 'gemini-2.0-flash',
    maxWorkers: 3
  });
  assert.strictEqual(repaired.mode, 'swarm');
  assert.strictEqual(repairRequests.length, 2, 'must send exactly one repair turn');

  // 5. Second failure throws explicit PlanValidationError (never falls back silently)
  const pFail = fakeProvider([
    { text: 'I cannot use tools.', toolCalls: [], finishReason: 'stop' },
    {
      text: '',
      toolCalls: [{
        id: 'bad2',
        name: 'submit_plan',
        arguments: { mode: 'swarm', justification: 'Bad', stages: [{ name: 's', parallelism: 99, tasks: [] }] }
      }],
      finishReason: 'tool_calls'
    }
  ]);
  await assert.rejects(
    () => planWithOrchestrator({ provider: pFail, missionId: 'm_fail', goal: 'broken', model: 'gemini-2.0-flash', maxWorkers: 2 }),
    (err: unknown) => err instanceof PlanValidationError
  );
  console.log('✓ Orchestrator retries invalid plans once and throws PlanValidationError on second failure');

  // 6. Explicit /swarm override upgrades single plan to swarm with notice
  const pForce = fakeProvider([{
    text: '',
    toolCalls: [{
      id: 'c3',
      name: 'submit_plan',
      arguments: {
        mode: 'single',
        justification: 'Model suggested single.',
        stages: [{ name: 's1', parallelism: 1, tasks: [{ id: 't1', name: 'Do', role: 'researcher', goal: 'Check page', dependsOn: [], effectClass: 'read' }] }]
      }
    }],
    finishReason: 'tool_calls'
  }]);
  const forced = await planWithOrchestrator({
    provider: pForce,
    missionId: 'm_force',
    goal: '/swarm check pricing',
    model: 'gemini-2.0-flash',
    maxWorkers: 3,
    forceSwarm: true
  });
  assert.strictEqual(forced.mode, 'swarm');
  assert(forced.warnings.some(w => w.includes('/swarm')));
  console.log('✓ Explicit /swarm user override honored');

  // 7. Mid-execution replanning on stage failure (capped at maxReplans = 2)
  const fakes = fakeWorkerFactory();
  const swarm = new SwarmManager({ missionId: 'm_replan', maxWorkers: 2, workerFactory: fakes.factory });
  const coordinator = new SwarmCoordinator({ swarm, maxWorkers: 2 });
  const replanEvents: any[] = [];
  coordinator.on('planUpdated', ev => replanEvents.push(ev));

  let replanCalls = 0;
  const result = await coordinator.executeMission(
    'm_replan',
    'Test replan',
    async (_worker, task) => {
      if (task.id === 'fail_1') throw new Error('Source A 404');
      coordinator.getBlackboard().postEvidence({
        entity: 'Widget',
        attribute: 'price',
        category: 'price',
        value: '$42.00',
        source: { url: 'https://fallback.test/widget', sourceType: 'primary', quote: 'Widget $42.00' },
        pageText: 'Widget $42.00 in stock.',
        workerId: _worker.id
      });
      return { ok: true };
    },
    {
      maxReplans: 2,
      plan: {
        missionId: 'm_replan',
        goal: 'Test replan',
        justification: 'Try source A',
        stages: [{
          stageName: 'extract',
          parallelism: 1,
          tasks: [{ id: 'fail_1', name: 'Read A', role: 'extractor', instruction: 'Read A', effectClass: 'read', dependencies: [] }]
        }]
      },
      replanFn: async (_curr, summary) => {
        replanCalls++;
        assert(summary.includes('fail_1'), `replan context must cite failed stage: ${summary}`);
        return {
          missionId: 'm_replan',
          goal: 'Test replan',
          justification: 'Switch to fallback source B after A 404',
          stages: [{
            stageName: 'extract-fallback',
            parallelism: 1,
            tasks: [{ id: 'ok_2', name: 'Read Fallback B', role: 'extractor', url: 'https://fallback.test/widget', instruction: 'Read B', effectClass: 'read', dependencies: [] }]
          }]
        };
      }
    }
  );
  await swarm.shutdown();
  assert.strictEqual(replanCalls, 1);
  assert.strictEqual(replanEvents.length, 1);
  assert(replanEvents[0].diff.some((d: string) => d.includes('Added task ok_2')));
  assert.strictEqual(result.success, true);

  const d = diffPlans(
    { missionId: 'm', goal: 'g', justification: 'a', stages: [{ stageName: 's', parallelism: 1, tasks: [{ id: 't1', name: 'One', role: 'extractor', instruction: 'A', effectClass: 'read', dependencies: [] }] }] },
    { missionId: 'm', goal: 'g', justification: 'b', stages: [{ stageName: 's', parallelism: 1, tasks: [{ id: 't2', name: 'Two', role: 'extractor', instruction: 'B', effectClass: 'read', dependencies: [] }] }] }
  );
  assert(d.includes('+ Added task t2 (extractor): Two'));
  assert(d.includes('- Removed task t1: One'));
  console.log('✓ Stage-failure replanning updates plan, emits planUpdated diff, and enforces max replans');

  // 8. Settings migration v2 -> v3 adds skipLowRiskPlanPreview = false
  const mig23 = migrateSettings({ version: 2, modelProvider: 'gemini' });
  assert.strictEqual(mig23.changed, true);
  assert.strictEqual(mig23.fields.version, CURRENT_SETTINGS_VERSION);
  assert.strictEqual(mig23.fields.skipLowRiskPlanPreview, false);
  const store: Record<string, any> = { version: 2, modelProvider: 'gemini' };
  const fakeRepo: any = {
    all: () => ({ ...store }),
    setMany: (patch: Record<string, unknown>) => Object.assign(store, patch)
  };
  const loaded = SettingsManager.getInstance().attachRepo(fakeRepo);
  assert.strictEqual(loaded.version, CURRENT_SETTINGS_VERSION);
  assert.strictEqual(loaded.skipLowRiskPlanPreview, false);
  SettingsManager.getInstance().detachRepo();
  console.log('✓ Settings v2 -> v3 migration adds skipLowRiskPlanPreview = false');

  console.log('\nALL #228 ORCHESTRATOR UNIT TESTS PASSED');
}

run().catch(err => {
  console.error('Fatal error in orchestrator tests:', err);
  process.exit(1);
});
