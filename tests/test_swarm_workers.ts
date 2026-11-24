/**
 * Issue #227 (SWX-01): swarm workers are real model-driven agents on their own views.
 *  Part 1 (plain Node, FakeWorkerHost): quote guard, URL claims and planner, concurrency cap and throttle waiting, retry then
 *          poison, needs_human, model-driven conflict adjudication, pause gate and question queue, rate limit through the
 *          real governor, report built from blackboard evidence only.
 *  Part 2 (real Electron, tests/agent_loop/swarm_worker_suite.ts): the REAL AgentLoop on real WorkerHost views with a
 *          scripted model: report_finding rejects a quote that is not on the page, budgets, timeout, stop within 1 s,
 *          pause, bot challenge, duplicate-URL refusal, approval of one worker while the others continue.
 */
import { strict as assert } from 'node:assert';
import { SwarmCoordinator } from '../src/swarm/coordinator.js';
import { SwarmManager } from '../src/swarm/swarm_manager.js';
import { SharedBlackboard } from '../src/swarm/blackboard.js';
import { URLFrontier } from '../src/swarm/url_frontier.js';
import { WorkerSupervisor } from '../src/swarm/supervisor.js';
import { checkFinding, UrlClaims, adjudicateConflicts } from '../src/swarm/worker_findings.js';
import { PauseGate, QuestionQueue } from '../src/swarm/worker_coordination.js';
import { clampMaxWorkers } from '../src/infrastructure/settings.js';
import { ConcurrencyGovernor } from '../src/models/governor.js';
import type { IModelProvider, ModelRequest, ModelResponse } from '../src/models/types.js';
import { fakeWorkerFactory } from './helpers/fake_worker_host.js';
import { runElectronSuite } from './agent_loop/launch.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
console.log('--- #227 SWX-01: swarm workers run the AgentLoop ---');

function coordinator(opts: { maxWorkers?: number; frontier?: URLFrontier; supervisor?: WorkerSupervisor } = {}) {
  const fakes = fakeWorkerFactory();
  const swarm = new SwarmManager({ missionId: 'm_t', workerFactory: fakes.factory, maxWorkers: 8 });
  const c = new SwarmCoordinator({ swarm, blackboard: new SharedBlackboard({ inMemory: true }), maxWorkers: opts.maxWorkers, frontier: opts.frontier, supervisor: opts.supervisor });
  return { c, swarm, fakes };
}
const shopUrls = (n: number) => Array.from({ length: n }, (_, i) => `http://127.0.0.1:${4100 + i}/product`);

