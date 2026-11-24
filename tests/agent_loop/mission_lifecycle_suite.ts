/**
 * #226 (RUN-04) acceptance suite, run inside real Electron (tests/test_mission_lifecycle.ts launches it).
 *
 * The REAL AgentRuntime, AgentLoop, ViewManager, governor, policy engine and Chromium pages. Only the model is
 * scripted (a function of the request it receives), except in the cancel scenario where the REAL OpenAI provider talks
 * to a local server that never answers. Assertions read the runtime's own mission:status events, the page and the
 * fixture server's order counter, not tool return strings.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { BrowserWindow } from 'electron';
import { ViewManager } from '../../src/main/view_manager.js';
import { AgentRuntime } from '../../src/agent/runtime.js';
import { OpenAIModelProvider } from '../../src/models/openai_provider.js';
import type { IModelProvider, ModelRequest, ModelResponse, CanonicalMessage } from '../../src/models/types.js';
import type { MissionStatusPayload, MissionQuestionPayload } from '../../src/ipc/contract.js';
import { readCheckpoint, checkpointFile } from '../../src/agent/mission_checkpoint.js';
import { startFixtureShop, FixtureShop } from '../helpers/fixture_shop.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(25);
  }
}
const defer = <T = void>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

// ------------------------------------------------------------------ scripted model (test only)
interface Call { name: string; arguments: Record<string, any> }
type Step = (req: ModelRequest, obs: string) => Promise<Call> | Call;
let callSeq = 0;
const tc = (name: string, args: Record<string, any> = {}): Call => ({ name, arguments: args });

function lastObservation(messages: CanonicalMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[Page State - Isolated')) return m.content;
  }
  return '';
}
function refIn(obs: string, name: string): string {
  for (const line of obs.split('\n')) {
    const m = line.match(/^\[(e\d+)\] .*"([^"]*)"/);
    if (m && m[2].includes(name)) return m[1];
  }
  throw new Error(`no element named "${name}" in observation:\n${obs.slice(0, 1200)}`);
}

class ScriptProvider implements IModelProvider {
  // Unique per instance: the governor's circuit breaker is process-wide and keyed by provider name.
  public readonly providerName = `test-script-${++callSeq}`;
  public readonly modelName = 'test-script';
  public seen: Array<{ messages: CanonicalMessage[]; obs: string }> = [];
  constructor(private steps: Step[]) {}
  async generate(req: ModelRequest): Promise<ModelResponse> {
    const obs = lastObservation(req.messages);
    this.seen.push({ messages: JSON.parse(JSON.stringify(req.messages)), obs });
    const fn = this.steps.shift();
    if (!fn) throw new Error('scripted provider: script exhausted');
    const aborted = new Promise<never>((_, rej) => req.abortSignal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
    const call = await Promise.race([Promise.resolve(fn(req, obs)), aborted]);
    return { text: '', toolCalls: [{ id: `call_${++callSeq}`, name: call.name, arguments: call.arguments }], finishReason: 'tool_calls', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
}
const passVerifier = () => new ScriptProvider(Array.from({ length: 6 }, () => () => tc('report_verdict', { pass: true, reasons: ['supported by the page'] })));
const done = (result = 'finished', evidence: string[] = []): Step => () => tc('done', { result, evidence });

// ------------------------------------------------------------------ harness
interface Ctx { shop: FixtureShop; altShop: string; vm: ViewManager; win: BrowserWindow; tmp: string }

function track(rt: AgentRuntime) {
  const statuses: MissionStatusPayload[] = [];
  const questions: MissionQuestionPayload[] = [];
  const evidence: string[] = [];
  rt.events.on('status', (p: MissionStatusPayload) => statuses.push(p));
  rt.events.on('question', (q: MissionQuestionPayload) => questions.push(q));
  rt.events.on('evidence', (e: { text: string }) => evidence.push(e.text));
  return { statuses, questions, evidence, states: () => statuses.map(s => s.status) };
}

function mkRuntime(ctx: Ctx, holder: { prov: IModelProvider; verifier?: IModelProvider; boom?: string }, userData = fs.mkdtempSync(path.join(ctx.tmp, 'ud-'))) {
  const rt = AgentRuntime.createDetached(ctx.win, ctx.vm, {
    strict: true,
    inspect: () => ({ configured: true }),
    createProvider: async () => { if (holder.boom) throw new Error(holder.boom); return holder.prov; },
    createVerifierProvider: async () => holder.verifier ?? passVerifier(),
    userDataDir: () => userData,
    stepDelayMs: 30,
    settleMaxMs: 1500
  });
  const t = track(rt);
  lastDiag = () => `states=${t.states().join('>')} error=${rt.getActiveMission()?.error ?? '-'} lastEvidence=${t.evidence.slice(-4).join(' | ')}`;
  return { rt, userData, t };
}
let lastDiag: () => string = () => '';
function autoApprove(rt: AgentRuntime): void {
  rt.events.on('question', (q: MissionQuestionPayload) => { if (q.kind === 'approval') setTimeout(() => rt.answerQuestion(q.missionId, q.id, 'Approve'), 50); });
}

async function resetTabs(ctx: Ctx): Promise<void> {
  const fresh = ctx.vm.createTab('about:blank', false, 'user');
  ctx.vm.setActiveTab(fresh.id);
  for (const t of ctx.vm.listTabs()) if (t.id !== fresh.id) ctx.vm.closeTab(t.id);
  await sleep(50);
}

async function startOk(rt: AgentRuntime, prompt: string): Promise<string> {
  const r = await rt.startMission(prompt, 'test-model');
  assert.equal(r.ok, true, `startMission refused: ${JSON.stringify(r)}`);
  return r.missionId!;
}

async function neverAnswers(): Promise<{ url: string; requests: () => number; closed: () => number; stop: () => Promise<void> }> {
  let count = 0, closed = 0;
  const server = http.createServer((r) => { count++; r.on('close', () => { closed++; }); r.resume(); });
  await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: () => count, closed: () => closed, stop: () => new Promise(res => { server.closeAllConnections(); server.close(() => res()); }) };
}

let unhandled = 0;
const scenarios: Array<[string, (ctx: Ctx) => Promise<string>]> = [];
const scenario = (name: string, fn: (ctx: Ctx) => Promise<string>) => scenarios.push([name, fn]);

// ------------------------------------------------------------------ scenarios
scenario('lifecycle: planning -> running -> completed, one mission:status event per transition', async ctx => {
  const prov = new ScriptProvider([() => tc('navigate', { url: `${ctx.shop.base}/shop` }), done('The shop heading is Fixture shop', ['h1: Fixture shop'])]);
  const { rt, userData, t } = mkRuntime(ctx, { prov });
  const cwdHadMissions = fs.existsSync(path.join(process.cwd(), 'missions'));
  await startOk(rt, `Open ${ctx.shop.base}/shop and report the heading`);
  await until(() => t.states().includes('completed'), 20000, 'completed');
  assert.deepEqual(t.states(), ['planning', 'running', 'completed']);
  assert.deepEqual(t.statuses.map(s => s.seq), [1, 2, 3]);
  for (let i = 1; i < t.statuses.length; i++) assert.ok(t.statuses[i].ts! >= t.statuses[i - 1].ts!, 'ts never decreases');
  assert.ok(t.statuses.every(s => s.reason && s.missionId === t.statuses[0].missionId));
  assert.equal(rt.isIdle(), true);
  assert.equal(rt.getState(), 'idle');
  const cp = readCheckpoint(userData, t.statuses[0].missionId!)!;
  assert.equal(cp.state, 'completed');
  assert.ok(fs.existsSync(checkpointFile(userData, cp.missionId)), 'checkpoint is under the app data dir');
  assert.equal(fs.existsSync(path.join(process.cwd(), 'missions')), cwdHadMissions, 'nothing created in the repo/cwd');
  return `states=${t.states().join('>')} reasons=${t.statuses.map(s => s.reason).join(',')}`;
});

scenario('single-mission rule: a second start returns MISSION_ACTIVE, creates nothing, and works after the first ends', async ctx => {
  const gate = defer();
  const holder = { prov: new ScriptProvider([async () => { await gate.promise; return tc('wait', { ms: 100 }); }]) as IModelProvider };
  const { rt, t } = mkRuntime(ctx, holder);
  const a = await startOk(rt, `Open ${ctx.shop.base}/shop`);
  const tabsBefore = ctx.vm.listTabs().length;
  const b = await rt.startMission('another goal', 'test-model');
  assert.equal(b.ok, false);
  assert.equal(b.code, 'MISSION_ACTIVE');
  assert.equal(b.missionId, undefined);
  assert.equal(ctx.vm.listTabs().length, tabsBefore, 'the refused start opened no tab');
  assert.ok(t.statuses.every(s => s.missionId === a), 'no status event for the refused mission');
  rt.cancel();
  assert.equal(rt.isIdle(), true);
  holder.prov = new ScriptProvider([done('ok')]);
  const c = await rt.startMission(`Open ${ctx.shop.base}/shop`, 'test-model');
  assert.equal(c.ok, true, 'a new mission can start after the previous one ended');
  await until(() => t.states().filter(s => s === 'completed').length === 1, 20000, 'second mission completed');
  return `refused with ${b.code}; restart after cancel ok`;
});

scenario('cancel during a REAL model call: back to idle < 1 s, the request is aborted, no further network calls', async ctx => {
  const hang = await neverAnswers();
  const holder = { prov: new OpenAIModelProvider({ apiKey: 'k', baseURL: `${hang.url}/v1`, modelName: 'gpt-test' }) as IModelProvider };
  const { rt, t } = mkRuntime(ctx, holder);
  try {
    await startOk(rt, `Open ${ctx.shop.base}/shop`);
    await until(() => hang.requests() >= 1, 20000, 'the model request to reach the server');
    const t0 = Date.now();
    rt.cancel();
    assert.equal(rt.isIdle(), true, 'idle immediately after cancel()');
    assert.equal(rt.getState(), 'idle');
    assert.equal(t.states().at(-1), 'cancelled');
    await until(() => hang.closed() >= 1, 1000, 'the model HTTP connection to be closed');
    await until(() => (rt as any).activeLoop === null, 1000, 'the loop to unwind');
    const took = Date.now() - t0;
    assert.ok(took < 1000, `cancel -> idle + aborted request + loop unwound took ${took} ms`);
    await sleep(2800); // longer than the governor's first retry delay
    assert.equal(hang.requests(), 1, 'no further network call after cancel');
    return `cancelled, request closed and loop unwound in ${took} ms, ${hang.requests()} request total`;
  } finally { await hang.stop(); }
});

scenario('cancel during a tool call (wait 5 s): the loop unwinds < 1 s', async ctx => {
  const { rt, t } = mkRuntime(ctx, { prov: new ScriptProvider([() => tc('wait', { ms: 5000 })]) });
  await startOk(rt, `Open ${ctx.shop.base}/shop`);
  await until(() => t.evidence.some(e => e.startsWith('[Action] wait')), 20000, 'the wait action to start');
  const t0 = Date.now();
  rt.cancel();
  await until(() => (rt as any).activeLoop === null, 1000, 'the loop to unwind');
  assert.equal(rt.isIdle(), true);
  assert.equal(t.states().at(-1), 'cancelled');
  return `loop unwound ${Date.now() - t0} ms after cancel while a 5000 ms tool was running`;
});

scenario('pause / resume / takeover / hand back: the state follows, and nothing runs while paused', async ctx => {
  const g1 = defer(), g2 = defer();
  const prov = new ScriptProvider([
    async () => { await g1.promise; return tc('wait', { ms: 100 }); },
    async () => { await g2.promise; return tc('wait', { ms: 100 }); },
    done('ok')
  ]);
  const { rt, t } = mkRuntime(ctx, { prov });
  await startOk(rt, `Open ${ctx.shop.base}/shop`);
  const actions = () => t.evidence.filter(e => e.startsWith('[Action] wait')).length;
  await until(() => prov.seen.length === 1, 20000, 'model call 1 in flight');
  rt.resume(); // not paused: no event
  await rt.handBack(); // not in takeover: no event
  rt.pause();
  rt.pause(); // already paused: no second event
  assert.equal(rt.getState(), 'paused');
  g1.resolve(); // the model answers while paused
  await sleep(800);
  assert.equal(actions(), 0, 'the model answer is NOT executed while paused');
  rt.resume();
  await until(() => actions() === 1, 10000, 'the action to run after resume');
  await until(() => prov.seen.length === 2, 10000, 'model call 2 in flight');
  rt.takeover();
  assert.equal(rt.getState(), 'takeover');
  g2.resolve();
  await sleep(800);
  assert.equal(actions(), 1, 'nothing runs during takeover');
  await rt.handBack();
  assert.equal(rt.getState(), 'running');
  await until(() => t.states().includes('completed'), 20000, 'completed');
  assert.deepEqual(t.states(), ['planning', 'running', 'paused', 'running', 'takeover', 'running', 'completed']);
  assert.deepEqual(t.statuses.map(s => s.seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(t.statuses.map(s => s.reason), ['mission_started', 'loop_started', 'user_pause', 'user_resume', 'user_takeover', 'user_handback', 'loop_finished']);
  return t.states().join('>');
});

scenario('questions: ask_user -> waiting_user, policy approval -> waiting_approval, each back to running', async ctx => {
  const prov = new ScriptProvider([
    () => tc('ask_user', { question: 'Which colour?', options: ['Blue', 'Red'] }),
    () => tc('navigate', { url: `${ctx.altShop}/shop` }),
    done('ok')
  ]);
  const { rt, t } = mkRuntime(ctx, { prov });
  rt.events.on('question', (q: MissionQuestionPayload) => setTimeout(() => rt.answerQuestion(q.missionId, q.id, q.kind === 'approval' ? 'Approve' : 'Blue'), 100));
  await startOk(rt, `Open ${ctx.shop.base}/shop`);
  await until(() => t.states().includes('completed'), 30000, 'completed');
  assert.deepEqual(t.states(), ['planning', 'running', 'waiting_user', 'running', 'waiting_approval', 'running', 'completed']);
  assert.deepEqual(t.questions.map(q => q.kind), ['question', 'approval']);
  return t.states().join('>');
});

scenario('errors never escape: a throwing provider factory and a failing model call end as failed with a readable message', async ctx => {
  const holder: { prov: IModelProvider; boom?: string } = { prov: new ScriptProvider([]), boom: 'provider exploded' };
  const { rt, t } = mkRuntime(ctx, holder);
  await startOk(rt, `Open ${ctx.shop.base}/shop`);
  await until(() => t.states().includes('failed'), 20000, 'failed');
  assert.deepEqual(t.states(), ['planning', 'running', 'failed']);
  assert.equal(t.statuses.at(-1)!.reason, 'loop_error');
  assert.match(rt.getActiveMission()!.error!, /internal error: provider exploded/);
  assert.equal(rt.isIdle(), true);

  holder.boom = undefined;
  holder.prov = new ScriptProvider([() => { throw Object.assign(new Error('upstream down'), { status: 401 }); }]); // 401: the governor fails fast, no retry
  const before = t.statuses.length;
  await startOk(rt, `Open ${ctx.shop.base}/shop`);
  await until(() => t.states().slice(before).includes('failed'), 20000, 'second failure');
  assert.match(rt.getActiveMission()!.error!, /Model error: upstream down/);
  assert.equal(unhandled, 0, 'no unhandledRejection reached the process');

  holder.prov = new ScriptProvider([done('recovered')]);
  const before2 = t.statuses.length;
  await startOk(rt, `Open ${ctx.shop.base}/shop`);
  await until(() => t.states().slice(before2).includes('completed'), 20000, 'a mission works after two failures');
  return 'failed(loop_error) with message; failed(Model error); then a normal mission completed';
});

for (const answer of ['Reload page', 'Skip'] as const) {
  scenario(`tab crash (${answer}): the mission pauses with a banner question, nothing runs, then continues`, async ctx => {
    const gate = defer();
    const second: Step = async () => { await gate.promise; return tc('wait', { ms: 100 }); };
    const steps: Step[] = answer === 'Reload page'
      ? [() => tc('navigate', { url: `${ctx.shop.base}/shop` }), second, done('after reload')]
      : [() => tc('navigate', { url: `${ctx.shop.base}/shop` }), second, () => tc('navigate', { url: `${ctx.shop.base}/shop` }), done('after skip')];
    const prov = new ScriptProvider(steps);
    const { rt, t } = mkRuntime(ctx, { prov });
    await startOk(rt, `Open ${ctx.shop.base}/shop`);
    await until(() => prov.seen.length === 2, 20000, 'model call 2 in flight');
    const tab = ctx.vm.getActiveTab()!;
    const missionTabBefore = rt.getActiveMission()!.tabId;
    tab.view.webContents.forcefullyCrashRenderer();
    await until(() => t.states().includes('paused'), 10000, 'paused after the crash');
    const paused = t.statuses.find(s => s.status === 'paused')!;
    assert.equal(paused.reason, 'tab_crashed');
    await until(() => t.questions.length === 1, 2000, 'the crash question');
    assert.equal(t.questions[0].kind, 'crash');
    assert.deepEqual(t.questions[0].options, ['Reload page', 'Skip']);
    assert.equal(tab.state.isCrashed, true, 'the view manager knows the tab is dead');
    rt.resume(); // the Pause button is disabled in the UI; the runtime also refuses to continue on a dead page
    assert.equal(rt.getState(), 'paused', 'resume() is refused while the crash question is open');
    gate.resolve();
    await sleep(800);
    assert.equal(t.evidence.filter(e => e.startsWith('[Action] wait')).length, 0, 'nothing runs while paused after a crash');
    assert.deepEqual(rt.answerQuestion(t.questions[0].missionId, t.questions[0].id, answer), { ok: true });
    await until(() => t.states().includes('completed'), 30000, 'completed after the crash answer');
    const run = t.statuses.find(s => s.seq === paused.seq + 1)!;
    assert.equal(run.status, 'running');
    assert.equal(run.reason, answer === 'Reload page' ? 'crash_reload' : 'crash_skip');
    if (answer === 'Reload page') {
      assert.equal(rt.getActiveMission()!.tabId, missionTabBefore, 'same tab, reloaded');
      assert.equal(tab.state.isCrashed, false, 'the reloaded tab is alive again');
      const last = prov.seen.at(-1)!;
      assert.ok(last.obs.includes('Fixture shop'), 'the next observation is of the reloaded page');
    } else {
      assert.notEqual(rt.getActiveMission()!.tabId, missionTabBefore, 'the mission moved to a fresh tab');
      const noticeSeen = prov.seen.at(-1)!.messages.some(m => typeof m.content === 'string' && m.content.includes('the user chose to skip it'));
      assert.ok(noticeSeen, 'the model was told the page was skipped');
    }
    return `paused(tab_crashed) -> ${answer} -> ${run.reason} -> completed`;
  });
}

scenario('checkpoint + resume: killed after the submit, relaunch offers the mission, resume does NOT repeat the order', async ctx => {
  // --- first process: navigate, place the order (the side effect), then the model call that never returns (the kill)
  const hold = defer();
  const prov1 = new ScriptProvider([
    () => tc('navigate', { url: `${ctx.shop.base}/shop` }),
    (_r, obs) => tc('click', { ref: refIn(obs, 'Place order') }),
    async () => { await hold.promise; return tc('wait', { ms: 100 }); }
  ]);
  const a = mkRuntime(ctx, { prov: prov1 });
  autoApprove(a.rt); // the policy asks before a financial click
  const goal = `Buy Widget Pro at ${ctx.shop.base}/shop and report the confirmation`;
  const id1 = await startOk(a.rt, goal);
  await until(() => prov1.seen.length === 3, 30000, 'model call 3 in flight (after the order was placed)');
  assert.equal(ctx.shop.orders(), 1, 'the order was placed once');
  const file = checkpointFile(a.userData, id1);
  const dead = fs.readFileSync(file); // what a killed process leaves behind
  const cp = JSON.parse(dead.toString());
  assert.equal(cp.state, 'running');
  assert.ok(String(cp.url).endsWith('/confirmation'), `checkpoint url is the page after the click: ${cp.url}`);
  const click = cp.actions.find((x: any) => x.tool === 'click');
  assert.ok(click && click.sideEffect === true && click.phase === 'done' && /Place order/.test(click.summary), JSON.stringify(cp.actions));
  a.rt.cancel(); // tears the first "process" down in the test; then put back the bytes the kill would have left
  fs.writeFileSync(file, dead);
  hold.resolve();
  await resetTabs(ctx);

  // --- second process: same app data dir
  let ordersAtFirstCall = -1;
  const prov2 = new ScriptProvider([(_r, obs) => { ordersAtFirstCall = ctx.shop.orders(); assert.ok(obs.includes('Order confirmed'), 'the re-opened page was observed'); return tc('done', { result: 'The order was confirmed', evidence: ['Order confirmed'] }); }]);
  const b = mkRuntime(ctx, { prov: prov2 }, a.userData);
  const offer = b.rt.getInterruptedMission();
  assert.ok(offer, 'the interrupted mission is offered on relaunch');
  assert.equal(offer!.missionId, id1);
  assert.equal(offer!.prompt, goal);
  assert.ok(offer!.performed.some(p => /click.*Place order/.test(p)), `performed list: ${offer!.performed.join(' | ')}`);
  assert.equal(offer!.unknownOutcome, undefined);
  assert.equal((await b.rt.resumeInterrupted('nope')).ok, false);
  const r = await b.rt.resumeInterrupted(id1);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.notEqual(r.missionId, id1, 'the resumed run is a new mission');
  await until(() => b.t.states().includes('completed'), 30000, 'resumed mission completed');
  assert.equal(ordersAtFirstCall, 1, 'no order was placed between relaunch and the first model decision');
  assert.equal(ctx.shop.orders(), 1, 'the submit step was not repeated');
  const first = prov2.seen[0].messages.find(m => typeof m.content === 'string' && m.content.startsWith('User Goal'))!.content as string;
  assert.match(first, /\[Resumed mission\]/);
  assert.match(first, /do NOT repeat them/);
  assert.match(first, /Place order/);
  assert.equal(b.rt.getInterruptedMission(), null, 'offered once: consumed after the resume');
  assert.equal(fs.existsSync(file), false, 'the old checkpoint was removed');
  assert.equal(readCheckpoint(a.userData, r.missionId!)!.resumedFrom, id1);
  return `offered ${id1}; resumed as ${r.missionId}; orders=${ctx.shop.orders()} before and after`;
});

scenario('checkpoint: an action that was in flight when the process died is reported as unknown, not as done', async ctx => {
  const hold = defer();
  const prov = new ScriptProvider([
    () => tc('navigate', { url: `${ctx.shop.base}/shop` }),
    (_r, obs) => tc('click', { ref: refIn(obs, 'Place order') })
  ]);
  const a = mkRuntime(ctx, { prov });
  autoApprove(a.rt);
  const id = await startOk(a.rt, `Buy at ${ctx.shop.base}/shop`);
  await until(() => a.t.evidence.some(e => e.startsWith('[Action] click')), 30000, 'the click to start');
  const file = checkpointFile(a.userData, id);
  // The checkpoint is written BEFORE the tool runs: the on-disk record at that moment has the click in flight.
  const cp = readCheckpoint(a.userData, id)!;
  const hasClick = cp.actions.some(x => x.tool === 'click');
  assert.ok(hasClick, 'the in-flight click is on disk');
  a.rt.cancel();
  hold.resolve();
  // Rebuild the dead process's file: the click still in flight.
  const inflight = { ...cp, state: 'running' as const, actions: cp.actions.map(x => x.tool === 'click' ? { ...x, phase: 'in_flight' as const, ok: undefined } : x) };
  fs.writeFileSync(file, JSON.stringify(inflight));
  const b = mkRuntime(ctx, { prov: new ScriptProvider([]) }, a.userData);
  const offer = b.rt.getInterruptedMission()!;
  assert.match(offer.unknownOutcome!, /click.*Place order/);
  assert.equal(offer.performed.length, 0, 'an in-flight click is not listed as performed');
  return `unknownOutcome=${offer.unknownOutcome}`;
});

scenario('no unhandledRejection reached the process during the whole suite', async () => {
  assert.equal(unhandled, 0);
  return 'ok';
});

// ------------------------------------------------------------------ entry
export async function run() {
  process.on('unhandledRejection', () => { unhandled++; });
  const shop = await startFixtureShop();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-lifecycle-'));
  const win = new BrowserWindow({ width: 1200, height: 860, show: true, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL('about:blank');
  const vm = new ViewManager(win);
  vm.createTab('about:blank', false, 'user');
  const ctx: Ctx = { shop, altShop: `http://localhost:${shop.port}`, vm, win, tmp };
  const only = process.env.LIFECYCLE_ONLY;
  const results: Array<{ name: string; ok: boolean; detail: string; ms: number }> = [];
  for (const [name, fn] of scenarios) {
    if (only && !name.includes(only)) continue;
    const t0 = Date.now();
    try {
      results.push({ name, ok: true, detail: await fn(ctx), ms: Date.now() - t0 });
    } catch (err: any) {
      results.push({ name, ok: false, detail: `${String(err?.stack || err).slice(0, 2000)}\n[diag] ${lastDiag()}`, ms: Date.now() - t0 });
    }
    try { await resetTabs(ctx); } catch { /* best effort */ }
  }
  win.destroy();
  await shop.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* locked on Windows */ }
  return { results };
}
