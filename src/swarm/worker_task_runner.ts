/**
 * Project Aegis - swarm workers are real agents (#227 SWX-01).
 *
 * `runWorkerTask` runs one scheduled task on one worker's own view with the same `AgentLoop` as the single agent
 * (perceive -> decide -> act, policy, privacy, stuck detection, step and cost budgets). The worker differs in three ways:
 *  - its tools are the single-agent tools minus done/fail/ask_user/tab tools, plus `report_finding` and `finish_task`;
 *  - `report_finding` posts to the SharedBlackboard only when its quote really is on the page (worker_findings.ts);
 *  - it is bounded by its own step/cost budget and a wall-clock timeout, and reports a heartbeat to the supervisor.
 *
 * Roles other than researcher/extractor/actor never touch a browser: the verifier stage adjudicates conflicts with a
 * model call, the summariser stage has nothing to do (the report is built from the blackboard by the coordinator).
 */
import type { TabView } from '../main/view_manager.js';
import type { TabState, WorkerEventPayload } from '../ipc/contract.js';
import type { IModelProvider, ModelRequest, ModelResponse, ToolDefinition } from '../models/types.js';
import { AgentLoop, AgentLoopSettings, ExtraTool, UserQuestion, LoopOutcome } from '../agent/agent_loop.js';
import { BROWSER_TOOLS } from '../agent/tools.js';
import { UsageLedger } from '../models/pricing.js';
import { PromptRegistry } from '../agent/steering_and_reversibility.js';
import { IWorkerHost } from './worker_host.js';
import { isLiveWorkerView, LiveWorkerView } from './worker_view_registry.js';
import { ScheduledTask } from './scheduler.js';
import { SharedBlackboard } from './blackboard.js';
import { WorkerSupervisor } from './supervisor.js';
import {
  REPORT_FINDING_TOOL, FINISH_TASK_TOOL, WORKER_EXCLUDED_TOOLS, checkFinding, UrlClaims, adjudicateConflicts
} from './worker_findings.js';
import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('worker-runner');

export const DEFAULT_WORKER_MAX_STEPS = 25;
export const DEFAULT_WORKER_TIMEOUT_MS = 180_000;
export const BROWSER_ROLES: ReadonlyArray<ScheduledTask['role']> = ['researcher', 'extractor', 'actor'];

export const WORKER_TOOLS: ToolDefinition[] = [
  ...BROWSER_TOOLS.filter(t => !WORKER_EXCLUDED_TOOLS.includes(t.name)),
  REPORT_FINDING_TOOL,
  FINISH_TASK_TOOL
];

export interface WorkerTaskResult {
  status: 'completed' | 'needs_human';
  summary: string;
  steps: number;
  findings: number;
  /** needs_human: why the worker stopped (bot challenge, login wall...). */
  reason?: string;
}

/** What every worker of one mission shares. */
export interface WorkerRunDeps {
  missionId: string;
  provider: IModelProvider;
  blackboard: SharedBlackboard;
  claims: UrlClaims;
  settings: AgentLoopSettings;
  signal: AbortSignal;
  /** Start page of a task that has no URL (the user's default search engine), so the worker has a mission scope. */
  startUrl?: string;
  workerMaxSteps?: number;
  workerMaxCostUSD?: number;
  workerTimeoutMs?: number;
  supervisor?: WorkerSupervisor;
  waitWhilePaused?: () => Promise<void>;
  /** Shows a question (policy approval, stuck prompt) to the user; called one at a time by the runtime's queue. */
  askUser?: (q: UserQuestion) => Promise<string>;
  emitWorker?: (p: WorkerEventPayload) => void;
  emitEvidence?: (text: string) => void;
  recordEvent?: (kind: string, data: unknown) => void;
  stepDelayMs?: number;
  settleMaxMs?: number;
  /** Lets the supervisor (or a test) stop one worker; set while its loop runs. */
  abortHandles?: Map<string, (reason: string) => void>;
}