async function main() {
  // ---- quote guard
  {
    const page = { text: 'Welcome\n  Aegis Widget X:   $129.00 including tax\nFree returns', url: 'http://127.0.0.1:1/product' };
    assert.equal(checkFinding({ value: '$129.00', quote: 'Aegis Widget X: $129.00 including tax', url: page.url }, page).ok, true, 'whitespace is normalised');
    assert.match(checkFinding({ value: '$99.00', quote: 'Aegis Widget X: $99.00 including tax', url: page.url }, page).problem!, /does not occur on the current page/);
    assert.match(checkFinding({ value: '$99.00', quote: 'Aegis Widget X: $129.00 including tax', url: page.url }, page).problem!, /does not contain the value/);
    assert.match(checkFinding({ value: '$129.00', quote: 'Aegis Widget X: $129.00 including tax', url: 'http://127.0.0.1:2/product' }, page).problem!, /url must be/);
    assert.match(checkFinding({ value: 'x', quote: '', url: page.url }, page).problem!, /empty/);
    console.log('✓ report_finding guard: fabricated quote, wrong value and wrong url are rejected');
  }

  // ---- settings, planner, claims
  {
    assert.equal(clampMaxWorkers(undefined), 3);
    assert.equal(clampMaxWorkers(0), 1);
    assert.equal(clampMaxWorkers(99), 8);
    assert.equal(clampMaxWorkers(5.9), 5);
    const urls = ['http://a.test/x', 'http://b.test/y?utm_source=z', 'http://b.test/y', 'http://c.test/'];
    const { c } = coordinator({ maxWorkers: 2 });
    const plan = c.planMission('m_p', `compare the price of X across ${urls.join(' ')}.`);
    const first = plan.stages[0];
    assert.equal(first.tasks.length, 3, 'a duplicate URL (same page after tracking-parameter strip) is one task');
    assert.deepEqual(first.tasks.map(t => t.url), ['http://a.test/x', 'http://b.test/y?utm_source=z', 'http://c.test/']);
    assert.equal(first.parallelism, 2, 'parallelism is capped by maxWorkers');
    assert.equal(plan.stages[1].tasks[0].role, 'verifier');
    assert.equal(plan.stages[2].tasks[0].role, 'summariser');
    const claims = new UrlClaims();
    assert.equal(claims.claim('http://a.test/x', 'w1'), null);
    assert.equal(claims.claim('http://a.test/x#frag', 'w1'), null, 'the holder may claim again');
    assert.equal(claims.claim('http://a.test/x?utm_campaign=q', 'w2'), 'w1', 'the same page under another spelling is refused');
    claims.releaseWorker('w1');
    assert.equal(claims.claim('http://a.test/x', 'w2'), null, 'released pages can be taken (retry on another worker)');
    console.log('✓ planner splits by source URL (deduplicated, capped), settings clamp, URL claims dedupe');
  }

  // ---- concurrency: never above maxWorkers, and really parallel up to it
  {
    const { c, swarm } = coordinator({ maxWorkers: 2 });
    let running = 0; let peak = 0;
    const res = await c.executeMission('m_w', `compare prices across ${shopUrls(5).join(' ')}`, async (_w, task) => {
      running++; peak = Math.max(peak, running);
      await sleep(150);
      running--;
      return { status: 'completed', task: task.id };
    }, { inlineExecutorFn: async () => ({ status: 'completed' }) });
    assert.equal(peak, 2, 'two workers ran at once and never more than maxWorkers');
    assert.equal(res.completedTasks, 5 + 2, 'five sources plus the verifier and summariser tasks');
    assert.equal(res.success, true);
    await swarm.shutdown();
    console.log('✓ five sources on maxWorkers=2: peak concurrency 2, all five done');
  }

  // ---- politeness throttling makes workers wait instead of quitting
  {
    const frontier = new URLFrontier({ maxConcurrentPerOrigin: 1, minIntervalMs: 250 });
    const { c, swarm } = coordinator({ maxWorkers: 3, frontier });
    const sameOrigin = ['http://one.test/a', 'http://one.test/b', 'http://one.test/c'];
    const doneBy: string[] = [];
    const res = await c.executeMission('m_th', `compare prices across ${sameOrigin.join(' ')}`, async (w, task) => {
      await sleep(60);
      doneBy.push(`${w.id}:${task.id}`);
      return { status: 'completed' };
    }, { inlineExecutorFn: async () => ({ status: 'completed' }) });
    assert.equal(res.errors.length, 0, res.errors.join('; '));
    assert.equal(doneBy.length, 3, 'a worker that finds its task throttled waits and retries; no task is left behind');
    await swarm.shutdown();
    console.log('✓ per-origin throttling: all three same-origin tasks run (waiting workers do not quit)');
  }

  // ---- crash / failure: one retry, then poison
  {
    const supervisor = new WorkerSupervisor();
    const { c, swarm } = coordinator({ maxWorkers: 3, supervisor });
    const attempts = new Map<string, number>();
    const urls = shopUrls(3);
    const res = await c.executeMission('m_f', `compare prices across ${urls.join(' ')}`, async (_w, task) => {
      attempts.set(task.id, (attempts.get(task.id) || 0) + 1);
      if (task.url === urls[0]) throw new Error('renderer process gone: crashed');
      return { status: 'completed' };
    }, { inlineExecutorFn: async () => ({ status: 'completed' }) });
    const bad = [...attempts].find(([id]) => id.endsWith('_t1'))!;
    assert.equal(bad[1], 2, 'the failing task is retried once');
    assert.equal(supervisor.isTaskQuarantined(bad[0]), true, 'and then quarantined as poison');
    assert.ok(res.errors.some(e => /quarantined/.test(e) && /renderer process gone/.test(e)), res.errors.join('; '));
    assert.equal(res.success, true, 'the other two sources still produced a result');
    assert.equal(res.completedTasks, 2 + 2);
    await swarm.shutdown();
    console.log('✓ crashing worker task: retried once, then marked poison; the rest of the swarm continues');
  }

  // ---- needs_human is not a failure
  {
    const { c, swarm } = coordinator({ maxWorkers: 3 });
    const urls = shopUrls(3);
    const res = await c.executeMission('m_h', `compare prices across ${urls.join(' ')}`, async (_w, task) =>
      task.url === urls[1] ? { status: 'needs_human', reason: 'Cloudflare challenge on shop 2' } : { status: 'completed' },
    { inlineExecutorFn: async () => ({ status: 'completed' }) });
    assert.deepEqual(res.needsHuman.map(n => n.reason), ['Cloudflare challenge on shop 2']);
    assert.equal(res.errors.length, 0, 'a challenge is not an error');
    assert.equal(c.getScheduler().getAllTasks().filter(t => t.status === 'needs_human').length, 1);
    assert.match(res.deliverableMarkdown, /Waiting for you[\s\S]*Cloudflare challenge/);
    await swarm.shutdown();
    console.log('✓ bot challenge: task ends needs_human (not failed), shown in the report');
  }

  // ---- conflicts are adjudicated by a model call that reads the quotes; no valid verdict leaves them open
  {
    const bb = new SharedBlackboard({ inMemory: true });
    bb.postEvidence({ entity: 'Widget', attribute: 'price', value: '$10.00', source: { url: 'http://a.test/', quote: 'Widget now $10.00' }, workerId: 'w1', confidence: 0.99 });
    const posted = bb.postEvidence({ entity: 'Widget', attribute: 'price', value: '$12.00', source: { url: 'http://b.test/', quote: 'Widget price $12.00' }, workerId: 'w2', confidence: 0.4 });
    assert.ok(posted.conflict, 'different prices for one entity are a conflict');
    const seen: ModelRequest[] = [];
    const judge = (pick: number | null): IModelProvider => ({
      providerName: 'test', modelName: 'test',
      async generate(req: ModelRequest): Promise<ModelResponse> {
        seen.push(req);
        return { text: '', toolCalls: pick === null ? [] : [{ id: 'c1', name: 'resolve_conflict', arguments: { choice: pick, reason: 'quote 1 states the price directly' } }], finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
      }
    });
    const none = await adjudicateConflicts(bb, judge(null), { missionId: 'm' });
    assert.equal(none[0].resolved, false);
    assert.equal(bb.getUnresolvedConflicts().length, 1, 'no verdict: the conflict stays open (nothing picks the highest confidence)');
    const done = await adjudicateConflicts(bb, judge(1), { missionId: 'm' });
    assert.equal(done[0].resolved, true);
    assert.equal(bb.getUnresolvedConflicts().length, 0);
    const prompt = String((seen[1].messages[0] as any).content);
    assert.ok(prompt.includes('Widget now $10.00') && prompt.includes('Widget price $12.00') && prompt.includes('http://b.test/'), 'the model is shown both quotes and urls');
    // 0.99 vs 0.4 confidence: the model chose the LOWER-confidence claim, so the choice came from the model, not the confidence
    assert.equal((bb.getUnresolvedConflicts().length === 0) && bb.getConflicts()[0].resolvedValue, '$12.00');
    console.log('✓ verifier stage: model reads the quotes; no verdict leaves the conflict open; the verdict overrides confidence');
  }

  // ---- pause gate and question queue
  {
    const gate = new PauseGate();
    gate.pause();
    const woke: number[] = [];
    const waiters = [1, 2, 3].map(n => gate.wait().then(() => woke.push(n)));
    await sleep(40);
    assert.equal(woke.length, 0, 'all three workers are held');
    gate.resume();
    await Promise.all(waiters);
    assert.deepEqual(woke.sort(), [1, 2, 3], 'one resume releases every waiting worker');
    gate.pause();
    const ac = new AbortController();
    const held = gate.wait(ac.signal);
    ac.abort();
    await held; // returns because of the abort, while still paused
    assert.equal(gate.isPaused, true);

    const q = new QuestionQueue();
    const order: string[] = [];
    let release1!: (a: string) => void;
    const a1 = q.ask(() => { order.push('show1'); return new Promise<string>(r => { release1 = r; }); });
    const a2 = q.ask(async () => { order.push('show2'); return 'two'; });
    await sleep(30);
    assert.deepEqual(order, ['show1'], 'the second question waits behind the open one');
    release1('one');
    assert.deepEqual(await Promise.all([a1, a2]), ['one', 'two']);
    assert.deepEqual(order, ['show1', 'show2']);
    const dead = new AbortController(); dead.abort();
    await assert.rejects(q.ask(async () => 'never', dead.signal), /cancelled/);
    console.log('✓ pause gate wakes all workers; question queue shows one question at a time');
  }

  // ---- provider rate limit with three workers: the real governor queues and retries
  {
    const gov = new ConcurrencyGovernor({ maxConcurrencyPerProvider: 2, maxRetries: 3, baseBackoffMs: 20, maxBackoffMs: 80 });
    let active = 0; let peak = 0; let calls = 0; const failedOnce = new Set<number>();
    const provider: IModelProvider = {
      providerName: 'limited', modelName: 'limited',
      async generate(): Promise<ModelResponse> {
        const n = ++calls;
        active++; peak = Math.max(peak, active);
        await sleep(40);
        active--;
        if (n <= 2 && !failedOnce.has(n)) { failedOnce.add(n); const e: any = new Error('429 rate limit exceeded'); e.status = 429; throw e; }
        return { text: `ok${n}`, toolCalls: [], finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      }
    };
    const req: ModelRequest = { messages: [{ role: 'user', content: 'x' }] };
    const out = await Promise.all([1, 2, 3].map(() => gov.executeSafe(provider, req)));
    assert.equal(out.length, 3);
    assert.ok(out.every(o => /^ok\d$/.test(o.text)), 'every worker got an answer despite the 429s');
    assert.ok(calls >= 5, `two calls were rate limited and retried (calls: ${calls})`);
    assert.ok(peak <= 2, `never more than the provider concurrency cap (peak ${peak})`);
    console.log('✓ rate limit with three workers: queued, retried after 429, cap respected');
  }

  // ---- report: evidence only, with quotes
  {
    const { c } = coordinator();
    const bb = c.getBlackboard();
    bb.postEvidence({ entity: 'Widget at Shop A', attribute: 'price', value: '$10.00', source: { url: 'http://a.test/p', quote: 'Widget $10.00 incl. tax' }, workerId: 'w1' });
    const md = c.synthesizeReport('goal', bb.getAllEvidence(), []);
    assert.match(md, /\| Widget at Shop A \| price \| \$10\.00 \| "Widget \$10\.00 incl\. tax" \| \[a\.test\]\(http:\/\/a\.test\/p\) \|/);
    assert.doesNotMatch(md, /Confidence|consensus:/);
    assert.match(md, /Verified Complete/);
    console.log('✓ report rows come from blackboard evidence with quote and source');
  }

  // ---- real Electron part
  const result = await runElectronSuite('swarm_worker_suite', 300_000);
  for (const line of result.log as string[]) console.log(line);
  assert.equal(result.failed, 0, `Electron swarm worker suite failed:\n${(result.failures as string[]).join('\n')}`);

  console.log('\nALL #227 SWARM WORKER TESTS PASSED');
}

main().catch(err => { console.error(err); process.exit(1); });
