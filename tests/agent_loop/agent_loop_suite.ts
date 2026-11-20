/**
 * #225 acceptance suite, run inside real Electron (tests/test_agent_loop.ts launches it).
 *
 * The REAL `AgentLoop`, `ToolExecutor`, `ActionExecutor`, `PerceptionEngine`, `ViewManager` and policy engine drive
 * real Chromium pages served by the fixture arena (`/agent/*`, `/content`). Only the model is scripted: each step is a
 * function of the request it receives (it reads element refs out of the real observation), so nothing about the page
 * is assumed. Assertions check the PAGE's own state (`window.__events`, DOM, URL) and the loop's history, not the
 * tools' return strings.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { BrowserWindow, nativeImage } from 'electron';
import { WebArenaServer } from '../../src/testing/arena_server.js';
import { ViewManager, TabView } from '../../src/main/view_manager.js';
import { AgentLoop, AgentLoopDeps, LoopOutcome, UserQuestion, MAX_NUDGES } from '../../src/agent/agent_loop.js';
import { AgentTabHost } from '../../src/agent/tools.js';
import type { IModelProvider, ModelRequest, ModelResponse, CanonicalMessage } from '../../src/models/types.js';
import { OpenAIModelProvider } from '../../src/models/openai_provider.js';
import { UsageLedger } from '../../src/models/pricing.js';
import type { PolicyRule } from '../../src/security/action_policy.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ scripted model (test only)
interface Call { name: string; arguments: Record<string, any>; id?: string }
interface StepOut { text?: string; toolCalls?: Call[] }
interface Seen { messages: CanonicalMessage[]; obs: string; systemPrompt?: string; tools: string[]; at: number }
type StepFn = (s: { obs: string; ref: (name: string) => string; req: ModelRequest }) => StepOut | Promise<StepOut>;

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
  throw new Error(`no element named "${name}" in observation:\n${obs.slice(0, 1500)}`);
}

let callSeq = 0;
class FnProvider implements IModelProvider {
  public readonly providerName = 'test-fn';
  public readonly modelName = 'test-fn';
  public seen: Seen[] = [];
  constructor(private steps: StepFn[], private usage?: { promptTokens: number; completionTokens: number }, private light = false) {}
  async generate(req: ModelRequest): Promise<ModelResponse> {
    if (req.abortSignal?.aborted) throw new Error('aborted');
    const obs = lastObservation(req.messages);
    this.seen.push({ messages: this.light ? [] : JSON.parse(JSON.stringify(req.messages)), obs: this.light ? '' : obs, systemPrompt: req.systemPrompt, tools: (req.tools || []).map(t => t.name), at: Date.now() });
    const fn = this.steps.shift();
    if (!fn) throw new Error('scripted test provider: script exhausted');
    const out = await fn({ obs, ref: n => refIn(obs, n), req });
    const toolCalls = (out.toolCalls || []).map(c => ({ id: c.id || `call_${++callSeq}`, name: c.name, arguments: c.arguments }));
    return {
      text: out.text || '',
      toolCalls,
      finishReason: toolCalls.length ? 'tool_calls' : 'stop',
      usage: this.usage ? { ...this.usage, totalTokens: this.usage.promptTokens + this.usage.completionTokens } : { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    };
  }
}
const tc = (name: string, args: Record<string, any> = {}): StepOut => ({ toolCalls: [{ name, arguments: args }] });
const pass = (reasons = ['supported by the page']): StepFn => () => tc('report_verdict', { pass: true, reasons });
const reject = (reasons: string[]): StepFn => () => tc('report_verdict', { pass: false, reasons });

// ------------------------------------------------------------------ harness
interface Ctx { base: string; altBase: string; vm: ViewManager; win: BrowserWindow }

interface RunOpts {
  url: string;
  steps: StepFn[];
  verifier?: StepFn[];
  goal?: string;
  rules?: PolicyRule[];
  answers?: Array<string | ((q: UserQuestion) => string)>;
  answerDelayMs?: number;
  maxSteps?: number;
  maxCostUSD?: number;
  missionDir?: string;
  usage?: { promptTokens: number; completionTokens: number };
  light?: boolean;
  privacyMode?: 'Standard' | 'Careful' | 'Local-only';
  signal?: AbortSignal;
  provider?: IModelProvider;
}

interface RunResult {
  outcome: LoopOutcome;
  loop: AgentLoop;
  provider: FnProvider;
  verifier: FnProvider;
  questions: Array<UserQuestion & { providerCallsAtAsk: number; providerCallsAtAnswer: number }>;
  statuses: string[];
  events: Array<{ kind: string; data: any }>;
  tab: TabView;
  pageEvents: () => Promise<string[]>;
}

let missionSeq = 0;
async function runMission(ctx: Ctx, o: RunOpts): Promise<RunResult> {
  const missionId = `t${++missionSeq}`;
  const tab = ctx.vm.createTab(o.url, false, `agent:${missionId}`);
  await tab.executor.ensureReady();
  const provider = new FnProvider(o.steps, o.usage, o.light);
  const verifier = new FnProvider(o.verifier || []);
  const questions: RunResult['questions'] = [];
  const statuses: string[] = [];
  const events: Array<{ kind: string; data: any }> = [];
  const answers = [...(o.answers || [])];
  const host: AgentTabHost = {
    open: (url, owner) => ctx.vm.createTab(url, false, owner),
    activate: id => ctx.vm.setActiveTab(id),
    close: id => ctx.vm.closeTab(id),
    list: () => ctx.vm.listTabs()
  };
  const realProvider = o.provider || provider;
  const deps: AgentLoopDeps = {
    missionId,
    goal: o.goal || 'Test goal',
    model: 'gemini-2.0-flash',
    tab,
    provider: realProvider,
    verifier,
    settings: { privacyMode: o.privacyMode || 'Careful', policyRules: o.rules || [], maxSteps: o.maxSteps ?? 20, maxCostUSD: o.maxCostUSD ?? 5 },
    emit: {
      evidence: () => {},
      status: s => statuses.push(s),
      event: (kind, data) => events.push({ kind, data })
    },
    history: [],
    signal: o.signal || new AbortController().signal,
    askUser: async q => {
      const rec = { ...q, providerCallsAtAsk: provider.seen.length, providerCallsAtAnswer: -1 };
      questions.push(rec);
      await sleep(o.answerDelayMs ?? 50);
      rec.providerCallsAtAnswer = provider.seen.length;
      const a = answers.shift();
      if (a === undefined) throw new Error(`unexpected question: ${q.text}`);
      return typeof a === 'function' ? a(q) : a;
    },
    tabs: host,
    missionDir: o.missionDir,
    usage: new UsageLedger(),
    stepDelayMs: 0,
    settleMaxMs: 3000
  };
  const loop = new AgentLoop(deps);
  const outcome = await loop.run();
  const pageEvents = async () => (await loop.tab.view.webContents.executeJavaScript('window.__events || []')) as string[];
  return { outcome, loop, provider, verifier, questions, statuses, events, tab, pageEvents };
}

function toolResults(history: CanonicalMessage[]): Array<{ id: string; output: string; isError?: boolean }> {
  return history.filter(m => m.role === 'tool').flatMap(m => (m.content as any[]).map(b => ({ id: b.toolCallId, output: b.output, isError: b.isError })));
}
function toolCallIds(history: CanonicalMessage[]): string[] {
  return history.filter(m => m.role === 'assistant' && Array.isArray(m.content)).flatMap(m => (m.content as any[]).filter(b => b.type === 'tool_call').map(b => b.id));
}
/** Real providers reject a history where a tool_call has no tool_result. */
function assertPaired(history: CanonicalMessage[]): void {
  const results = new Set(toolResults(history).map(r => r.id));
  for (const id of toolCallIds(history)) assert.ok(results.has(id), `tool_call ${id} has no tool_result`);
}