/** The loop's tab: the worker's own WebContentsView, never a tab of the user. */
export function workerTab(worker: IWorkerHost, missionId: string): TabView {
  if (!isLiveWorkerView(worker)) {
    throw new Error(`Worker ${worker.id} has no real view; a worker task needs a WorkerHost running in Electron`);
  }
  const w = worker as LiveWorkerView;
  const state: TabState = {
    id: w.id, url: w.webContents.getURL(), title: w.webContents.getTitle(), isLoading: false,
    canGoBack: false, canGoForward: false, isAudible: false, isCrashed: false, owner: `agent:${missionId}`
  };
  return { id: w.id, view: w.view, executor: w.executor, state };
}

function heartbeating(inner: IModelProvider, beat: () => void): IModelProvider {
  return {
    providerName: inner.providerName,
    modelName: inner.modelName,
    async generate(req: ModelRequest): Promise<ModelResponse> {
      beat();
      try { return await inner.generate(req); } finally { beat(); }
    }
  };
}

function workerGoal(task: ScheduledTask, deps: WorkerRunDeps): string {
  const earlier = deps.blackboard.getAllEvidence().filter(e => e.stepId === task.id);
  const done = earlier.length
    ? `\nAlready reported by an earlier attempt of this sub-goal (do not repeat these):\n${earlier.map(e => `- ${e.entity} / ${e.attribute}: ${String(e.value)}`).join('\n')}`
    : '';
  return `${task.instruction}${task.url ? `\nStart page: ${task.url}` : ''}${done}`;
}

export async function runWorkerTask(worker: IWorkerHost, task: ScheduledTask, deps: WorkerRunDeps): Promise<WorkerTaskResult> {
  try {
    return await runWorkerTaskInner(worker, task, deps);
  } catch (err) {
    deps.claims.releaseWorker(worker.id); // a retry (possibly on another worker) may take these pages again
    throw err;
  }
}

