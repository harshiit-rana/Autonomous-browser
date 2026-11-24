import { BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ViewManager, TabView } from '../main/view_manager.js';
import { ModelProviderFactory } from '../models/provider_factory.js';
import { IModelProvider, CanonicalMessage, ModelRequest } from '../models/types.js';
import { PerceptionEngine } from './perception.js';
import { IPC_CHANNELS, ModelProviderId, WorkerEventPayload, EvidenceEventPayload, MissionStatusPayload, TelemetryEventPayload, MissionQuestionPayload } from '../ipc/contract.js';
import { rootLogger } from '../infrastructure/logger.js';
import { getSettings, clampMaxWorkers } from '../infrastructure/settings.js';
import { getAppPaths } from '../infrastructure/paths.js';
import { UsageLedger } from '../models/pricing.js';
import { globalGovernor } from '../models/governor.js';
import {
  MidRunSteeringQueue,
  ActionLedger,
  SteeringClass
} from './steering_and_reversibility.js';
import { SwarmCoordinator } from '../swarm/coordinator.js';
import { SwarmManager } from '../swarm/swarm_manager.js';
import { SharedBlackboard } from '../swarm/blackboard.js';
import { WorkerSupervisor } from '../swarm/supervisor.js';
import { runWorkerTask, runNonBrowserTask, WorkerRunDeps, DEFAULT_WORKER_MAX_STEPS } from '../swarm/worker_task_runner.js';
import { UrlClaims } from '../swarm/worker_findings.js';
import { PauseGate, QuestionQueue } from '../swarm/worker_coordination.js';
import { MissionRecorder } from '../infrastructure/mission_recorder.js';
import { AgentLoop, MissionBrief, UserQuestion, VerificationOutcome, LoopOutcome } from './agent_loop.js';
import { AgentTabHost } from './tools.js';

const logger = rootLogger.child('agent-runtime');

export type MissionState =
  | 'idle'
  | 'planning'
  | 'running'
  | 'paused'
  | 'waiting_user'
  | 'completed'
  | 'completed_unverified'
  | 'failed'
  | 'cancelled';

const TERMINAL: MissionState[] = ['completed', 'completed_unverified', 'failed', 'cancelled'];

export interface Mission {
  id: string;
  prompt: string;
  model: string;
  state: MissionState;
  stepCount: number;
  maxSteps: number;
  history: CanonicalMessage[];
  tabId?: string;
  result?: string;
  error?: string;
  evidenceCollected: string[];
  brief?: MissionBrief;
  verification?: VerificationOutcome;
}

/** Routes every model call through the global concurrency governor. */
function governed(p: IModelProvider): IModelProvider {
  return {
    providerName: p.providerName,
    modelName: p.modelName,
    generate: (req: ModelRequest) => globalGovernor.executeSafe(p, req)
  };
}

/**
 * Mission lifecycle (start, pause, cancel, questions, finish). The observe -> decide -> act loop itself is
 * `AgentLoop` (agent_loop.ts, #225), so swarm workers can reuse it.
 */
export class AgentRuntime {
  private static instance: AgentRuntime | null = null;
  private activeMission: Mission | null = null;
  private abortController: AbortController | null = null;
  private activeSwarm: SwarmManager | null = null;
  private isPaused: boolean = false;
  private pausePromiseResolve: (() => void) | null = null;
  private usageLedger: UsageLedger = new UsageLedger();
  private actionLedger: ActionLedger = new ActionLedger();
  private steeringQueue: MidRunSteeringQueue = new MidRunSteeringQueue();
  private pendingQuestion: { question: MissionQuestionPayload; resolve: (a: string) => void; reject: (e: Error) => void } | null = null;
  private activeLoop: AgentLoop | null = null;
  /** Swarm missions: every worker waits on this gate and shares this question queue (#227). */
  private swarmGate = new PauseGate();
  private swarmQuestions = new QuestionQueue();

  private viewManager: ViewManager;
  private window: BrowserWindow;

  private constructor(window: BrowserWindow, viewManager: ViewManager) {
    this.window = window;
    this.viewManager = viewManager;
  }

