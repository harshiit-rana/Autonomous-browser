/**
 * #227 suite, run inside real Electron (tests/test_swarm_workers.ts launches it).
 * The REAL `runWorkerTask`, `AgentLoop`, `WorkerHost` views, perception and policy run on real Chromium pages served by a
 * small http server. Only the model is scripted (each step is a function of the request it receives).
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BrowserWindow } from 'electron';
import { WorkerHost } from '../../src/swarm/worker_host.js';
import { runWorkerTask, WorkerRunDeps } from '../../src/swarm/worker_task_runner.js';
import { SharedBlackboard } from '../../src/swarm/blackboard.js';
import { UrlClaims } from '../../src/swarm/worker_findings.js';
import { PauseGate } from '../../src/swarm/worker_coordination.js';
import type { ScheduledTask } from '../../src/swarm/scheduler.js';
import type { IModelProvider, ModelRequest, ModelResponse } from '../../src/models/types.js';
import type { UserQuestion } from '../../src/agent/agent_loop.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const log: string[] = [];
const failures: string[] = [];
function check(cond: unknown, msg: string): void { if (!cond) { failures.push(msg); log.push(`✗ ${msg}`); } }
function pass(msg: string): void { log.push(`✓ ${msg}`); }

interface Call { name: string; args: Record<string, any> }
type Step = (req: ModelRequest, n: number) => Call[] | Promise<Call[]>;
let callId = 0;
class Scripted implements IModelProvider {
  public readonly providerName = 'test';
  public readonly modelName = 'test';
  public calls = 0;
  public requests: ModelRequest[] = [];
  constructor(private steps: Step[]) {}
  async generate(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(JSON.parse(JSON.stringify({ ...req, abortSignal: undefined })));
    const step = this.steps[this.calls++];
    if (!step) throw new Error('scripted provider exhausted');
    const calls = await step(req, this.calls);
    return { text: '', toolCalls: calls.map(c => ({ id: `c${++callId}`, name: c.name, arguments: c.args })), finishReason: 'tool_calls', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
}
/** A model that never answers until the loop aborts it (a hung or slow provider). */
function hung(): IModelProvider {
  return {
    providerName: 'hung', modelName: 'hung',
    generate: req => new Promise((_res, rej) => req.abortSignal?.addEventListener('abort', () => rej(new Error('aborted')), { once: true }))
  };
}
const tool = (name: string, args: Record<string, any> = {}): Call[] => [{ name, args }];
const lastToolOutput = (req: ModelRequest): string => {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m: any = req.messages[i];
    if (m.role === 'tool') return String(m.content?.[0]?.output ?? '');
  }
  return '';
};