async function runWorkerTaskInner(worker: IWorkerHost, task: ScheduledTask, deps: WorkerRunDeps): Promise<WorkerTaskResult> {
  if (!BROWSER_ROLES.includes(task.role)) return runNonBrowserTask(task, deps);

  const tab = workerTab(worker, deps.missionId);
  const name = worker.identity.name;
  const sup = deps.supervisor;
  const beat = (taskId: string | undefined = task.id) => sup?.recordEvent(worker.id, 'model_event', taskId);

  // The worker's own page first: the loop takes its policy scope from the page it starts on.
  if (task.url) {
    const holder = deps.claims.claim(task.url, worker.id);
    if (holder) throw new Error(`The page ${task.url} is already covered by worker ${holder}`);
    await worker.navigate(task.url);
    deps.blackboard.recordVisit(task.url, worker.id);
  } else if (deps.startUrl) {
    await worker.navigate(deps.startUrl);
    deps.blackboard.recordVisit(deps.startUrl, worker.id);
  }
  await tab.executor.ensureReady().catch(() => { /* CDP unavailable: tools report their own errors */ });

  // Own abort: mission cancel, wall-clock timeout, or a supervisor stall all end this worker's loop.
  const ac = new AbortController();
  let stopReason = null as 'timeout' | 'stalled' | 'cancelled' | null;
  const stop = (why: 'timeout' | 'stalled' | 'cancelled') => { if (!stopReason) stopReason = why; ac.abort(); };
  const onMissionAbort = () => stop('cancelled');
  if (deps.signal.aborted) throw new Error('Mission cancelled');
  deps.signal.addEventListener('abort', onMissionAbort, { once: true });
  const timeoutMs = deps.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  deps.abortHandles?.set(worker.id, why => stop(why === 'stalled' ? 'stalled' : 'cancelled'));

  let findings = 0;
  let step = 0;
  let lastAction = 'starting';
  let needsHuman = null as string | null;
  const usage = new UsageLedger(); // this worker's own spend, so its cost budget is its own

  const emitWorker = (taskText: string, status: WorkerEventPayload['status'], progress: number) => deps.emitWorker?.({
    id: worker.id, workerId: worker.id, name, color: worker.identity.color, glyph: worker.identity.glyph,
    task: taskText, progress, status, step, lastAction, at: Date.now()
  });

  const reportFinding: ExtraTool = {
    def: REPORT_FINDING_TOOL,
    handle: async (args, ctx) => {
      const check = checkFinding(
        { value: String(args.value), quote: String(args.quote), url: String(args.url) },
        { text: ctx.snapshot.pageText || '', url: ctx.snapshot.url }
      );
      if (!check.ok) {
        deps.recordEvent?.('worker.finding_rejected', { workerId: worker.id, taskId: task.id, problem: check.problem });
        return { output: `Finding rejected: ${check.problem}`, isError: true };
      }
      const attribute = String(args.attribute);
      const language = typeof args.language === 'string' && args.language.trim() ? String(args.language).trim().slice(0, 16) : undefined;
      const translation = typeof args.translation === 'string' && args.translation.trim() ? String(args.translation).trim().slice(0, 400) : undefined;
      // The blackboard verifies the quote again against this very page text and keeps the text as the finding's snapshot.
      const posted = deps.blackboard.postEvidence({
        entity: String(args.entity),
        attribute,
        category: /price|cost/i.test(attribute) ? 'price' : 'fact',
        value: String(args.value),
        source: { url: ctx.snapshot.url, quote: squashQuote(String(args.quote)), sourceType: 'primary', pageTitle: ctx.snapshot.title, language, translation },
        pageText: ctx.snapshot.pageText || '',
        workerId: worker.id,
        stepId: task.id
      });
      if (posted.rejected) {
        deps.recordEvent?.('worker.finding_rejected', { workerId: worker.id, taskId: task.id, problem: posted.rejected });
        return { output: `Finding rejected: ${posted.rejected} Nothing was recorded.`, isError: true };
      }
      deps.recordEvent?.('worker.visited', { workerId: worker.id, url: ctx.snapshot.url });
      if (posted.corroborated) { findings++; return { output: `Recorded as a second independent source for ${args.entity} / ${attribute} = ${args.value}.` }; }
      if (!posted.posted) return { output: 'This finding is already on the blackboard (same entity, attribute and value, same site). Nothing new was recorded.' };
      findings++;
      const note = posted.conflict ? ' It conflicts with another worker\'s finding; the verifier stage will compare the quotes.' : '';
      return { output: `Recorded: ${args.entity} / ${attribute} = ${args.value}.${note}` };
    }
  };

  const finishTask: ExtraTool = {
    def: FINISH_TASK_TOOL,
    handle: async args => {
      const status = String(args.status);
      const summary = String(args.summary).slice(0, 500);
      if (status === 'failed') return { output: 'Task ended as failed.', end: { state: 'failed', error: summary } };
      if (status !== 'completed') return { output: 'status must be "completed" or "failed".', isError: true };
      if (findings === 0 && task.role !== 'actor' && !hasEarlierFindings(task, deps)) {
        return { output: 'You have not reported any finding yet. Call report_finding with an exact quote first, or finish with status "failed" and say why.', isError: true };
      }
      return { output: 'Task finished.', end: { state: 'completed', result: summary } };
    }
  };

  const loop = new AgentLoop({
    missionId: deps.missionId,
    goal: workerGoal(task, deps),
    model: deps.provider.modelName,
    tab,
    provider: heartbeating(deps.provider, () => beat()),
    tools: WORKER_TOOLS,
    extraTools: [reportFinding, finishTask],
    systemPromptRole: 'worker',
    systemPromptSuffix: `You are ${name} (${worker.id}). Your sub-goal: ${task.name}.`,
    guardTool: (toolName, args) => {
      if (toolName !== 'navigate' || typeof args.url !== 'string') return null;
      const holder = deps.claims.claim(/^[a-z][a-z0-9+.-]*:/i.test(args.url) ? args.url : `https://${args.url}`, worker.id);
      if (!holder) deps.blackboard.recordVisit(/^[a-z][a-z0-9+.-]*:/i.test(args.url) ? args.url : `https://${args.url}`, worker.id);
      return holder ? `Worker ${holder} already covers ${args.url}. Choose a different source for your sub-goal.` : null;
    },
    settings: {
      ...deps.settings,
      maxSteps: Math.min(deps.settings.maxSteps, deps.workerMaxSteps ?? DEFAULT_WORKER_MAX_STEPS),
      maxCostUSD: deps.workerMaxCostUSD ?? deps.settings.maxCostUSD
    },
    history: [],
    signal: ac.signal,
    usage,
    waitWhilePaused: deps.waitWhilePaused,
    stepDelayMs: deps.stepDelayMs,
    settleMaxMs: deps.settleMaxMs,
    askUser: async (q: UserQuestion) => {
      if (q.kind === 'handoff') {
        // A bot check or login wall is not a failure and not for this worker to solve: the task waits for a human.
        needsHuman = q.text;
        throw new Error('needs_human');
      }
      sup?.recordEvent(worker.id, 'model_event'); // no task id = idle: waiting for the user must not look like a stall
      try {
        if (!deps.askUser) throw new Error('no one to ask');
        return await deps.askUser({ ...q, id: `${worker.id}:${q.id}`, text: `${name}: ${q.text}` });
      } finally {
        sup?.recordEvent(worker.id, 'model_event', task.id);
      }
    },
    emit: {
      evidence: t => deps.emitEvidence?.(`[${name}] ${t}`),
      status: (s, m) => { if (s === 'waiting_user') emitWorker(`Waiting for you: ${m.slice(0, 80)}`, 'running', 50); },
      worker: p => { step = p.step ?? step; emitWorker(p.task, 'running', p.progress); },
      action: (s, toolName, summary) => {
        step = s;
        lastAction = `${toolName} ${summary}`.slice(0, 120);
        sup?.recordEvent(worker.id, 'action_dispatched', task.id);
        emitWorker(`Step ${s}: ${toolName}`, 'running', Math.min(90, s * 4));
      },
      event: (kind, data) => deps.recordEvent?.(`worker.${kind}`, { workerId: worker.id, taskId: task.id, data }),
      checkpoint: () => sup?.recordEvent(worker.id, 'cdp_response', task.id)
    }
  });

  let outcome: LoopOutcome;
  try {
    outcome = await loop.run();
  } finally {
    clearTimeout(timer);
    deps.signal.removeEventListener('abort', onMissionAbort);
    deps.abortHandles?.delete(worker.id);
  }
  step = outcome.steps;

  if (needsHuman) {
    emitWorker(`Needs you: ${String(needsHuman).slice(0, 100)}`, 'idle', 100);
    return { status: 'needs_human', summary: String(needsHuman), steps: outcome.steps, findings, reason: String(needsHuman) };
  }
  if (outcome.state === 'completed') {
    emitWorker(`Done: ${(outcome.result || '').slice(0, 100)}`, 'done', 100);
    return { status: 'completed', summary: outcome.result || '', steps: outcome.steps, findings };
  }
  if (stopReason === 'timeout') throw new Error(`Worker timed out after ${Math.round(timeoutMs / 1000)} s (wall-clock budget)`);
  if (stopReason === 'stalled') throw new Error('Worker stalled (no heartbeat from the supervisor window); stopped');
  if (outcome.state === 'cancelled') throw new Error('Mission cancelled');
  logger.warn('Worker task failed', { workerId: worker.id, taskId: task.id, error: outcome.error });
  throw new Error(outcome.error || 'Worker task failed');
}