// ------------------------------------------------------------------ scenarios
const scenarios: Array<[string, (c: Ctx) => Promise<string>]> = [];
const scenario = (name: string, fn: (c: Ctx) => Promise<string>) => scenarios.push([name, fn]);

scenario('select_option: native <select> and ARIA listbox', async c => {
  const r = await runMission(c, {
    url: `${c.base}/agent/select`,
    goal: 'Choose size Large and colour Green',
    steps: [
      ({ ref }) => tc('select_option', { ref: ref('Shirt size'), label: 'Large' }),
      ({ ref }) => tc('select_option', { ref: ref('Colour'), label: 'Green' }),
      () => tc('done', { result: 'Size Large and colour Green are selected' })
    ],
    verifier: [pass()]
  });
  const ev = await r.pageEvents();
  const outputs = JSON.stringify(toolResults(r.loop.history).map(t => t.output));
  assert.ok(ev.includes('size=l'), `page saw ${JSON.stringify(ev)}; tool results ${outputs}`);
  assert.ok(ev.includes('color=Green'), `page saw ${JSON.stringify(ev)}; tool results ${outputs}`);
  assert.equal(r.outcome.state, 'completed');
  assert.ok(/options=\[[^\]]*\*Large/.test(r.provider.seen[2].obs), 'third observation shows Large selected');
  assertPaired(r.loop.history);
  return `page events ${JSON.stringify(ev)}`;
});

