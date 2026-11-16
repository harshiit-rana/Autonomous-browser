import { SharedBlackboard } from '../src/swarm/blackboard.js';
import { WorkStealingQueue, SwarmTask } from '../src/swarm/work_stealing_queue.js';
import { CountDownLatch, SwarmBarrier } from '../src/swarm/barrier.js';
import { SwarmHealthDaemon } from '../src/swarm/health_daemon.js';
import * as assert from 'node:assert';

async function testBlackboard() {
  console.log('--- Testing SharedBlackboard ---');
  const bb = new SharedBlackboard();

  // 1. Post initial evidence
  const res1 = bb.postEvidence({
    workerId: 'worker_1',
    sourceUrl: 'https://airline.com/flights',
    category: 'price',
    key: 'flight_sfo_jfk',
    value: 350,
    confidence: 0.95
  });
  assert.strictEqual(res1.posted, true);

  // 2. Post duplicate evidence -> should be deduplicated
  const resDup = bb.postEvidence({
    workerId: 'worker_2',
    sourceUrl: 'https://airline.com/flights',
    category: 'price',
    key: 'flight_sfo_jfk',
    value: 350,
    confidence: 0.95
  });
  assert.strictEqual(resDup.posted, false, 'Duplicate evidence must be deduplicated');

  // 3. Post conflicting evidence on same key
  const resConflict = bb.postEvidence({
    workerId: 'worker_3',
    sourceUrl: 'https://aggregator.com/deal',
    category: 'price',
    key: 'flight_sfo_jfk',
    value: 420,
    confidence: 0.80
  });
  assert.strictEqual(resConflict.posted, true);
  assert.strictEqual(Boolean(resConflict.conflict), true, 'Conflict should be flagged');

  // 4. Resolve conflict
  const resolved = bb.resolveConflict('flight_sfo_jfk', 350);
  assert.strictEqual(resolved, true);
  assert.strictEqual(bb.getUnresolvedConflicts().length, 0);

  console.log('✓ SharedBlackboard verified!\n');
}

function testWorkStealing() {
  console.log('--- Testing WorkStealingQueue ---');
  const queue = new WorkStealingQueue(2);

  queue.registerWorker('worker_A');
  queue.registerWorker('worker_B');

  const task1: SwarmTask = {
    id: 't1',
    url: 'https://news.ycombinator.com',
    targetDomain: 'news.ycombinator.com',
    depth: 1,
    priority: 10,
    actionType: 'scrape',
    createdAt: Date.now()
  };

  const task2: SwarmTask = {
    id: 't2',
    url: 'https://news.ycombinator.com/item?id=123',
    targetDomain: 'news.ycombinator.com',
    depth: 2,
    priority: 5,
    actionType: 'scrape',
    createdAt: Date.now()
  };

  // Push both tasks onto worker_A
  queue.pushTask(task1, 'worker_A');
  queue.pushTask(task2, 'worker_A');

  // Worker_B is idle -> steals task from worker_A
  const stolen = queue.getNextTask('worker_B');
  assert.strictEqual(Boolean(stolen), true, 'Worker_B should steal task');
  console.log(`Worker_B stole task: ${stolen?.id}`);

  // Complete domain tracking
  queue.completeTask('news.ycombinator.com');
  console.log('✓ WorkStealingQueue verified!\n');
}

async function testSynchronization() {
  console.log('--- Testing Barriers & Latches ---');

  // CountDownLatch
  const latch = new CountDownLatch(3);
  let finished = false;

  setTimeout(() => latch.countDown(), 20);
  setTimeout(() => latch.countDown(), 40);
  setTimeout(() => {
    latch.countDown();
    finished = true;
  }, 60);

  await latch.wait(1000);
  assert.strictEqual(finished, true);
  assert.strictEqual(latch.getCount(), 0);

  // SwarmBarrier
  const barrier = new SwarmBarrier(2);
  let p1Arrived = false;
  let p2Arrived = false;

  const p1 = (async () => {
    await barrier.await();
    p1Arrived = true;
  })();

  const p2 = (async () => {
    await barrier.await();
    p2Arrived = true;
  })();

  await Promise.all([p1, p2]);
  assert.strictEqual(p1Arrived && p2Arrived, true);

  console.log('✓ CountDownLatch & SwarmBarrier verified!\n');
}

async function testHealthDaemon() {
  console.log('--- Testing SwarmHealthDaemon ---');
  let recoveredWorker: string | null = null;

  const daemon = new SwarmHealthDaemon(50, 20); // Fast heartbeat threshold for test
  daemon.registerWorker('worker_stalled_tab');

  daemon.setRecoveryHandler(async (workerId) => {
    recoveredWorker = workerId;
  });

  daemon.start();

  // Wait for stall detection
  await new Promise(resolve => setTimeout(resolve, 120));
  daemon.stop();

  assert.strictEqual(recoveredWorker, 'worker_stalled_tab');
  console.log('✓ SwarmHealthDaemon verified!\n');
}

async function main() {
  await testBlackboard();
  testWorkStealing();
  await testSynchronization();
  await testHealthDaemon();
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
