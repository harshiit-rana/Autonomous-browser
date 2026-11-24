/**
 * The single-agent observe -> decide -> act loop (issue #225, RUN-03).
 *
 * Extracted from `AgentRuntime.runLoop` so the same loop can drive any tab (the runtime's mission tab today, swarm
 * worker tabs in #227). The loop owns: observation (perception + privacy redaction), the model call, argument
 * validation, the policy decision for every tool call, tool execution, the ask_user round trip, stuck detection,
 * step/cost budgets, and the independent completion check (verifier). `AgentRuntime` only manages mission lifecycle.
 *
 * Electron is used only through the tab it is given; the model and the verifier are injected providers.
 */
import { createHash } from 'node:crypto';
import type { TabView } from '../main/view_manager.js';
import type { IModelProvider, CanonicalMessage, ContentBlock, ModelResponse, ToolDefinition } from '../models/types.js';
import { PerceptionEngine, PageSnapshot } from './perception.js';
import { BROWSER_TOOLS, ToolExecutor, ToolExecutionResult, AgentTabHost, ExtractionRecord, validateToolArgs } from './tools.js';
import { ActionTaxonomy } from './errors.js';
import { PromptRegistry, ActionLedger } from './steering_and_reversibility.js';
import { ActionPolicyEngine, PolicyRule } from '../security/action_policy.js';
import { PrivacyGovernor, PrivacyMode } from '../security/privacy_governor.js';
import { PromptIsolationEngine } from '../security/prompt_isolation.js';
import { SecretVault } from '../security/secret_vault.js';
import { BotChallengeBridge } from '../security/bot_detection.js';
import { GlobalKillSwitch, AuditLog } from '../security/audit_log.js';
import { UsageLedger } from '../models/pricing.js';
import { settlePage } from '../swarm/page_settle.js';
import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('agent-loop');

/** Structured brief of a mission (#241 will build it in the Prompt Workspace; today it comes from the caller). */
export interface MissionBrief {
  successCriteria?: string[];
  maxSteps?: number;
  maxCostUSD?: number;
}

export interface AgentLoopSettings {
  privacyMode: PrivacyMode;
  policyRules: PolicyRule[];
  maxSteps: number;
  maxCostUSD: number;
}

export interface VerificationOutcome {
  verdict: 'pass' | 'fail' | 'error';
  reasons: string[];
  attempts: number;
}

export type LoopEndState = 'completed' | 'completed_unverified' | 'failed' | 'cancelled';

export interface LoopOutcome {
  state: LoopEndState;
  result?: string;
  error?: string;
  verification?: VerificationOutcome;
  evidence: string[];
  steps: number;
}

export interface UserQuestion {
  id: string;
  text: string;
  options?: string[];
  /** `question` = ask_user from the model; `approval` = a policy decision that needs the user. */
  kind: 'question' | 'approval' | 'stuck' | 'handoff';
}

export interface AgentLoopEmitter {
  evidence(text: string): void;
  status(state: 'running' | 'waiting_user' | 'waiting_approval' | 'paused', message: string): void;
  /** A tool is about to run (phase 'start': it may or may not complete if the app dies) or has finished ('end'). Feeds the resume checkpoint. */
  action?(a: { step: number; tool: string; args: Record<string, any>; phase: 'start' | 'end'; ok?: boolean }): void;
  telemetry?(p: { tokensTotal: number; costTotal: number; stepTokens: number; stepCost: number }): void;
  worker?(p: { task: string; progress: number }): void;
  /** Structured event for the mission log (verification, budget, stuck...). */
  event?(kind: string, data: unknown): void;
  checkpoint?(): void;
}