scenario('hover reveals a menu that the next observation contains', async c => {
  const r = await runMission(c, {
    url: `${c.base}/agent/hover`,
    steps: [
      ({ obs, ref }) => { assert.ok(!obs.includes('Secret settings'), 'menu hidden before hover'); return tc('hover', { ref: ref('Account menu') }); },
      ({ obs, ref }) => { assert.ok(obs.includes('Secret settings'), 'menu visible after hover'); return tc('click', { ref: ref('Secret settings') }); },
      ({ obs }) => { assert.ok(/URL: .*\/agent\/nav\/b/.test(obs), 'click on the revealed link navigated'); return tc('done', { result: 'Opened secret settings' }); }
    ],
    verifier: [pass()]
  });
  assert.equal(r.outcome.state, 'completed', String(r.outcome.error));
  return 'hover -> menu -> click -> page B';
});

scenario('drag: HTML5 drag-and-drop reaches the drop zone', async c => {
  const r = await runMission(c, {
    url: `${c.base}/agent/drag`,
    steps: [({ ref }) => tc('drag', { fromRef: ref('Drag card'), toRef: ref('Drop zone') }), () => tc('done', { result: 'dropped' })],
    verifier: [pass()]
  });
  const ev = await r.pageEvents();
  assert.ok(ev.includes('dropped card-a'), `page saw ${JSON.stringify(ev)}`);
  return JSON.stringify(ev);
});

scenario('go_back / go_forward (and navigation caused by a click)', async c => {
  const urls: string[] = [];
  const r = await runMission(c, {
    url: `${c.base}/agent/nav/a`,
    steps: [
      ({ ref, obs }) => { urls.push(obs.match(/^URL: (\S+)/m)![1]); return tc('click', { ref: ref('Go to page B') }); },
      ({ obs }) => { urls.push(obs.match(/^URL: (\S+)/m)![1]); return tc('go_back'); },
      ({ obs }) => { urls.push(obs.match(/^URL: (\S+)/m)![1]); return tc('go_forward'); },
      ({ obs }) => { urls.push(obs.match(/^URL: (\S+)/m)![1]); return tc('go_forward'); },
      () => tc('done', { result: 'done' })
    ],
    verifier: [pass()]
  });
  assert.deepEqual(urls.map(u => u.replace(c.base, '')), ['/agent/nav/a', '/agent/nav/b', '/agent/nav/a', '/agent/nav/b']);
  const results = toolResults(r.loop.history);
  assert.ok(results.some(x => x.isError && /no history entry/.test(x.output)), 'forward at the end of history is an error');
  return urls.join(' -> ');
});

scenario('tab tools: open/switch/close agent tabs, popup adoption, user tabs protected', async c => {
  const userTab = c.vm.createTab(`${c.base}/agent/nav/a`, false, 'user');
  let startId = '';
  let openedId = '';
  const r = await runMission(c, {
    url: `${c.base}/agent/tabs`,
    steps: [
      ({ obs }) => { startId = obs.match(/^(tab_\S+) \(current\)/m)![1]; return tc('open_tab', { url: `${c.base}/agent/nav/a` }); },
      ({ obs }) => { openedId = obs.match(/^(tab_\S+) \(current\)/m)![1]; assert.notEqual(openedId, startId); assert.ok(/URL: .*\/agent\/nav\/a/.test(obs)); return tc('switch_tab', { tabId: startId }); },
      ({ obs, ref }) => { assert.ok(obs.includes(`${startId} (current)`)); return tc('click', { ref: ref('Open page B in a new tab') }); },
      ({ obs }) => {
        assert.ok(/A new tab tab_\S+ was opened by the page/.test(obs), 'popup reported');
        assert.ok(/URL: .*\/agent\/nav\/b/.test(obs), 'popup became the current tab');
        return tc('close_tab', { tabId: userTab.id });
      },
      () => tc('close_tab', { tabId: openedId }),
      () => tc('done', { result: 'tabs handled' })
    ],
    verifier: [pass()]
  });
  const results = toolResults(r.loop.history);
  assert.ok(results.some(x => x.isError && /not a tab of this mission/.test(x.output)), 'closing a user tab is refused');
  assert.ok(c.vm.getTab(userTab.id), 'user tab still open');
  assert.ok(!c.vm.getTab(openedId), 'agent tab closed');
  assert.equal(r.outcome.state, 'completed');
  c.vm.closeTab(userTab.id);
  return `start=${startId} opened=${openedId}`;
});