export async function run(): Promise<object> {
  const hits: Record<string, number> = {};
  const pages: Record<string, { title: string; body: string }> = {
    '/shopA': { title: 'Shop A', body: '<p>Aegis Widget X: $129.00 including tax</p>' },
    '/shopB': { title: 'Shop B', body: '<p>Aegis Widget X: $119.50 including tax</p>' },
    '/challenge': { title: 'Just a moment...', body: '<p>Checking your browser before accessing the site.</p>' }
  };
  const make = (): http.Server => http.createServer((req, res) => {
    const p = (req.url || '/').split('?')[0];
    hits[`${(req.headers.host || '').split(':')[0]}${p}`] = (hits[`${(req.headers.host || '').split(':')[0]}${p}`] || 0) + 1;
    const page = pages[p];
    if (!page) { res.writeHead(404).end('nope'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><head><title>${page.title}</title></head><body><h1>${page.title}</h1>${page.body}</body></html>`);
  });
  const server = make();
  await new Promise<void>(r => server.listen(0, r)); // dual stack: reachable as 127.0.0.1 and as localhost
  const port = (server.address() as AddressInfo).port;
  const url = (p: string, host = '127.0.0.1') => `http://${host}:${port}${p}`;

  const win = new BrowserWindow({ show: false, width: 1280, height: 800 });
  const hosts: WorkerHost[] = [];
  let seq = 0;
  const newWorker = (): WorkerHost => {
    const w = new WorkerHost({ id: `suite_worker_${++seq}`, missionId: 'suite', ordinal: seq, parentWindow: win, attachToWindow: true });
    hosts.push(w);
    return w;
  };
  const task = (id: string, path: string, over: Partial<ScheduledTask> = {}): ScheduledTask => ({
    id, missionId: 'suite', name: `Read ${path}`, role: 'researcher', url: url(path), instruction: `Report the price of Aegis Widget X from ${url(path)}`,
    priority: 10, dependencies: [], effectClass: 'read', maxRetries: 1, retryCount: 0, status: 'running', createdAt: Date.now(), ...over
  });
  const deps = (provider: IModelProvider, over: Partial<WorkerRunDeps> = {}): WorkerRunDeps => ({
    missionId: 'suite', provider, blackboard: new SharedBlackboard({ inMemory: true }), claims: new UrlClaims(),
    settings: { privacyMode: 'Standard', policyRules: [], maxSteps: 25, maxCostUSD: 1 },
    signal: new AbortController().signal, stepDelayMs: 0, settleMaxMs: 1500, ...over
  });
  const quoteA = 'Aegis Widget X: $129.00 including tax';

  try {
    // 1. acceptance (unit): a finding whose quote is not on the page gets a tool error and posts no evidence
    {
      const d = deps(new Scripted([
        () => tool('report_finding', { entity: 'Widget at Shop A', attribute: 'price', value: '$99.00', quote: 'Aegis Widget X: $99.00 including tax', url: url('/shopA') }),
        req => { check(/Finding rejected: The quote does not occur on the current page/.test(lastToolOutput(req)), 'rejected finding comes back to the model as a tool error'); check(d.blackboard.getAllEvidence().length === 0, 'no evidence was posted for the fabricated quote'); return tool('report_finding', { entity: 'Widget at Shop A', attribute: 'price', value: '$129.00', quote: quoteA, url: url('/shopA') }); },
        () => tool('finish_task', { status: 'completed', summary: 'Shop A lists $129.00' })
      ]));
      const r = await runWorkerTask(newWorker(), task('t1', '/shopA'), d);
      const ev = d.blackboard.getAllEvidence();
      check(r.status === 'completed' && r.findings === 1 && ev.length === 1, `valid finding recorded after the rejected one (findings ${r.findings}, evidence ${ev.length})`);
      check(ev[0]?.source.quote === quoteA && ev[0].source.url === url('/shopA') && ev[0].workerId === 'suite_worker_1', 'evidence carries the verified quote, the page url and the worker');
      pass('quote guard on a real page: fabricated quote -> tool error, no evidence; real quote -> evidence');
    }

    // 2. a researcher cannot finish "completed" with no findings; the loop has no done/fail/ask_user/tab tools for workers
    {
      const prov = new Scripted([
        () => tool('finish_task', { status: 'completed', summary: 'looks fine' }),
        req => { check(/not reported any finding/.test(lastToolOutput(req)), 'finish without findings is refused'); return tool('done', { result: 'x' }); },
        req => { check(/Unknown tool "done"/.test(lastToolOutput(req)), 'done is not available to a worker'); return tool('finish_task', { status: 'failed', summary: 'page has no price' }); }
      ]);
      const d = deps(prov);
      let err = '';
      await runWorkerTask(newWorker(), task('t2', '/shopB'), d).catch(e => { err = e.message; });
      check(/page has no price/.test(err), `failed finish_task fails the task with its reason (${err})`);
      const offered = prov.requests[0] as any;
      const names = (offered.tools || []).map((t: any) => t.name);
      check(names.includes('report_finding') && names.includes('finish_task') && !names.some((n: string) => ['done', 'fail', 'ask_user', 'open_tab', 'switch_tab', 'close_tab'].includes(n)), `worker tool set: ${names.join(',')}`);
      check(d.blackboard.getAllEvidence().length === 0, 'no evidence');
      pass('worker tools: report_finding + finish_task, no done/fail/ask_user/tab tools; empty "completed" refused');
    }

    // 3. step budget exhaustion fails the task with a reason
    {
      const steps: Step[] = Array.from({ length: 6 }, (_, i) => () => tool('wait', { ms: 100 + i }));
      let err = '';
      await runWorkerTask(newWorker(), task('t3', '/shopB'), deps(new Scripted(steps), { workerMaxSteps: 3 })).catch(e => { err = e.message; });
      check(/Step budget reached: 3 steps/.test(err), `step budget: ${err}`);
      pass('per-worker step budget ends the task with a reason');
    }

    // 4. wall-clock timeout is a task failure, not a cancel
    {
      const t0 = Date.now();
      let err = '';
      await runWorkerTask(newWorker(), task('t4', '/shopB'), deps(hung(), { workerTimeoutMs: 700 })).catch(e => { err = e.message; });
      check(/timed out/.test(err) && Date.now() - t0 < 5000, `wall-clock timeout: ${err} after ${Date.now() - t0} ms`);
      pass('wall-clock timeout fails the task');
    }

    // 5. stop: three workers, all stop within 1 s of the abort
    {
      const ac = new AbortController();
      const runs = ['/shopA', '/shopB', '/shopA'].map((p, i) => {
        const claims = new UrlClaims(); // separate missions' claims: same page on purpose
        return runWorkerTask(newWorker(), task(`t5_${i}`, p), deps(hung(), { signal: ac.signal, claims })).then(() => 'ended', e => String(e.message));
      });
      await sleep(900); // all three are inside their first model call
      const t0 = Date.now();
      ac.abort();
      const outcomes = await Promise.all(runs);
      const took = Date.now() - t0;
      check(outcomes.every(o => /cancelled/.test(o)) && took < 1000, `three workers stopped ${took} ms after abort: ${outcomes.join(' | ')}`);
      pass(`stop: three workers inside a model call all ended ${took} ms after the abort (< 1000 ms)`);
    }

    // 6. pause: no new model call starts while paused; resume continues
    {
      const gate = new PauseGate();
      const prov = new Scripted([
        () => { gate.pause(); return tool('wait', { ms: 100 }); },
        () => tool('wait', { ms: 101 }),
        () => tool('wait', { ms: 102 }),
        () => tool('report_finding', { entity: 'Widget at Shop A', attribute: 'price', value: '$129.00', quote: quoteA, url: url('/shopA') }),
        () => tool('finish_task', { status: 'completed', summary: 'done' })
      ]);
      const ac = new AbortController();
      const p = runWorkerTask(newWorker(), task('t6', '/shopA'), deps(prov, { waitWhilePaused: () => gate.wait(ac.signal), signal: ac.signal, claims: new UrlClaims() }));
      await sleep(1200);
      const heldAt = prov.calls;
      await sleep(1500);
      check(prov.calls === heldAt && heldAt === 1, `no new model call while paused (calls: ${heldAt} -> ${prov.calls})`);
      gate.resume();
      const r = await p;
      check(r.status === 'completed' && prov.calls === 5, `resumed and finished (calls ${prov.calls})`);
      pass('pause holds the worker before its next model call; resume lets it finish');
    }

    // 7. a bot challenge is needs_human, not a failure, and costs no model call
    {
      const prov = new Scripted([]);
      const r = await runWorkerTask(newWorker(), task('t7', '/challenge'), deps(prov));
      check(r.status === 'needs_human' && /Human verification|challenge|Roadblock|Cloudflare/i.test(r.reason || ''), `challenge result: ${JSON.stringify(r)}`);
      check(prov.calls === 0, 'the worker did not try to get past the challenge');
      pass('bot challenge page -> needs_human without a model call');
    }

    // 8. two workers on the same URL: the second is refused by the claim, the page is not loaded twice
    {
      const claims = new UrlClaims();
      const before = hits['127.0.0.1/shopA'] || 0;
      const a = deps(new Scripted([() => tool('report_finding', { entity: 'Widget at Shop A', attribute: 'price', value: '$129.00', quote: quoteA, url: url('/shopA') }), () => tool('finish_task', { status: 'completed', summary: 'ok' })]), { claims });
      await runWorkerTask(newWorker(), task('t8a', '/shopA'), a);
      const afterA = hits['127.0.0.1/shopA'] || 0;
      let seen = '';
      const b = deps(new Scripted([() => tool('navigate', { url: url('/shopA') }), req => { seen = lastToolOutput(req); return tool('finish_task', { status: 'failed', summary: 'covered elsewhere' }); }]), { claims });
      await runWorkerTask(newWorker(), task('t8b', '/shopB'), b).catch(() => undefined);
      check(afterA === before + 1, 'worker A loaded its page once');
      check(/already covers/.test(seen), `second worker refused: ${seen}`);
      check((hits['127.0.0.1/shopA'] || 0) === afterA, 'the refused navigation never loaded the page');
      pass('URL dedupe: a second worker is refused a page another worker covers');
    }

    // 9. one worker waits for approval while another finishes; the question names its worker
    {
      const questions: UserQuestion[] = [];
      let answer!: (a: string) => void;
      const askUser = (q: UserQuestion) => { questions.push(q); return new Promise<string>(r => { answer = r; }); };
      let otherDoneAt = 0;
      const needsApproval = runWorkerTask(newWorker(), task('t9a', '/shopA'), deps(new Scripted([
        () => tool('navigate', { url: url('/shopB', 'localhost') }),
        () => tool('finish_task', { status: 'failed', summary: 'stopped after approval' })
      ]), { askUser, claims: new UrlClaims() })).catch(() => undefined);
      const other = runWorkerTask(newWorker(), task('t9b', '/shopB'), deps(new Scripted([
        () => tool('report_finding', { entity: 'Widget at Shop B', attribute: 'price', value: '$119.50', quote: 'Aegis Widget X: $119.50 including tax', url: url('/shopB') }),
        () => tool('finish_task', { status: 'completed', summary: 'ok' })
      ]), { claims: new UrlClaims() })).then(r => { otherDoneAt = Date.now(); return r; });
      const otherResult = await other;
      check(otherResult.status === 'completed' && questions.length === 1, `other worker finished (${otherResult.status}) while 1 question is open (${questions.length})`);
      check(/^Ada:|^Bram:|^[A-Z][a-z]+:/.test(questions[0]?.text || '') && /localhost/.test(questions[0]?.text || '') && questions[0]?.kind === 'approval', `question names the worker: ${questions[0]?.text.slice(0, 90)}`);
      check((hits['localhost/shopB'] || 0) === 0, 'the approval-gated navigation has not happened yet');
      const answeredAt = Date.now();
      answer('Approve');
      await needsApproval;
      check(otherDoneAt <= answeredAt && (hits['localhost/shopB'] || 0) === 1, `after approval the navigation happened once (hits ${JSON.stringify(hits)}, otherDoneAt<=answeredAt: ${otherDoneAt <= answeredAt})`);
      pass('approval: one worker waits for the user while another worker finishes its task');
    }
  } catch (err: any) {
    failures.push(`suite crashed: ${err.stack || err}`);
  } finally {
    for (const h of hosts) await h.teardown().catch(() => undefined);
    win.destroy();
    server.closeAllConnections?.();
    server.close();
  }
  return { log, failed: failures.length, failures };
}
