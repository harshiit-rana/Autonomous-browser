/**
 * Unit tests for #231 [SWX-05]: Real resource governance metrics, hysteresis, sleep-safe monotonic supervisor,
 * abort+retry+stalled lifecycle, and hibernation predicate.
 */
import assert from 'node:assert/strict';
import {
  ResourceGovernor,
  registerElectronMetricsSource
} from '../src/swarm/resource_governor.js';
import { WorkerSupervisor, DEFAULT_STALL_THRESHOLD_MS } from '../src/swarm/supervisor.js';
import { SwarmCoordinator } from '../src/swarm/coordinator.js';
import { SwarmManager } from '../src/swarm/swarm_manager.js';
import { fakeWorkerFactory } from './helpers/fake_worker_host.js';

async function run(): Promise<void> {
  // 1. Live host & Electron metric source integration
  registerElectronMetricsSource({
    getAppMetrics: () => [
      { pid: 100, type: 'Browser', cpu: { percentCPUUsage: 20 }, memory: { workingSetSize: 150 * 1024 } },
      { pid: 101, type: 'Tab', cpu: { percentCPUUsage: 12 }, memory: { workingSetSize: 90 * 1024 } }
    ],
    getWebContentsCount: () => 4
  });

  const govReal = new ResourceGovernor({ maxMemoryMb: 2048, maxConcurrencyCap: 6 });
  govReal.start();
  await new Promise(r => setTimeout(r, 40));
  const realM = govReal.getMetrics();
  govReal.stop();
  registerElectronMetricsSource(null);

  assert.strictEqual(realM.metricsAvailable, true);
  assert.strictEqual(realM.activeWebContentsCount, 4);
  assert.strictEqual(realM.appWorkingSetMb, 240);
  assert.strictEqual(realM.processBreakdown.length, 2);
  assert(Number.isFinite(realM.eventLoopLagMs) && realM.eventLoopLagMs >= 0);
  assert(realM.recommendedConcurrency >= 1 && realM.recommendedConcurrency <= 6);
  console.log('✓ ResourceGovernor reads Chromium process metrics, working set, webContents count, and event-loop lag');

  // 2. Adaptive width drops on CPU > 85% and free memory < 1024 MB, never < 1, with hysteresis
  let fakeSample = {
    totalSystemMemMb: 16384,
    freeSystemMemMb: 8192,
    processRssMb: 300,
    appWorkingSetMb: 350,
    cpuPercent: 30,
    eventLoopLagMs: 5,
    metricsAvailable: true
  };
  const govHyst = new ResourceGovernor({
    maxMemoryMb: 2048,
    maxConcurrencyCap: 6,
    throttleThreshold: 0.85,
    releaseThreshold: 0.70,
    cpuThrottlePercent: 85,
    cpuReleasePercent: 70,
    minFreeMemMb: 1024,
    releaseFreeMemMb: 1400,
    sampleOverride: () => fakeSample
  });

  const mNormal = govHyst.getMetrics();
  assert.strictEqual(mNormal.recommendedConcurrency, 6);
  assert.strictEqual(mNormal.limitReason, null);

  // Spike CPU > 85% -> immediate throttle + 'limited by CPU'
  fakeSample = { ...fakeSample, cpuPercent: 91 };
  (govHyst as any).checkGovernance();
  const mCpu = govHyst.getMetrics();
  assert.strictEqual(mCpu.isThrottled, true);
  assert(mCpu.recommendedConcurrency <= 2 && mCpu.recommendedConcurrency >= 1);
  assert.strictEqual(mCpu.limitReason, 'cpu');
  assert.strictEqual(mCpu.limitDescription, 'limited by CPU');

  // Borderline CPU 78% (between release 70 and throttle 85) MUST NOT release throttle (hysteresis!)
  fakeSample = { ...fakeSample, cpuPercent: 78 };
  (govHyst as any).checkGovernance();
  assert.strictEqual(govHyst.getMetrics().isThrottled, true, 'hysteresis prevents premature release at 78% CPU');

  // Drop below 70% comfortably for 2 readings -> cleanly releases
  fakeSample = { ...fakeSample, cpuPercent: 40 };
  (govHyst as any).checkGovernance();
  (govHyst as any).checkGovernance();
  assert.strictEqual(govHyst.getMetrics().isThrottled, false);

  // Low free memory < 1024 MB -> drops concurrency & marks 'limited by memory'
  fakeSample = { ...fakeSample, freeSystemMemMb: 480, cpuPercent: 25 };
  (govHyst as any).checkGovernance();
  const mMem = govHyst.getMetrics();
  assert.strictEqual(mMem.recommendedConcurrency, 1);
  assert.strictEqual(mMem.limitReason, 'memory');
  assert.strictEqual(mMem.limitDescription, 'limited by memory');

  // Unavailable metrics -> conservative fallback
  fakeSample = { ...fakeSample, metricsAvailable: false };
  const mFallback = govHyst.getMetrics();
  assert.strictEqual(mFallback.metricsAvailable, false);
  assert.strictEqual(mFallback.recommendedConcurrency, 2);
  console.log('✓ Adaptive width drops on CPU > 85% and free memory < 1 GB, honors hysteresis and conservative fallback');

  // 3. Supervisor: monotonic clock, suspend/sleep jump immunity, paused immunity, 60s default, abort+retry -> stalled
  assert.strictEqual(DEFAULT_STALL_THRESHOLD_MS, 60_000);
  let wallMs = 1_000_000;
  let monoMs = 10_000;
  const sup = new WorkerSupervisor({
    stallThresholdMs: 60_000,
    maxPoisonFailures: 2,
    wallNow: () => wallMs,
    monoNow: () => monoMs
  });
  const stalledEvents: any[] = [];
  sup.on('workerStalled', ev => stalledEvents.push(ev));

  sup.registerWorker('w1', 't1');
  sup.recordEvent('w1', 'step_progress', 't1');

  // Simulate OS sleep: wall clock jumps 300s while monotonic jumps only 200ms -> NO stall!
  wallMs += 300_000;
  monoMs += 200;
  sup.scanSupervision();
  assert.strictEqual(stalledEvents.length, 0, 'sleep clock skew must never trigger false stall');

  // Pause worker: advance BOTH clocks 90s while paused -> NO stall!
  sup.pauseWorker('w1');
  wallMs += 90_000;
  monoMs += 90_000;
  sup.scanSupervision();
  assert.strictEqual(stalledEvents.length, 0, 'paused worker must never trigger stall');
  sup.resumeWorker('w1');

  // Normal monotonic stall (> 60s without progress): 1st stall retries (`final: false`), 2nd stall -> permanent stalled (`final: true`)
  wallMs += 65_000;
  monoMs += 65_000;
  sup.scanSupervision();
  assert.strictEqual(stalledEvents.length, 1);
  assert.strictEqual(stalledEvents[0].final, false);

  wallMs += 65_000;
  monoMs += 65_000;
  sup.scanSupervision();
  assert.strictEqual(stalledEvents.length, 2);
  assert.strictEqual(stalledEvents[1].final, true);
  assert.strictEqual(sup.getTelemetry('w1')?.status, 'stalled');
  assert.strictEqual(sup.isTaskQuarantined('t1'), true);
  console.log('✓ Supervisor sleep-jump immunity, paused-worker immunity, and 1-retry -> stalled lifecycle verified');

  // 4. Coordinator retries a stalled task once then stops without restarting a third time
  const fakes = fakeWorkerFactory();
  const swarm = new SwarmManager({ missionId: 'm_stall', maxWorkers: 2, workerFactory: fakes.factory });
  const supExec = new WorkerSupervisor({ stallThresholdMs: 40, checkIntervalMs: 15, maxPoisonFailures: 2 });
  const coord = new SwarmCoordinator({ swarm, supervisor: supExec, maxWorkers: 2 });
  const abortMap = new Map<string, (why: string) => void>();
  coord.on('workerStalled', ev => abortMap.get(ev.workerId)?.('stalled'));

  let attempts = 0;
  const execRes = await coord.executeMission(
    'm_stall',
    'Extract https://hang.test/p and https://fast.test/p',
    async (worker, task) => {
      if (task.url?.includes('hang.test')) {
        attempts += 1;
        supExec.registerWorker(worker.id, task.id);
        await new Promise((_res, rej) => {
          abortMap.set(worker.id, why => rej(new Error(`aborted:${why}`)));
        });
      }
      coord.getBlackboard().postEvidence({
        entity: 'Widget',
        attribute: 'price',
        category: 'price',
        value: '$25.00',
        source: { url: task.url!, sourceType: 'primary', quote: 'Widget $25.00' },
        pageText: 'Widget $25.00 in stock',
        workerId: worker.id
      });
      return { ok: true };
    }
  );
  await swarm.shutdown();
  assert.strictEqual(attempts, 2, 'hung task must abort and retry exactly once (total 2 attempts)');
  assert.strictEqual(execRes.evidence.length, 1, 'healthy worker must complete cleanly despite stalled sibling');
  console.log('✓ Coordinator aborts stalled worker, retries once, quarantines, and sibling succeeds');

  console.log('\nALL #231 GOVERNANCE & SUPERVISION UNIT TESTS PASSED');
}

run().catch(err => {
  console.error('Fatal error in #231 tests:', err);
  process.exit(1);
});