export interface AgentLoopDeps {
  missionId: string;
  goal: string;
  model: string;
  tab: TabView;
  provider: IModelProvider;
  /** Separate provider for the completion check (may be a cheaper model). Defaults to `provider`. */
  verifier?: IModelProvider;
  tools?: ToolDefinition[];
  settings: AgentLoopSettings;
  brief?: MissionBrief;
  emit: AgentLoopEmitter;
  history: CanonicalMessage[];
  signal: AbortSignal;
  /** Resolves with the user's answer; rejects if the mission is cancelled while waiting. */
  askUser: (q: UserQuestion) => Promise<string>;
  tabs?: AgentTabHost;
  missionDir?: string;
  usage?: UsageLedger;
  actionLedger?: ActionLedger;
  /** Steering messages queued by the user since the last step. */
  drainSteering?: () => string[];
  /** Resolves when the mission is not paused. */
  waitWhilePaused?: () => Promise<void>;
  /** Set when this mission resumes an interrupted one: appended to the goal message (what was already done). */
  resumeNote?: string;
  /** Defaults: 600 ms between steps, real page settle with an 8 s cap. */
  stepDelayMs?: number;
  settleMaxMs?: number;
}

export const MAX_NUDGES = 2;
export const MAX_VERIFIER_RETRIES = 2;
const STUCK_REPEATS = 3;

const VERDICT_TOOL: ToolDefinition = {
  name: 'report_verdict',
  description: 'Report whether the proposed answer is supported by the observations',
  parameters: {
    type: 'object',
    properties: {
      pass: { type: 'boolean', description: 'true if the answer is correct and supported' },
      reasons: { type: 'array', description: 'Short reasons', items: { type: 'string' } }
    },
    required: ['pass', 'reasons']
  }
};

const OBS_MARK = '[Page State - Isolated Data Channel]';

class Cancelled extends Error {}