scenario('extract + record_extraction: values without a real quote are rejected', async c => {
  let xid = '';
  const r = await runMission(c, {
    url: `${c.base}/content`,
    goal: 'What was Q3 2026 revenue?',
    steps: [
      () => tc('extract', { schema: { type: 'object', properties: { q3Revenue: { type: 'string' } }, required: ['q3Revenue'] } }),
      ({ req }) => {
        const last = toolResults(req.messages).pop()!;
        xid = last.output.match(/extractionId=(\S+)/)![1];
        assert.ok(last.output.includes('$195.0'), 'extracted table contains the value');
        return tc('record_extraction', { extractionId: xid, data: { q3Revenue: '$195.0' }, quotes: {} });
      },
      () => tc('record_extraction', { extractionId: xid, data: { q3Revenue: '$999.0' }, quotes: { q3Revenue: 'Q3 2026 | $999.0' } }),
      () => tc('record_extraction', { extractionId: xid, data: { q3Revenue: '$195.0' }, quotes: { q3Revenue: 'Q3 2026 | $195.0' } }),
      () => tc('done', { result: 'Q3 2026 revenue was $195.0M' })
    ],
    verifier: [pass()]
  });
  const results = toolResults(r.loop.history);
  const rec = results.filter(x => /Extraction (rejected|.* accepted)/.test(x.output));
  assert.equal(rec.length, 3);
  assert.ok(rec[0].isError && /no quote/.test(rec[0].output), rec[0].output);
  assert.ok(rec[1].isError && /does not occur/.test(rec[1].output), rec[1].output);
  assert.ok(!rec[2].isError && /accepted/.test(rec[2].output), rec[2].output);
  assert.ok(r.outcome.evidence.some(e => e.includes('$195.0') && e.includes('Q3 2026')), JSON.stringify(r.outcome.evidence));
  return rec.map(x => x.output.slice(0, 60)).join(' / ');
});

scenario('verifier: separate call, rejects then accepts on retry', async c => {
  const r = await runMission(c, {
    url: `${c.base}/`,
    goal: 'Read the main heading of this page',
    steps: [
      () => tc('done', { result: 'The heading is "Welcome"' }),
      ({ req }) => {
        const rej = toolResults(req.messages).pop()!;
        assert.ok(rej.isError && /heading on the page is "Project Aegis Web Arena"/.test(rej.output), 'rejection reasons are in history');
        return tc('done', { result: 'The heading is "Project Aegis Web Arena"' });
      }
    ],
    verifier: [reject(['the heading on the page is "Project Aegis Web Arena", not "Welcome"']), pass(['h1 matches'])]
  });
  assert.equal(r.outcome.state, 'completed');
  assert.deepEqual(r.outcome.verification, { verdict: 'pass', reasons: ['h1 matches'], attempts: 2 });
  assert.equal(r.verifier.seen.length, 2);
  const v = r.verifier.seen[0];
  assert.match(v.systemPrompt || '', /Completion Verifier/);
  assert.doesNotMatch(v.systemPrompt || '', /Tool Contract/);
  assert.equal(v.messages.length, 1, 'verifier sees one message, not the actor history');
  const body = v.messages[0].content as string;
  assert.ok(body.includes('Goal: Read the main heading of this page'));
  assert.ok(body.includes('Proposed answer: The heading is "Welcome"'));
  assert.ok(body.includes('h1: Project Aegis Web Arena'), 'last observation with the heading is included');
  assert.ok(!body.includes('tool_call') && !body.includes('[User Steering'), 'no actor history');
  assert.deepEqual(v.tools, ['report_verdict']);
  return `attempts=${r.outcome.verification?.attempts}`;
});

scenario('verifier: three rejections end as completed_unverified', async c => {
  const r = await runMission(c, {
    url: `${c.base}/`,
    steps: [() => tc('done', { result: 'a' }), () => tc('done', { result: 'b' }), () => tc('done', { result: 'c' })],
    verifier: [reject(['x']), reject(['y']), reject(['z'])]
  });
  assert.equal(r.outcome.state, 'completed_unverified');
  assert.equal(r.outcome.verification?.verdict, 'fail');
  assert.equal(r.outcome.verification?.attempts, 3);
  assert.equal(r.outcome.result, 'c');
  return 'completed_unverified after 3 checks';
});