function hasEarlierFindings(task: ScheduledTask, deps: WorkerRunDeps): boolean {
  return deps.blackboard.getAllEvidence().some(e => e.stepId === task.id);
}

function squashQuote(q: string): string {
  return q.replace(/\s+/g, ' ').trim();
}

/** Verifier and summariser stages: no browser. The verifier compares quotes with a model call; the summariser has nothing to do. */
export async function runNonBrowserTask(task: ScheduledTask, deps: WorkerRunDeps): Promise<WorkerTaskResult> {
  if (task.role === 'verifier') {
    const results = await adjudicateConflicts(deps.blackboard, deps.provider, { missionId: deps.missionId, signal: deps.signal });
    for (const r of results) deps.emitEvidence?.(`[Verifier] ${r.conflict}: ${r.resolved ? `resolved (claim ${r.chosenIndex}) - ${r.reason}` : `left open - ${r.reason}`}`);
    const open = results.filter(r => !r.resolved).length;
    return { status: 'completed', summary: `${results.length} conflict(s) adjudicated, ${open} left open`, steps: 0, findings: 0 };
  }
  return { status: 'completed', summary: 'The report is built from the blackboard evidence', steps: 0, findings: 0 };
}

/** Keeps PromptRegistry's worker prompt reachable for tests that check what a worker is told. */
export function workerSystemPrompt(): string {
  return PromptRegistry.getInstance().getEffectivePrompt('worker').systemPrompt;
}