/** Rejects with Cancelled as soon as the signal aborts, even while `p` (a CDP wait, a page settle, a tool) is pending. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { p.catch(() => {}); return Promise.reject(new Cancelled()); }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v); },
      e => { signal.removeEventListener('abort', onAbort); reject(e); }
    );
  });
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return raceAbort(new Promise<void>(r => setTimeout(r, ms)), signal);
}

export class AgentLoop {
  public readonly history: CanonicalMessage[];
  public stepCount = 0;
  public readonly evidence: string[] = [];
  public readonly policy: ActionPolicyEngine;
  public readonly privacy: PrivacyGovernor;
  public tab: TabView;

  private readonly deps: AgentLoopDeps;
  private readonly tools: ToolDefinition[];
  private readonly maxSteps: number;
  private readonly maxCostUSD: number;
  private readonly usage: UsageLedger;
  private readonly owner: string;
  private readonly startTabId: string;
  private readonly extractions = new Map<string, ExtractionRecord>();
  private readonly recentObservations: string[] = [];
  private readonly actionSignatures: string[] = [];
  private readonly knownTabIds = new Set<string>();
  private nudges = 0;
  private verifierRejections = 0;
  private stuckHints = 0;
  private questionSeq = 0;
  private seeded = false;
  private lastObservationHash = '';

  constructor(deps: AgentLoopDeps) {
    this.deps = deps;
    this.tab = deps.tab;
    this.history = deps.history;
    this.tools = deps.tools || BROWSER_TOOLS;
    this.usage = deps.usage || new UsageLedger();
    this.owner = `agent:${deps.missionId}`;
    this.startTabId = deps.tab.id;
    // Budgets: the brief may only lower the configured limits.
    this.maxSteps = Math.max(1, Math.min(deps.brief?.maxSteps ?? deps.settings.maxSteps, deps.settings.maxSteps));
    this.maxCostUSD = Math.min(deps.brief?.maxCostUSD ?? deps.settings.maxCostUSD, deps.settings.maxCostUSD);
    // One policy engine and one privacy governor per mission, from settings (#225 step 4).
    const startUrl = deps.tab.view.webContents.getURL();
    const goalHosts = Array.from(deps.goal.matchAll(/https?:\/\/[^\s"'<>)]+/g)).map(m => m[0]);
    this.policy = new ActionPolicyEngine({
      rules: deps.settings.policyRules,
      allowedHosts: [startUrl, ...goalHosts].filter(u => /^https?:/i.test(u))
    });
    this.privacy = new PrivacyGovernor(deps.settings.privacyMode);
    for (const t of deps.tabs?.list() || []) this.knownTabIds.add(t.id);
  }

  public getMaxSteps(): number {
    return this.maxSteps;
  }

  /** Runs steps until the mission ends. */
  public async run(): Promise<LoopOutcome> {
    for (;;) {
      const r = await this.step();
      if (r) return r;
    }
  }

  /** One observe -> decide -> act cycle. Returns the outcome when the mission ended, otherwise null. */
  public async step(): Promise<LoopOutcome | null> {
    try {
      return await this.stepInner();
    } catch (err: any) {
      if (err instanceof Cancelled || this.deps.signal.aborted) return this.end('cancelled', { error: 'Mission cancelled' });
      throw err;
    }
  }

  private end(state: LoopEndState, extra: Partial<LoopOutcome> = {}): LoopOutcome {
    return { state, evidence: [...this.evidence], steps: this.stepCount, ...extra };
  }

  private checkAbort(): void {
    if (this.deps.signal.aborted) throw new Cancelled();
  }

  private async stepInner(): Promise<LoopOutcome | null> {
    const { emit } = this.deps;
    this.checkAbort();
    if (this.deps.waitWhilePaused) await this.deps.waitWhilePaused();
    this.checkAbort();

    if (!this.seeded) {
      this.seeded = true;
      const criteria = this.deps.brief?.successCriteria?.length ? `\nSuccess criteria:\n${this.deps.brief.successCriteria.map(c => `- ${c}`).join('\n')}` : '';
      this.history.push({ role: 'user', content: `User Goal: ${this.deps.goal}${criteria}${this.deps.resumeNote ? `\n\n${this.deps.resumeNote}` : ''}` });
    }

    // Budgets (step 7)
    if (this.stepCount >= this.maxSteps) {
      emit.event?.('budget', { kind: 'steps', limit: this.maxSteps });
      return this.end('failed', { error: `Step budget reached: ${this.maxSteps} steps used without finishing` });
    }
    const spent = this.usage.getSummary().costTotal;
    if (this.maxCostUSD > 0 && spent >= this.maxCostUSD) {
      emit.event?.('budget', { kind: 'cost', limit: this.maxCostUSD, spent });
      return this.end('failed', { error: `Cost cap reached: $${spent.toFixed(4)} spent of $${this.maxCostUSD.toFixed(2)} allowed` });
    }

    this.stepCount++;
    const step = this.stepCount;
    emit.worker?.({ task: `Executing step ${step} of ${this.maxSteps}`, progress: Math.min(90, Math.round((step / this.maxSteps) * 100)) });

    for (const s of this.deps.drainSteering?.() || []) {
      emit.evidence(`[User Steering] ${s}`);
      this.history.push({ role: 'user', content: `[User Steering Instruction]: ${s}` });
    }

    // Observe
    const wc = this.tab.view.webContents;
    await raceAbort(settlePage(wc, null, { maxMs: this.deps.settleMaxMs ?? 8000 }), this.deps.signal);
    this.checkAbort();
    this.pruneHistory();
    const tabNote = this.adoptNewTabs();
    let snapshot = await raceAbort(PerceptionEngine.captureSnapshot(this.tab.view.webContents, false), this.deps.signal);
    this.checkAbort();

    // A mission that started before its tab committed a URL gets its scope from the first real page.
    if (this.policy.getAllowedHosts().length === 0 && /^https?:/i.test(snapshot.url)) this.policy.allowHost(snapshot.url);

    // The page may have left the mission scope by itself (redirect, link click): re-run the policy (edge case).
    if (!this.policy.isInScope(snapshot.url)) {
      const host = ActionPolicyEngine.hostOf(snapshot.url);
      const answer = await this.ask({
        kind: 'approval',
        text: `The page moved to ${host} (${snapshot.url.slice(0, 120)}), which is outside this mission's scope (${this.policy.getAllowedHosts().join(', ') || 'none'}). Continue on ${host}?`,
        options: ['Approve', 'Deny']
      });
      if (/^approve/i.test(answer)) {
        this.policy.allowHost(snapshot.url);
        emit.evidence(`[Policy] User approved origin ${host} for this mission`);
      } else {
        emit.evidence(`[Policy] User denied origin ${host}; going back`);
        if (this.tab.view.webContents.navigationHistory.canGoBack()) this.tab.view.webContents.navigationHistory.goBack();
        this.history.push({ role: 'user', content: `[System Notice] The user did not allow ${host}. The browser went back. Stay within ${this.policy.getAllowedHosts().join(', ')}.` });
        return null;
      }
    }

    const roadblock = ActionTaxonomy.detectPageRoadblocks(snapshot.title, snapshot.url, snapshot.formattedTree);
    const challenge = BotChallengeBridge.detectChallenge(snapshot.title, snapshot.formattedTree);
    if (roadblock || challenge.detected) {
      const msg = roadblock ? `${roadblock.message}. ${roadblock.suggestedRecovery}` : `Human verification required: ${challenge.message}`;
      emit.evidence(`[Roadblock Detected] ${msg}`);
      await this.ask({ kind: 'handoff', text: `${msg} Answer when you are done.`, options: ['Done'] });
      this.history.push({ role: 'user', content: '[Operator] The user handled the roadblock in the browser.' });
      snapshot = await raceAbort(PerceptionEngine.captureSnapshot(this.tab.view.webContents, false), this.deps.signal);
    }

    const observation = this.observationText(snapshot, tabNote);
    this.lastObservationHash = createHash('sha1').update(observation).digest('hex').slice(0, 12);
    this.recentObservations.push(observation);
    if (this.recentObservations.length > 3) this.recentObservations.shift();
    this.history.push({ role: 'user', content: observation });
    emit.evidence(`[Step ${step}] Observing: "${snapshot.title}" (${snapshot.elements.size} elements)`);

    // Decide
    let response: ModelResponse;
    try {
      response = await this.deps.provider.generate({
        messages: this.history,
        tools: this.tools,
        systemPrompt: PromptRegistry.getInstance().getEffectivePrompt('actor').systemPrompt,
        abortSignal: this.deps.signal,
        missionId: this.deps.missionId,
        stepId: `step_${step}`
      });
    } catch (err: any) {
      if (this.deps.signal.aborted) throw new Cancelled();
      emit.evidence(`[Error] Model invocation failed: ${err.message}`);
      return this.end('failed', { error: `Model error: ${err.message}` });
    }
    this.checkAbort();
    // Paused while the model call was in flight: the answer waits, nothing is executed until the user resumes.
    if (this.deps.waitWhilePaused) await this.deps.waitWhilePaused();
    this.checkAbort();
    this.recordUsage(response);

    if (response.thinking) emit.evidence(`[Thought Stream] ${response.thinking}`);
    if (response.finishReason === 'refusal') {
      emit.evidence(`[Refusal] ${response.text}`);
      return this.end('failed', { error: `Safety refusal: ${response.text}` });
    }

    const blocks: ContentBlock[] = [];
    if (response.text) {
      blocks.push({ type: 'text', text: response.text });
      emit.evidence(`[Agent Thought] ${response.text.slice(0, 140)}`);
    }
    for (const tc of response.toolCalls) blocks.push({ type: 'tool_call', id: tc.id, name: tc.name, arguments: tc.arguments });
    this.history.push({ role: 'assistant', content: blocks.length ? blocks : (response.text || '...') });

    if (response.toolCalls.length === 0) {
      this.nudges++;
      if (this.nudges > MAX_NUDGES) {
        emit.evidence('[Agent] The model chose no action again; stopping');
        return this.end('failed', { error: `The model returned no tool call ${this.nudges} times in a row` });
      }
      emit.evidence(`[Agent] No action chosen; nudge ${this.nudges} of ${MAX_NUDGES}`);
      this.history.push({ role: 'user', content: 'Please choose one of the tools to make progress, or call done/fail.' });
      return null;
    }
    this.nudges = 0;

    // Act: calls run in order; after the first failure the rest are answered as skipped (every call gets a result).
    let failed = false;
    for (const call of response.toolCalls) {
      if (failed) {
        this.toolResult(call.id, call.name, 'Skipped: an earlier tool call in this turn failed. Look at the new observation first.', true);
        continue;
      }
      this.checkAbort();
      if (GlobalKillSwitch.getInstance().isTriggered()) return this.end('cancelled', { error: 'Mission halted by Emergency Kill Switch' });
      const outcome = await this.runToolCall(call, snapshot, step);
      if (outcome === 'failed') failed = true;
      else if (outcome && typeof outcome === 'object') return outcome;
    }

    emit.checkpoint?.();
    if (this.deps.stepDelayMs !== 0) await abortableSleep(this.deps.stepDelayMs ?? 600, this.deps.signal);
    return null;
  }

  /** Executes one tool call. Returns 'failed' (stop the turn), a LoopOutcome (mission ended) or 'ok'. */
  private async runToolCall(call: { id: string; name: string; arguments: Record<string, any> }, snapshot: PageSnapshot, step: number): Promise<'ok' | 'failed' | LoopOutcome> {
    const { emit } = this.deps;
    const args = call.arguments ?? {};
    const invalid = validateToolArgs(call.name, args);
    if (invalid) {
      emit.evidence(`[Invalid Tool Call] ${call.name}: ${invalid}`);
      this.toolResult(call.id, call.name, `Invalid call to ${call.name}: ${invalid}`, true);
      return 'failed';
    }

    const target = typeof args.ref === 'string' ? snapshot.elements.get(args.ref) : undefined;
    const decision = this.policy.evaluateAction({
      missionId: this.deps.missionId,
      userGoal: this.deps.goal,
      allowedOrigins: this.policy.getAllowedHosts(),
      currentUrl: snapshot.url,
      actionName: call.name,
      actionArgs: args,
      targetFacts: { label: target?.name, name: target?.name, type: target?.type || target?.tagName, role: target?.role || target?.tagName, href: target?.href }
    });
    try {
      new AuditLog().logAction({ missionId: this.deps.missionId, actor: 'policy', action: call.name, decision: decision.decision, targetOrigin: snapshot.url, details: { riskClass: decision.riskClass, reason: decision.reason } });
    } catch { /* audit storage unavailable */ }
    emit.event?.('policy', { tool: call.name, decision: decision.decision, riskClass: decision.riskClass, reason: decision.reason });

    if (decision.decision === 'deny') {
      emit.evidence(`[Security Policy Denied] ${decision.reason}`);
      this.toolResult(call.id, call.name, `Denied by security policy: ${decision.reason}`, true);
      return 'failed';
    }
    if (decision.decision === 'ask') {
      emit.evidence(`[Human Approval Required: ${decision.riskClass}] ${decision.reason}`);
      const answer = await this.ask({ kind: 'approval', text: `Allow ${call.name}${args.url ? ` to ${args.url}` : target ? ` on "${target.name}"` : ''}? ${decision.reason}`, options: ['Approve', 'Deny'] });
      if (!/^approve/i.test(answer)) {
        emit.evidence(`[Policy] User denied ${call.name}`);
        this.toolResult(call.id, call.name, `The user denied this action (${decision.riskClass}). Choose another way or ask the user.`, true);
        return 'failed';
      }
      emit.evidence(`[Policy] User approved ${call.name} (${decision.riskClass})`);
    }
    // An allowed (approved or rule-allowed) navigation to a new host extends the mission scope.
    if (decision.riskClass === 'navigate-out-of-scope' && args.url) this.policy.allowHost(String(args.url));

    if (call.name === 'type' && typeof args.text === 'string' && args.text.includes('{{secret:')) {
      const subst = new SecretVault().substitutePlaceholder(args.text, snapshot.url);
      if (!subst.substituted || !subst.resolvedValue) {
        emit.evidence(`[Secret Substitution Blocked] ${subst.reason}`);
        this.toolResult(call.id, call.name, `Failed to autofill secret: ${subst.reason}`, true);
        return 'failed';
      }
      args.text = subst.resolvedValue;
    }

    // Stuck detection (step 6): same action on the same observation, STUCK_REPEATS times in a row.
    const sig = `${call.name}:${JSON.stringify(call.arguments)}@${this.lastObservationHash}`;
    this.actionSignatures.push(sig);
    const recent = this.actionSignatures.slice(-STUCK_REPEATS);
    const stuck = recent.length === STUCK_REPEATS && recent.every(s => s === sig) && !['done', 'fail', 'ask_user'].includes(call.name);

    emit.evidence(`[Action] ${call.name}(${JSON.stringify(call.name === 'type' ? { ref: args.ref } : args).slice(0, 100)})`);

    if (call.name === 'done') return this.finishWithVerification(call, args);

    emit.action?.({ step, tool: call.name, args, phase: 'start' });
    const exec: ToolExecutionResult = await raceAbort(ToolExecutor.execute(call.name, args, {
      tab: this.tab,
      snapshot,
      tabs: this.deps.tabs,
      owner: this.owner,
      startTabId: this.startTabId,
      missionDir: this.deps.missionDir,
      extractions: this.extractions
    }), this.deps.signal);
    emit.action?.({ step, tool: call.name, args, phase: 'end', ok: exec.ok });
    this.deps.actionLedger?.record(step, call.name, args, this.tab.id);

    let output = exec.output;
    if (exec.requiresUser) {
      const answer = await this.ask({ kind: 'question', text: exec.output, options: exec.effect?.options });
      output = `The user answered: ${answer}`;
    } else if (!exec.ok && !exec.isTerminal) {
      const classified = ActionTaxonomy.classify(exec.error || exec.output);
      output = `Error [${exec.error === 'stale_ref' ? 'STALE_REF' : classified.code}]: ${exec.output}`;
      emit.evidence(`[Tool Error] ${call.name}: ${exec.output.slice(0, 140)}`);
    }
    const dialogs = this.tab.executor.drainDialogs ? this.tab.executor.drainDialogs() : [];
    for (const d of dialogs) {
      output += `\n[Dialog] A ${d.type} dialog said "${d.message.slice(0, 200)}"; it was ${d.accepted ? 'accepted (OK)' : 'dismissed (Cancel)'}.`;
      emit.evidence(`[Dialog] ${d.type}: "${d.message.slice(0, 80)}" -> ${d.accepted ? 'OK' : 'Cancel'}`);
    }
    if (exec.switchToTabId) {
      const next = this.deps.tabs?.list().find(t => t.id === exec.switchToTabId);
      if (next) {
        this.tab = next;
        this.knownTabIds.add(next.id);
        await next.executor.attachCDP().catch(() => {});
      }
    }
    this.toolResult(call.id, call.name, output, !exec.ok);
    if (exec.image) {
      this.history.push({ role: 'user', content: [{ type: 'text', text: `[Screenshot of ${snapshot.url}]` }, { type: 'image', mimeType: exec.image.mimeType, base64: exec.image.base64 }] });
    }
    for (const ev of (exec.effect?.evidence as string[] | undefined) || []) {
      this.evidence.push(ev);
      emit.evidence(`[Evidence] ${ev}`);
    }

    if (exec.isTerminal) {
      return this.end('failed', { error: exec.error || exec.output });
    }

    if (stuck) {
      this.stuckHints++;
      this.actionSignatures.length = 0;
      if (this.stuckHints === 1) {
        emit.evidence(`[Loop Warning] "${call.name}" repeated ${STUCK_REPEATS} times on an unchanged page`);
        emit.event?.('stuck', { action: call.name, escalated: false });
        this.history.push({ role: 'user', content: `[System Notice] You are repeating yourself: ${call.name} with the same arguments ${STUCK_REPEATS} times while the page did not change. Try a different element or approach.` });
      } else {
        emit.event?.('stuck', { action: call.name, escalated: true });
        const answer = await this.ask({ kind: 'stuck', text: `The agent keeps repeating ${call.name}(${JSON.stringify(args).slice(0, 80)}) and the page does not change. How should it proceed?` });
        this.history.push({ role: 'user', content: `[User guidance after repeated actions]: ${answer}` });
        this.stuckHints = 0;
      }
    }
    return exec.ok ? 'ok' : 'failed';
  }

  private async finishWithVerification(call: { id: string; name: string }, args: Record<string, any>): Promise<'failed' | LoopOutcome> {
    const { emit } = this.deps;
    const answer = String(args.result || '');
    const claimed: string[] = Array.isArray(args.evidence) ? args.evidence.map(String) : [];
    const verdict = await this.verify(answer, claimed);
    const attempts = this.verifierRejections + 1;
    emit.event?.('verification', { ...verdict, attempt: attempts });
    if (verdict.verdict === 'pass') {
      emit.evidence(`[Verifier] pass: ${verdict.reasons.join('; ').slice(0, 160)}`);
      this.toolResult(call.id, call.name, 'Verified. Mission complete.', false);
      for (const e of claimed) { this.evidence.push(e); emit.evidence(`[Evidence] ${e}`); }
      return this.end('completed', { result: answer, verification: { verdict: 'pass', reasons: verdict.reasons, attempts } });
    }
    if (verdict.verdict === 'error') {
      emit.evidence(`[Verifier] could not check the answer: ${verdict.reasons.join('; ')}`);
      this.toolResult(call.id, call.name, 'Recorded without verification.', false);
      return this.end('completed_unverified', { result: answer, verification: { verdict: 'error', reasons: verdict.reasons, attempts } });
    }
    this.verifierRejections++;
    emit.evidence(`[Verifier] fail (${this.verifierRejections}/${MAX_VERIFIER_RETRIES + 1}): ${verdict.reasons.join('; ').slice(0, 160)}`);
    if (this.verifierRejections > MAX_VERIFIER_RETRIES) {
      this.toolResult(call.id, call.name, `Not verified: ${verdict.reasons.join('; ')}`, true);
      return this.end('completed_unverified', { result: answer, verification: { verdict: 'fail', reasons: verdict.reasons, attempts } });
    }
    this.toolResult(call.id, call.name, `The completion check rejected this answer: ${verdict.reasons.join('; ')}. Fix the problems (look at the page again) and call done again.`, true);
    return 'failed';
  }

  /** Independent completion check: a separate call with its own system prompt and none of the actor's history. */
  public async verify(answer: string, claimedEvidence: string[]): Promise<{ verdict: 'pass' | 'fail' | 'error'; reasons: string[] }> {
    const provider = this.deps.verifier || this.deps.provider;
    const criteria = this.deps.brief?.successCriteria?.length ? this.deps.brief.successCriteria.map(c => `- ${c}`).join('\n') : '- The answer fully answers the goal using facts visible on the page.';
    const obs = this.recentObservations.map((o, i) => `<observation n="${i + 1}">\n${o}\n</observation>`).join('\n');
    const content = `Goal: ${this.deps.goal}\n\nSuccess criteria:\n${criteria}\n\nLast ${this.recentObservations.length} observations of the browser (oldest first):\n${obs}\n\n` +
      `Proposed answer: ${answer}\n${claimedEvidence.length ? `Evidence the agent cites:\n${claimedEvidence.map(e => `- ${e}`).join('\n')}\n` : ''}\nDoes the proposed answer pass?`;
    let res: ModelResponse;
    try {
      res = await provider.generate({
        messages: [{ role: 'user', content }],
        tools: [VERDICT_TOOL],
        systemPrompt: PromptRegistry.getInstance().getEffectivePrompt('verifier').systemPrompt,
        abortSignal: this.deps.signal,
        missionId: this.deps.missionId,
        stepId: `verify_${this.stepCount}`
      });
    } catch (err: any) {
      if (this.deps.signal.aborted) throw new Cancelled();
      return { verdict: 'error', reasons: [`verifier call failed: ${err.message}`] };
    }
    this.recordUsage(res);
    const call = res.toolCalls.find(t => t.name === VERDICT_TOOL.name);
    let parsed: any = call?.arguments;
    if (!parsed) {
      const m = (res.text || '').match(/\{[\s\S]*\}/);
      try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
    }
    if (!parsed || typeof parsed.pass !== 'boolean') return { verdict: 'error', reasons: ['verifier returned no verdict'] };
    const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : [String(parsed.reasons ?? '')];
    return { verdict: parsed.pass ? 'pass' : 'fail', reasons };
  }

  private async ask(q: Omit<UserQuestion, 'id'>): Promise<string> {
    const question: UserQuestion = { ...q, id: `q${++this.questionSeq}` };
    this.deps.emit.status(q.kind === 'approval' ? 'waiting_approval' : 'waiting_user', `Waiting for you: ${q.text.slice(0, 140)}`);
    this.deps.emit.event?.('question', question);
    this.deps.emit.evidence(`[Question] ${q.text}`);
    let answer: string;
    try {
      answer = await this.deps.askUser(question);
    } catch {
      throw new Cancelled();
    }
    this.checkAbort();
    this.deps.emit.event?.('answer', { id: question.id, answer });
    this.deps.emit.evidence(`[Answer] ${answer}`);
    this.deps.emit.status('running', 'Mission resumed after your answer');
    return answer;
  }

  private toolResult(id: string, name: string, output: string, isError: boolean): void {
    this.history.push({ role: 'tool', name, content: [{ type: 'tool_result', toolCallId: id, output, isError }] });
  }

  private recordUsage(res: ModelResponse): void {
    if (!res.usage) return;
    const stats = this.usage.recordUsage(this.deps.model, res.usage.promptTokens, res.usage.completionTokens, res.usage.cacheReadTokens || 0);
    this.deps.emit.telemetry?.({ tokensTotal: stats.tokensTotal, costTotal: stats.costTotal, stepTokens: res.usage.promptTokens + res.usage.completionTokens, stepCost: stats.stepCost });
  }

  /** New tabs owned by this mission (popups from a click, target=_blank) become the current tab. */
  private adoptNewTabs(): string {
    const host = this.deps.tabs;
    if (!host) return '';
    let note = '';
    for (const t of host.list()) {
      if (this.knownTabIds.has(t.id)) continue;
      this.knownTabIds.add(t.id);
      if (t.state.owner === this.owner && t.openerId === this.tab.id) {
        note += `[A new tab ${t.id} was opened by the page (${t.state.url}); it is now the current tab.]\n`;
        this.deps.emit.evidence(`[New Tab] ${t.id} ${t.state.url}`);
        host.activate(t.id);
        this.tab = t;
        void t.executor.attachCDP().catch(() => {});
      }
    }
    return note;
  }

  private observationText(snapshot: PageSnapshot, tabNote: string): string {
    const redact = (s: string) => SecretVault.maskHighEntropyTokens(this.privacy.redactPII(s).cleaned);
    const tabs = this.deps.tabs
      ? this.deps.tabs.list().filter(t => t.state.owner === this.owner || t.id === this.startTabId)
          .map(t => `${t.id}${t.id === this.tab.id ? ' (current)' : ''}: ${PromptIsolationEngine.escapeXml(t.state.title || '')} ${t.state.url}`).join('\n')
      : '';
    return [
      OBS_MARK,
      tabNote.trim(),
      `URL: ${snapshot.url}`,
      `Title: ${PromptIsolationEngine.escapeXml(snapshot.title)}`,
      tabs ? `Tabs:\n${tabs}` : '',
      snapshot.headings.length ? `Headings:\n${redact(snapshot.headings.join('\n'))}` : '',
      `Interactive Elements:\n${redact(snapshot.formattedTree)}`,
      snapshot.opaqueFrames.length ? `Cross-origin frames (not readable): ${snapshot.opaqueFrames.join(', ')}` : '',
      `<page_text trust="untrusted">\n${redact(snapshot.pageText.slice(0, 3000))}\n</page_text>`
    ].filter(Boolean).join('\n');
  }

  /** Keeps the newest full observation (the model then sees it plus the new one); older ones are replaced by a one-line summary (bounded context). */
  private pruneHistory(): void {
    const idx: number[] = [];
    this.history.forEach((m, i) => {
      if (m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(OBS_MARK)) idx.push(i);
    });
    for (const i of idx.slice(0, Math.max(0, idx.length - 1))) {
      const text = this.history[i].content as string;
      const url = (text.match(/^URL:\s*(\S+)/m) || [])[1] || '';
      const title = (text.match(/^Title:\s*(.*)$/m) || [])[1] || '';
      this.history[i].content = `[Page State Summary: visited "${title}" (${url}); snapshot pruned]`;
    }
    // Screenshots older than the newest one are dropped too (images dominate the token count).
    const imgs: number[] = [];
    this.history.forEach((m, i) => { if (Array.isArray(m.content) && m.content.some(b => b.type === 'image')) imgs.push(i); });
    for (const i of imgs.slice(0, -1)) this.history[i].content = '[Screenshot pruned]';
    logger.debug('History pruned', { messages: this.history.length });
  }
}