scenario('ask_user: real round trip, no model calls while waiting', async c => {
  const r = await runMission(c, {
    url: `${c.base}/agent/select`,
    steps: [
      () => tc('ask_user', { question: 'Which colour?', options: ['Red', 'Blue'] }),
      ({ req, ref }) => {
        const last = toolResults(req.messages).pop()!;
        assert.equal(last.output, 'The user answered: Blue');
        return tc('select_option', { ref: ref('Colour'), label: 'Blue' });
      },
      () => tc('done', { result: 'Blue chosen' })
    ],
    verifier: [pass()],
    answers: ['Blue'],
    answerDelayMs: 1200
  });
  assert.equal(r.questions.length, 1);
  const q = r.questions[0];
  assert.equal(q.kind, 'question');
  assert.deepEqual(q.options, ['Red', 'Blue']);
  assert.equal(q.providerCallsAtAsk, 1);
  assert.equal(q.providerCallsAtAnswer, 1, 'no model call during the 1.2 s wait');
  assert.ok(r.statuses.includes('waiting_user'));
  assert.ok((await r.pageEvents()).includes('color=Blue'));
  return 'answered Blue after 1.2 s, 0 model calls while waiting';
});

scenario('stuck detection: hint after 3 repeats, then escalation to the user', async c => {
  const click = ({ ref }: any) => tc('click', { ref: ref('Load more') });
  const r = await runMission(c, {
    url: `${c.base}/agent/stuck`,
    steps: [click, click, click, ({ req }) => {
      assert.ok(req.messages.some(m => typeof m.content === 'string' && m.content.includes('You are repeating yourself')), 'hint injected');
      return click({ ref: (n: string) => refIn(lastObservation(req.messages), n) });
    }, click, click, ({ req }) => {
      assert.ok(req.messages.some(m => typeof m.content === 'string' && m.content.includes('[User guidance after repeated actions]: stop clicking')));
      return tc('fail', { reason: 'nothing to load' });
    }],
    answers: ['stop clicking']
  });
  assert.equal(r.questions.length, 1);
  assert.equal(r.questions[0].kind, 'stuck');
  assert.equal(r.outcome.state, 'failed');
  assert.deepEqual(r.events.filter(e => e.kind === 'stuck').map(e => e.data.escalated), [false, true]);
  return 'hint at 3, escalation at 6';
});

scenario('no tool call: at most 2 nudges, then the mission fails', async c => {
  const r = await runMission(c, { url: `${c.base}/`, steps: [() => ({ text: 'hmm' }), () => ({ text: 'hmm' }), () => ({ text: 'hmm' })] });
  assert.equal(MAX_NUDGES, 2);
  assert.equal(r.provider.seen.length, 3);
  assert.equal(r.outcome.state, 'failed');
  assert.match(r.outcome.error || '', /no tool call 3 times/);
  return r.outcome.error!;
});

scenario('two tools in one turn: sequential, stop at first failure, every call answered', async c => {
  const r = await runMission(c, {
    url: `${c.base}/agent/stale`,
    steps: [
      ({ ref }) => ({ toolCalls: [{ name: 'click', arguments: { ref: ref('Vanish') } }, { name: 'click', arguments: { ref: ref('Vanish') } }, { name: 'scroll', arguments: { direction: 'down' } }] }),
      ({ obs }) => { assert.ok(!obs.includes('"Vanish"'), 'new snapshot no longer lists the removed button'); return tc('fail', { reason: 'end' }); }
    ]
  });
  const results = toolResults(r.loop.history);
  assert.equal(results.length, 4, "three calls of the turn plus the final fail");
  assert.ok(!results[0].isError);
  assert.ok(results[1].isError && /STALE_REF/.test(results[1].output) && /no longer on the page/.test(results[1].output), results[1].output);
  assert.ok(results[2].isError && /^Skipped/.test(results[2].output), results[2].output);
  assert.deepEqual(await (async () => { const ev = await r.pageEvents(); return ev.filter(e => e === 'vanished').length; })(), 1, 'stale ref was not clicked blindly');
  assertPaired(r.loop.history);
  return results.map(x => x.output.slice(0, 40)).join(' | ');
});

scenario('invalid arguments: bad JSON and missing fields are tool errors, not crashes', async c => {
  const r = await runMission(c, {
    url: `${c.base}/`,
    steps: [
      () => tc('click', { _raw: '{"ref": e1', _parseError: true }),
      () => tc('type', { ref: 'e1' }),
      () => tc('scroll', { direction: 'sideways' }),
      () => tc('teleport', { to: 'moon' }),
      () => tc('fail', { reason: 'end' })
    ]
  });
  const out = toolResults(r.loop.history).map(x => x.output);
  assert.match(out[0], /not valid JSON/);
  assert.match(out[1], /Missing required argument "text"/);
  assert.match(out[2], /must be one of up, down/);
  assert.match(out[3], /Unknown tool "teleport"/);
  assertPaired(r.loop.history);
  return out.map(o => o.slice(0, 50)).join(' | ');
});