  public static initialize(window: BrowserWindow, viewManager: ViewManager): AgentRuntime {
    if (!AgentRuntime.instance) {
      AgentRuntime.instance = new AgentRuntime(window, viewManager);
    }
    return AgentRuntime.instance;
  }

  public static getInstance(): AgentRuntime {
    if (!AgentRuntime.instance) {
      throw new Error('AgentRuntime not yet initialized');
    }
    return AgentRuntime.instance;
  }

  public getActiveMission(): Mission | null {
    return this.activeMission;
  }

  public getPendingQuestion(): MissionQuestionPayload | null {
    return this.pendingQuestion?.question ?? null;
  }

  public async startMission(prompt: string, modelName?: string, brief?: MissionBrief): Promise<{ ok: boolean; missionId?: string; error?: string; code?: 'MODEL_NOT_CONFIGURED'; provider?: ModelProviderId }> {
    if (this.activeMission && !TERMINAL.includes(this.activeMission.state) && this.activeMission.state !== 'idle') {
      return {
        ok: false,
        error: 'A mission is already currently running. Please wait or cancel the active mission.'
      };
    }

    const settings = getSettings();
    const targetModel = modelName || settings.modelName || 'gemini-2.0-flash';

    // Verify credential availability upfront (typed MODEL_NOT_CONFIGURED, #224)
    const modelCheck = ModelProviderFactory.inspect(targetModel);
    if (!modelCheck.configured) {
      return { ok: false, error: modelCheck.message, code: 'MODEL_NOT_CONFIGURED', provider: modelCheck.provider };
    }

    const missionId = `m_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    this.abortController = new AbortController();
    this.isPaused = false;
    this.usageLedger.reset();

    let targetTab = this.viewManager.getActiveTab();
    if (!targetTab) {
      targetTab = this.viewManager.createTab('https://duckduckgo.com', false, `agent:${missionId}`);
    }

    this.activeMission = {
      id: missionId,
      prompt,
      model: targetModel,
      state: 'planning',
      stepCount: 0,
      maxSteps: Math.min(brief?.maxSteps ?? settings.maxSteps, settings.maxSteps),
      history: [],
      tabId: targetTab.id,
      evidenceCollected: [],
      brief
    };
    MissionRecorder.checkpoint(this.activeMission); // mission row must exist before its first event (FK)

    logger.info('Starting mission', { missionId, prompt, model: this.activeMission.model, tabId: targetTab.id });

    this.emitMissionStatus('planning', `Planning goal: "${prompt.slice(0, 50)}..."`);
    this.emitWorkerEvent({
      id: 'worker-agent-1',
      name: 'Agent [Planner]',
      task: `Analyzing goal: "${prompt.slice(0, 40)}"`,
      progress: 10,
      status: 'running'
    });
    this.emitEvidence(`[Mission ${missionId}] Initialized with goal: "${prompt}"`);

    this.runLoop().catch(err => {
      logger.error('Unhandled error in agent execution loop', err);
      this.finishMission('failed', undefined, err.message);
    });

    return { ok: true, missionId };
  }

  public pause(): void {
    if (this.activeMission && this.activeMission.state === 'running') {
      this.isPaused = true;
      this.swarmGate.pause();
      this.activeMission.state = 'paused';
      this.emitMissionStatus('paused', 'Mission paused by user');
      this.emitEvidence('[Agent] Execution paused');
      logger.info('Mission paused', { missionId: this.activeMission.id });
    }
  }

  public resume(): void {
    if (this.activeMission && this.activeMission.state === 'paused') {
      this.isPaused = false;
      this.swarmGate.resume();
      this.activeMission.state = 'running';
      if (this.pausePromiseResolve) {
        this.pausePromiseResolve();
        this.pausePromiseResolve = null;
      }
      this.emitMissionStatus('running', 'Mission resumed');
      this.emitEvidence('[Agent] Execution resumed');
      logger.info('Mission resumed', { missionId: this.activeMission.id });
    }
  }

  public takeover(): void {
    if (this.activeMission && this.activeMission.state === 'running') {
      this.pause();
      this.emitEvidence('[Manual Takeover] Human operator took manual control of the browser.');
      this.emitMissionStatus('paused', 'Manual human takeover active');
    }
  }

  public async handBack(): Promise<void> {
    if (this.activeMission && this.activeMission.state === 'paused') {
      this.emitEvidence('[Hand Back] Human operator returned control to agent. Reconciling page state...');
      const tab = this.activeLoop?.tab || this.viewManager.getActiveTab();
      if (tab) {
        const snapshot = await PerceptionEngine.captureSnapshot(tab.view.webContents, false);
        this.activeMission.history.push({
          role: 'user',
          content: `[Operator Hand Back] The user completed manual interaction and returned control. Current page: ${snapshot.url} "${snapshot.title}"`
        });
      }
      this.resume();
    }
  }

  public cancel(): void {
    if (this.activeMission) {
      logger.info('Cancelling mission', { missionId: this.activeMission.id });
      this.abortController?.abort();
      this.swarmGate.resume(); // paused workers wake up, see the abort and stop
      void this.activeSwarm?.shutdown();
      if (this.pausePromiseResolve) {
        this.pausePromiseResolve();
        this.pausePromiseResolve = null;
      }
      if (this.pendingQuestion) {
        this.pendingQuestion.reject(new Error('Mission cancelled'));
        this.pendingQuestion = null;
      }
      this.finishMission('cancelled', undefined, 'Mission cancelled by user');
    }
  }

  /** The user's answer to the open question (ask_user, approval, stuck escalation). */
  public answerQuestion(missionId: string, questionId: string, answer: string): { ok: boolean; error?: string } {
    const p = this.pendingQuestion;
    if (!p || p.question.missionId !== missionId || p.question.id !== questionId) {
      return { ok: false, error: 'No such open question' };
    }
    const text = String(answer ?? '').trim();
    if (!text) return { ok: false, error: 'Empty answer' };
    this.pendingQuestion = null;
    p.resolve(text.slice(0, 2000));
    return { ok: true };
  }

  public steer(message: string, type: SteeringClass = 'steering'): void {
    this.steeringQueue.enqueue(type, message);
    this.emitEvidence(`[Steering Queued] ${type}: ${message}`);
  }

  public async undoLastAction(): Promise<{ ok: boolean; message: string }> {
    return this.actionLedger.undoLast(this.viewManager);
  }

  public getActionLedger(): ActionLedger {
    return this.actionLedger;
  }

  private async runSwarmLoop(mission: Mission): Promise<void> {
    const settings = getSettings();
    const maxWorkers = clampMaxWorkers(settings.maxWorkers);
    const signal = this.abortController!.signal;
    // One manager per mission: its workers get `agent-<missionId>-<workerId>` in-memory partitions and their own
    // views (shown in the Grid by ViewManager, #232); they are all torn down in the finally below (also when the
    // window closes or the mission is cancelled). The user's tabs are never used.
    const swarm = new SwarmManager({ maxWorkers, missionId: mission.id, parentWindow: this.window });
    this.activeSwarm = swarm;
    const supervisor = new WorkerSupervisor({ stallThresholdMs: 90_000 });
    const coordinator = new SwarmCoordinator({
      swarm,
      blackboard: new SharedBlackboard({ missionId: mission.id }),
      supervisor,
      maxWorkers
    });
    const abortHandles = new Map<string, (reason: string) => void>();
    this.swarmGate = new PauseGate();
    this.swarmQuestions = new QuestionQueue();

    coordinator.on('stageStarted', (ev: any) => {
      this.emitEvidence(`[Swarm Stage Started] ${ev.stageName} (${ev.taskCount} tasks)`);
      this.emitMissionStatus('running', `Stage: ${ev.stageName}`);
    });

    const workerEvent = (ev: any, task: string, status: WorkerEventPayload['status'], progress: number) => this.emitWorkerEvent({
      id: ev.workerId, workerId: ev.workerId, name: ev.identity?.name, color: ev.identity?.color, glyph: ev.identity?.glyph,
      task, progress, status, at: Date.now()
    });
    coordinator.on('taskStarted', (ev: any) => workerEvent(ev, `Starting: ${ev.name ?? ev.taskId}`, 'running', 5));
    coordinator.on('taskRetry', (ev: any) => workerEvent(ev, `Retrying after: ${String(ev.error).slice(0, 80)}`, 'running', 5));
    coordinator.on('taskFailed', (ev: any) => workerEvent(ev, `Failed: ${String(ev.error).slice(0, 80)}`, 'failed', 100));
    coordinator.on('taskNeedsHuman', (ev: any) => this.emitEvidence(`[Needs You] ${ev.identity?.name ?? ev.workerId}: ${String(ev.reason).slice(0, 160)}`));
    coordinator.on('workerStalled', (ev: any) => {
      this.emitEvidence(`[Supervisor] ${ev.workerId} stalled (${ev.stallClass}); stopping that attempt`);
      abortHandles.get(ev.workerId)?.('stalled');
    });

    coordinator.getBlackboard().on('evidence', (evItem: any) => {
      const cite = `[${evItem.entity} - ${evItem.attribute}: ${evItem.normalized.text || evItem.value}] from ${evItem.source.url}`;
      mission.evidenceCollected.push(cite);
      this.emitEvidence(`[Blackboard Evidence] ${cite}`);
    });

    coordinator.getBlackboard().on('conflict', (conf: any) => {
      this.emitEvidence(`[Blackboard Conflict Detected] ${conf.entity}::${conf.attribute} has contradictory claims. Escalating to verifier.`);
    });

    coordinator.getBlackboard().on('conflictResolved', (conf: any) => {
      this.emitEvidence(`[Blackboard Conflict Resolved] ${conf.entity}::${conf.attribute} resolved to "${conf.resolvedValue}" via ${conf.resolutionMethod}.`);
    });

    let result;
    try {
      const provider = governed(await ModelProviderFactory.createProvider(mission.model));
      const claims = new UrlClaims();
      const questions = this.swarmQuestions;
      const runDeps: WorkerRunDeps = {
        missionId: mission.id,
        provider,
        blackboard: coordinator.getBlackboard(),
        claims,
        settings: { privacyMode: settings.privacyMode, policyRules: settings.policyRules, maxSteps: settings.maxSteps, maxCostUSD: settings.maxCostUSD },
        signal,
        startUrl: /^https?:/i.test(settings.defaultSearchEngine) ? new URL(settings.defaultSearchEngine).origin : undefined,
        workerMaxSteps: Math.min(settings.maxSteps, DEFAULT_WORKER_MAX_STEPS),
        workerMaxCostUSD: settings.maxCostUSD / maxWorkers,
        supervisor,
        abortHandles,
        waitWhilePaused: () => this.swarmGate.wait(signal),
        askUser: q => questions.ask(() => this.askUser(mission, q), signal),
        emitWorker: p => this.emitWorkerEvent(p),
        emitEvidence: t => this.emitEvidence(t),
        recordEvent: (kind, data) => MissionRecorder.event(mission.id, kind, data)
      };
      result = await coordinator.executeMission(
        mission.id,
        mission.prompt,
        (worker, task) => runWorkerTask(worker, task, runDeps),
        { inlineExecutorFn: task => runNonBrowserTask(task, runDeps), signal }
      );
    } finally {
      this.activeSwarm = null;
      await swarm.shutdown();
    }
    if (TERMINAL.includes(mission.state)) return; // cancelled while the swarm was unwinding
    if (result.success) {
      this.finishMission('completed', result.deliverableMarkdown);
    } else {
      this.finishMission('failed', undefined, result.errors.join('; ') || 'No worker finished its task');
    }
  }

  /** ViewManager as the loop's tab host (agent-owned tabs only; ownership is checked in the tools). */
  private tabHost(): AgentTabHost {
    const vm = this.viewManager;
    return {
      open: (url, owner) => vm.createTab(url, false, owner),
      activate: id => vm.setActiveTab(id),
      close: id => vm.closeTab(id),
      list: () => vm.listTabs()
    };
  }

  private missionDir(missionId: string): string | undefined {
    try {
      const dir = path.join(getAppPaths().userData, 'missions', missionId, 'files');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      return undefined;
    }
  }

  private async runLoop(): Promise<void> {
    if (!this.activeMission) return;
    const mission = this.activeMission;
    mission.state = 'running';

    if (mission.prompt.startsWith('/swarm') || mission.prompt.startsWith('/research') || /compare.*across/i.test(mission.prompt)) {
      await this.runSwarmLoop(mission);
      return;
    }

    const tab: TabView | undefined = this.viewManager.getTab(mission.tabId || '') || this.viewManager.getActiveTab();
    if (!tab) {
      throw new Error('No active browser tab found to operate on');
    }
    try {
      await tab.executor.ensureReady();
    } catch { /* CDP unavailable: tools report their own errors */ }

    const settings = getSettings();
    const provider = governed(await ModelProviderFactory.createProvider(mission.model));
    const verifier = governed(await ModelProviderFactory.createVerifierProvider(mission.model, settings.verifierModel));
    const signal = this.abortController!.signal;

    const loop = new AgentLoop({
      missionId: mission.id,
      goal: mission.prompt,
      model: mission.model,
      tab,
      provider,
      verifier,
      settings: { privacyMode: settings.privacyMode, policyRules: settings.policyRules, maxSteps: settings.maxSteps, maxCostUSD: settings.maxCostUSD },
      brief: mission.brief,
      history: mission.history,
      signal,
      tabs: this.tabHost(),
      missionDir: this.missionDir(mission.id),
      usage: this.usageLedger,
      actionLedger: this.actionLedger,
      drainSteering: () => this.steeringQueue.drain().map(s => `${s.type}: ${s.text}`),
      waitWhilePaused: async () => {
        while (this.isPaused && !signal.aborted) {
          await new Promise<void>(resolve => { this.pausePromiseResolve = resolve; });
        }
      },
      askUser: q => this.askUser(mission, q),
      emit: {
        evidence: t => this.emitEvidence(t),
        status: (s, m) => {
          if (TERMINAL.includes(mission.state)) return;
          mission.state = s;
          this.emitMissionStatus(s, m);
        },
        telemetry: p => this.emitTelemetry(p),
        worker: p => this.emitWorkerEvent({ id: 'worker-agent-1', name: 'Agent [Operator]', task: p.task, progress: p.progress, status: 'running' }),
        event: (kind, data) => MissionRecorder.event(mission.id, kind, data),
        checkpoint: () => {
          mission.stepCount = loop.stepCount;
          mission.tabId = loop.tab.id;
          MissionRecorder.checkpoint(mission);
        }
      }
    });
    this.activeLoop = loop;
    mission.maxSteps = loop.getMaxSteps();

    let outcome: LoopOutcome;
    try {
      outcome = await loop.run();
    } finally {
      this.activeLoop = null;
    }
    mission.stepCount = loop.stepCount;
    for (const e of outcome.evidence) if (!mission.evidenceCollected.includes(e)) mission.evidenceCollected.push(e);
    if (TERMINAL.includes(mission.state)) return; // cancelled while the loop was finishing
    mission.verification = outcome.verification;
    this.finishMission(outcome.state, outcome.result, outcome.error);
  }

  private askUser(mission: Mission, q: UserQuestion): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const payload: MissionQuestionPayload = { missionId: mission.id, id: q.id, text: q.text, options: q.options, kind: q.kind };
      this.pendingQuestion = { question: payload, resolve, reject };
      try {
        if (!this.window.isDestroyed()) this.window.webContents.send(IPC_CHANNELS.EVENT_MISSION_QUESTION, payload);
      } catch { /* window gone; the mission can still be cancelled */ }
    });
  }

  private saveCheckpoint(mission: Mission): void {
    MissionRecorder.checkpoint(mission);
  }

  private saveDeliverableReport(mission: Mission): void {
    try {
      const paths = getAppPaths();
      const deliverablesDir = path.join(paths.userData, 'deliverables');
      if (!fs.existsSync(deliverablesDir)) {
        fs.mkdirSync(deliverablesDir, { recursive: true });
      }
      const filePath = path.join(deliverablesDir, `${mission.id}_report.md`);
      const v = mission.verification;
      const md = `# Mission Report: ${mission.prompt}\n\n` +
        `**Status:** ${mission.state}\n` +
        `**Model:** ${mission.model}\n` +
        `**Steps Executed:** ${mission.stepCount}\n` +
        `**Verifier:** ${v ? `${v.verdict} after ${v.attempts} check(s): ${v.reasons.join('; ')}` : 'not run'}\n` +
        `**Date:** ${new Date().toISOString()}\n\n` +
        `## Deliverable Findings\n${mission.result || 'No final result recorded.'}\n\n` +
        `## Evidence (${mission.evidenceCollected.length})\n` +
        mission.evidenceCollected.map((e, idx) => `${idx + 1}. ${e}`).join('\n') + '\n';
      fs.writeFileSync(filePath, md, 'utf-8');
      logger.info('Deliverable report saved', { filePath });
    } catch (err: any) {
      logger.warn('Failed to save deliverable report', { error: err.message });
    }
  }

  private finishMission(state: MissionState, result?: string, error?: string): void {
    if (!this.activeMission) return;
    if (TERMINAL.includes(this.activeMission.state)) return; // already finished (e.g. cancelled while the loop unwound)
    this.activeMission.state = state;
    this.activeMission.result = result;
    this.activeMission.error = error;
    if (this.pendingQuestion) {
      this.pendingQuestion.reject(new Error('Mission ended'));
      this.pendingQuestion = null;
    }

    const v = this.activeMission.verification;
    logger.info('Mission finished', { state, result, error, verifier: v?.verdict });
    if (v) MissionRecorder.event(this.activeMission.id, 'mission.verification', v);

    const verdictText = v ? ` (verifier: ${v.verdict})` : '';
    const statusText = state === 'completed'
      ? `Mission succeeded${verdictText}: ${result?.slice(0, 100) || 'Complete'}`
      : state === 'completed_unverified'
        ? `Mission finished UNVERIFIED${verdictText}: ${result?.slice(0, 100) || ''}${v?.reasons.length ? ` | checker: ${v.reasons.join('; ').slice(0, 120)}` : ''}`
        : `Mission ${state}: ${error || 'Ended'}`;

    this.emitMissionStatus(state, statusText);

    // Native OS Notification (Issue #146: Background awareness)
    try {
      const { Notification } = require('electron');
      if (Notification && Notification.isSupported && Notification.isSupported()) {
        new Notification({
          title: `Aegis Mission ${state === 'completed' ? 'Completed' : 'Finished'}`,
          body: `Status: ${state} - "${this.activeMission.prompt.slice(0, 50)}"`
        }).show();
      }
    } catch {}

    const ok = state === 'completed' || state === 'completed_unverified';
    this.emitWorkerEvent({
      id: 'worker-agent-1',
      name: 'Agent [Operator]',
      task: statusText,
      progress: ok ? 100 : 0,
      status: ok ? 'done' : 'failed'
    });
    this.emitEvidence(`[Mission Finished] ${statusText}`);

    this.saveCheckpoint(this.activeMission);
    if (ok) {
      this.saveDeliverableReport(this.activeMission);
    }
  }

  private emitMissionStatus(status: MissionStatusPayload['status'], message: string): void {
    try {
      if (!this.window.isDestroyed()) {
        const payload: MissionStatusPayload = {
          missionId: this.activeMission?.id,
          status,
          message
        };
        if (this.activeMission) MissionRecorder.checkpoint(this.activeMission);
        MissionRecorder.event(this.activeMission?.id, 'status', payload);
        this.window.webContents.send(IPC_CHANNELS.EVENT_MISSION_STATUS, payload);
      }
    } catch {}
  }

  private emitWorkerEvent(payload: WorkerEventPayload): void {
    try {
      if (!this.window.isDestroyed()) {
        MissionRecorder.event(this.activeMission?.id, 'worker', payload);
        this.window.webContents.send(IPC_CHANNELS.EVENT_WORKER, payload);
      }
    } catch {}
  }

  private emitEvidence(text: string): void {
    try {
      if (!this.window.isDestroyed()) {
        const payload: EvidenceEventPayload = {
          text,
          timestamp: new Date().toTimeString().slice(0, 8)
        };
        MissionRecorder.event(this.activeMission?.id, 'evidence', payload);
        this.window.webContents.send(IPC_CHANNELS.EVENT_EVIDENCE, payload);
      }
    } catch {}
  }

  private emitTelemetry(payload: TelemetryEventPayload): void {
    try {
      if (!this.window.isDestroyed()) {
        MissionRecorder.event(this.activeMission?.id, 'telemetry', payload);
        this.window.webContents.send(IPC_CHANNELS.EVENT_TELEMETRY, payload);
      }
    } catch {}
  }
}