scenario('dialogs: confirm is dismissed, alert accepted, both reported', async c => {
  const r = await runMission(c, {
    url: `${c.base}/agent/dialog`,
    steps: [({ ref }) => tc('click', { ref: ref('Discard draft') }), ({ ref }) => tc('click', { ref: ref('Show notice') }), () => tc('fail', { reason: 'end' })]
  });
  const ev = await r.pageEvents();
  assert.ok(ev.includes('confirm=false'), JSON.stringify(ev));
  assert.ok(ev.includes('alert-closed'), JSON.stringify(ev));
  const out = toolResults(r.loop.history).map(x => x.output);
  assert.ok(/\[Dialog\] A confirm dialog said "Discard the draft\?"; it was dismissed/.test(out[0]), out[0]);
  assert.ok(/\[Dialog\] A alert dialog said "Saved!"; it was accepted/.test(out[1]), out[1]);
  return JSON.stringify(ev);
});

scenario('policy: out-of-scope navigation asks once, approval persists for the mission; rule from settings skips the ask', async c => {
  const r = await runMission(c, {
    url: `${c.base}/agent/nav/a`,
    steps: [
      () => tc('navigate', { url: `${c.altBase}/agent/nav/b` }),
      ({ req }) => { assert.match(toolResults(req.messages).pop()!.output, /user denied/); return tc('navigate', { url: `${c.altBase}/agent/nav/b` }); },
      ({ obs }) => { assert.ok(obs.includes(`URL: ${c.altBase}/agent/nav/b`)); return tc('navigate', { url: `${c.altBase}/agent/nav/a` }); },
      () => tc('fail', { reason: 'end' })
    ],
    answers: ['Deny', 'Approve']
  });
  assert.equal(r.questions.length, 2, 'third navigation to the approved host did not ask');
  assert.ok(r.questions.every(q => q.kind === 'approval' && q.text.includes('localhost')), JSON.stringify(r.questions.map(q => q.text)));
  assert.ok(!r.questions.some(q => /'0\.1'/.test(q.text)), 'IP origin is not mangled');
  const r2 = await runMission(c, {
    url: `${c.base}/agent/nav/a`,
    rules: [{ riskClass: 'navigate-out-of-scope', host: 'localhost', decision: 'allow' }],
    steps: [() => tc('navigate', { url: `${c.altBase}/agent/nav/b` }), ({ obs }) => { assert.ok(obs.includes(`URL: ${c.altBase}`)); return tc('fail', { reason: 'end' }); }]
  });
  assert.equal(r2.questions.length, 0, 'settings rule allowed it without asking');
  assert.ok(r2.events.some(e => e.kind === 'policy' && /User policy rule: allow/.test(e.data.reason)));
  return `asked ${r.questions.length}x, rule run asked ${r2.questions.length}x`;
});

scenario('policy: the page leaving the allowed origin by itself is re-checked', async c => {
  const r = await runMission(c, {
    url: `${c.base}/agent/nav/a`,
    steps: [
      async ({ req }) => { void req; await activeWc(c).executeJavaScript(`location.href = ${JSON.stringify(`${c.altBase}/agent/nav/b`)}`); return tc('wait', { ms: 300 }); },
      ({ obs }) => { assert.ok(obs.includes(`URL: ${c.altBase}/agent/nav/b`), 'continued after approval'); return tc('fail', { reason: 'end' }); }
    ],
    answers: ['Approve']
  });
  assert.equal(r.questions.length, 1);
  assert.match(r.questions[0].text, /moved to localhost/);
  return r.questions[0].text.slice(0, 80);
});

scenario('shadow DOM and same-origin iframe elements are clickable', async c => {
  const r = await runMission(c, {
    url: `${c.base}/agent/frames`,
    steps: [({ ref }) => tc('click', { ref: ref('Shadow button') }), ({ ref }) => tc('click', { ref: ref('Frame button') }), () => tc('fail', { reason: 'end' })]
  });
  const ev = await r.pageEvents();
  assert.ok(ev.includes('shadow clicked') && ev.includes('frame clicked'), JSON.stringify(ev));
  return JSON.stringify(ev);
});

scenario('occluded element is reported and not clicked through the cover', async c => {
  const r = await runMission(c, {
    url: `${c.base}/agent/occlusion`,
    steps: [({ obs, ref }) => { assert.match(obs, /"Under the cover" \(occluded by div#cover\)/); return tc('click', { ref: ref('Under the cover') }); }, () => tc('fail', { reason: 'end' })]
  });
  assert.match(toolResults(r.loop.history)[0].output, /covered by div#cover/);
  return 'occlusion reported';
});

scenario('upload_file: only inside the mission folder, file-egress needs approval or a rule', async c => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-mission-'));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'hello from the mission folder');
  const outside = path.join(os.tmpdir(), `aegis-outside-${Date.now()}.txt`);
  fs.writeFileSync(outside, 'secret');
  const r = await runMission(c, {
    url: `${c.base}/agent/upload`,
    missionDir: dir,
    rules: [{ riskClass: 'file-egress', decision: 'allow' }],
    steps: [
      ({ ref }) => tc('upload_file', { ref: ref('Attachment'), path: path.relative(dir, outside) }),
      ({ ref }) => tc('upload_file', { ref: ref('Attachment'), path: 'note.txt' }),
      () => tc('fail', { reason: 'end' })
    ]
  });
  const out = toolResults(r.loop.history).map(x => x.output);
  assert.match(out[0], /outside the mission folder/);
  const ev = await r.pageEvents();
  assert.ok(ev.some(e => e.startsWith('file=note.txt') && e.includes('hello from the mission')), JSON.stringify(ev));
  const r2 = await runMission(c, {
    url: `${c.base}/agent/upload`, missionDir: dir,
    steps: [({ ref }) => tc('upload_file', { ref: ref('Attachment'), path: 'note.txt' }), () => tc('fail', { reason: 'end' })],
    answers: ['Deny']
  });
  assert.equal(r2.questions[0].kind, 'approval');
  assert.deepEqual(await r2.pageEvents(), [], 'denied upload set no file');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { force: true });
  return JSON.stringify(ev);
});

scenario('screenshot with marks: image drawn on the bitmap, page DOM untouched', async c => {
  let domBefore = 0;
  const r = await runMission(c, {
    url: `${c.base}/agent/select`,
    steps: [
      async () => { domBefore = await activeWc(c).executeJavaScript('document.querySelectorAll("*").length'); return tc('screenshot', { withMarks: false }); },
      () => tc('screenshot', { withMarks: true }),
      () => tc('fail', { reason: 'end' })
    ]
  });
  const domAfter = await r.loop.tab.view.webContents.executeJavaScript('document.querySelectorAll("*").length');
  assert.equal(domAfter, domBefore, 'no overlay elements were added to the page');
  // The older screenshot is pruned from history when a newer one exists; take both from the provider's view.
  const imgs = r.provider.seen.flatMap(s => s.messages).filter(m => Array.isArray(m.content) && (m.content as any[]).some(b => b.type === 'image'))
    .map(m => (m.content as any[]).find(b => b.type === 'image').base64 as string);
  const last = (r.loop.history.filter(m => Array.isArray(m.content) && (m.content as any[]).some(b => b.type === 'image')).pop()!.content as any[]).find(b => b.type === 'image').base64;
  const plain = nativeImage.createFromBuffer(Buffer.from(imgs[0], 'base64'));
  const marked = nativeImage.createFromBuffer(Buffer.from(last, 'base64'));
  assert.ok(!plain.isEmpty() && !marked.isEmpty());
  const a = plain.toBitmap(), b = marked.toBitmap();
  let diff = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) diff++;
  assert.ok(diff > 200, `marked image differs from plain one (${diff} px)`);
  assert.match(toolResults(r.loop.history)[1].output, /with \d+ marks/);
  return `${diff} pixels changed by marks, DOM nodes ${domBefore} -> ${domAfter}`;
});

scenario('find_text: page, shadow root and frame', async c => {
  const r = await runMission(c, {
    url: `${c.base}/agent/frames`,
    steps: [() => tc('find_text', { query: 'code 42891' }), () => tc('find_text', { query: 'no such text here' }), () => tc('fail', { reason: 'end' })]
  });
  const out = toolResults(r.loop.history).map(x => x.output);
  assert.match(out[0], /1 match\(es\).*\n1\. \[frame\] .*code 42891/);
  assert.match(out[1], /No match/);
  return out[0].replace(/\n/g, ' ');
});

scenario('budgets: step budget and cost cap stop the mission with a reason', async c => {
  const wait = () => tc('wait', { ms: 100 });
  const r = await runMission(c, { url: `${c.base}/`, maxSteps: 3, steps: [wait, wait, wait, wait] });
  assert.equal(r.outcome.state, 'failed');
  assert.match(r.outcome.error || '', /Step budget reached: 3 steps/);
  assert.equal(r.provider.seen.length, 3);
  // gemini-2.0-flash pricing; 400k prompt tokens per call is about $0.04
  const r2 = await runMission(c, { url: `${c.base}/`, maxCostUSD: 0.05, usage: { promptTokens: 400_000, completionTokens: 1000 }, steps: [wait, wait, wait, wait] });
  assert.equal(r2.outcome.state, 'failed');
  assert.match(r2.outcome.error || '', /Cost cap reached/);
  assert.equal(r2.provider.seen.length, 2);
  return `${r.outcome.error} | ${r2.outcome.error}`;
});

scenario('cancel during a model call aborts the HTTP request', async c => {
  let sawRequest = false;
  let requestClosed = false;
  const server = http.createServer((req, res) => {
    sawRequest = true;
    req.on('close', () => { if (!res.writableEnded) requestClosed = true; });
    // never answer
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  const ac = new AbortController();
  const provider = new OpenAIModelProvider({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test', modelName: 'gpt-4o-mini' });
  const started = Date.now();
  const p = runMission(c, { url: `${c.base}/`, steps: [], provider, signal: ac.signal });
  while (!sawRequest && Date.now() - started < 10000) await sleep(50);
  assert.ok(sawRequest, 'model request reached the server');
  ac.abort();
  const r = await p;
  await sleep(200);
  server.closeAllConnections?.();
  server.close();
  assert.equal(r.outcome.state, 'cancelled');
  assert.ok(requestClosed, 'the in-flight HTTP request was closed by the abort');
  return `cancelled after ${Date.now() - started} ms; server saw the socket close`;
});

scenario('60-step run: history stays bounded (pruneHistory works)', async c => {
  const more = ({ ref }: any) => tc('click', { ref: ref('More') });
  const steps: StepFn[] = Array.from({ length: 60 }, () => more);
  steps.push(() => tc('fail', { reason: 'end' }));
  const r = await runMission(c, { url: `${c.base}/agent/growing`, maxSteps: 70, steps, light: true });
  const h = r.loop.history;
  const full = h.filter(m => typeof m.content === 'string' && m.content.startsWith('[Page State - Isolated')).length;
  const pruned = h.filter(m => typeof m.content === 'string' && m.content.startsWith('[Page State Summary')).length;
  const chars = JSON.stringify(h).length;
  const pageLen = (await r.loop.tab.view.webContents.executeJavaScript('document.body.innerText.length')) as number;
  assert.equal(r.loop.stepCount, 61);
  assert.ok(full <= 2, `full observations kept: ${full}`);
  assert.equal(pruned, 61 - full);
  assert.ok(chars < 80_000, `history is ${chars} chars for 61 steps`);
  return `61 steps: ${full} full observations, ${pruned} pruned, history ${chars} chars (page text now ${pageLen} chars)`;
});

scenario('privacy mode and policy engine come from settings, one instance per mission', async c => {
  const r = await runMission(c, { url: `${c.base}/`, privacyMode: 'Standard', steps: [() => tc('fail', { reason: 'end' })] });
  assert.equal(r.loop.privacy.getMode(), 'Standard');
  const r2 = await runMission(c, { url: `${c.base}/`, privacyMode: 'Local-only', steps: [() => tc('fail', { reason: 'end' })] });
  assert.equal(r2.loop.privacy.getMode(), 'Local-only');
  assert.deepEqual(r2.loop.policy.getAllowedHosts(), ['127.0.0.1']);
  return 'Standard / Local-only honoured';
});

function activeWc(c: Ctx) {
  return c.vm.getActiveTab()!.view.webContents;
}

export async function run() {
  const arena = new WebArenaServer();
  const port = await arena.start(0);
  const win = new BrowserWindow({ width: 1200, height: 860, show: true, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL('about:blank');
  const vm = new ViewManager(win);
  vm.createTab('about:blank', false, 'user'); // keeps ViewManager from opening its default site when agent tabs close
  const ctx: Ctx = { base: `http://127.0.0.1:${port}`, altBase: `http://localhost:${port}`, vm, win };
  const only = process.env.AGENT_LOOP_ONLY;
  const results: Array<{ name: string; ok: boolean; detail: string; ms: number }> = [];
  for (const [name, fn] of scenarios) {
    if (only && !name.includes(only)) continue;
    const t0 = Date.now();
    try {
      const detail = await fn(ctx);
      results.push({ name, ok: true, detail, ms: Date.now() - t0 });
    } catch (err: any) {
      results.push({ name, ok: false, detail: String(err?.stack || err).slice(0, 2500), ms: Date.now() - t0 });
    }
    for (const t of vm.listTabs()) if (t.state.owner.startsWith('agent:t')) vm.closeTab(t.id);
  }
  win.destroy();
  await arena.stop();
  return { results };
}
