import { BrowserWindow, app } from 'electron';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ViewManager, TabView } from '../main/view_manager.js';
import { ModelProviderFactory } from '../models/provider_factory.js';
import { IModelProvider, CanonicalMessage, ModelRequest } from '../models/types.js';
import { PerceptionEngine } from './perception.js';
import { IPC_CHANNELS, ModelProviderId, WorkerEventPayload, EvidenceEventPayload, MissionStatusPayload, TelemetryEventPayload, MissionQuestionPayload, InterruptedMission, WorkerControlResponse, GovernanceMetricsPayload } from '../ipc/contract.js';
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
import { SwarmCoordinator, MissionDecompositionPlan } from '../swarm/coordinator.js';
import { planWithOrchestrator, validateOrchestratorPlan } from '../swarm/orchestrator.js';
import { SwarmManager } from '../swarm/swarm_manager.js';
import { SharedBlackboard } from '../swarm/blackboard.js';
import { WorkerSupervisor, DEFAULT_STALL_THRESHOLD_MS } from '../swarm/supervisor.js';
import { ResourceGovernor } from '../swarm/resource_governor.js';
import { runWorkerTask, runNonBrowserTask, WorkerRunDeps, DEFAULT_WORKER_MAX_STEPS } from '../swarm/worker_task_runner.js';
import { UrlClaims } from '../swarm/worker_findings.js';
import { PauseGate, QuestionQueue } from '../swarm/worker_coordination.js';
import { MissionRecorder } from '../infrastructure/mission_recorder.js';
import { EventLog } from './event_log.js';
import { AgentLoop, MissionBrief, UserQuestion, VerificationOutcome, LoopOutcome } from './agent_loop.js';
import { AgentTabHost } from './tools.js';
import { MissionState, MissionStateMachine, MissionStatusEvent, isTerminal } from './mission_state.js';
import {
  CheckpointAction, MissionCheckpoint, SIDE_EFFECT_TOOLS, buildResumeNote, listInterrupted, readCheckpoint,
  removeCheckpoint, summarizeAction, writeCheckpoint
} from './mission_checkpoint.js';

const logger = rootLogger.child('agent-runtime');

export type { MissionState } from './mission_state.js';

export interface Mission {
  id: string;
  prompt: string;
  model: string;
  state: MissionState;
  mode?: 'single' | 'swarm';
  approvedPlan?: MissionDecompositionPlan;
  approvedMode?: 'single' | 'swarm';
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

/** Seams for tests. Production uses the defaults (the real provider factory, the real app data dir, strict outside packaged builds). */
export interface RuntimeDeps {
  createProvider?: (model: string) => Promise<IModelProvider>;
  createVerifierProvider?: (model: string, verifierModel?: string) => Promise<IModelProvider>;
  createOrchestratorProvider?: (model: string, orchestratorModel?: string) => Promise<IModelProvider>;
  inspect?: (model: string) => { configured: boolean; message?: string; provider?: ModelProviderId };
  userDataDir?: () => string;
  /** Illegal state transitions throw (true) or are logged and ignored (false). Default: throw unless the app is packaged. */
  strict?: boolean;
  /** Loop timing overrides (tests). */
  stepDelayMs?: number;
  settleMaxMs?: number;
  stallThresholdMs?: number;
  resourceGovernor?: ResourceGovernor;
}

/** Routes every model call through the global concurrency governor. */
function governed(p: IModelProvider): IModelProvider {
  return {
    providerName: p.providerName,
    modelName: p.modelName,
    generate: (req: ModelRequest) => globalGovernor.executeSafe(p, req)
  };
}

interface LaunchOptions {
  resume?: MissionCheckpoint;
  approvedPlan?: MissionDecompositionPlan;
  approvedMode?: 'single' | 'swarm';
}

/**
 * Mission lifecycle (start, pause, cancel, questions, finish). The observe -> decide -> act loop itself is
 * `AgentLoop` (agent_loop.ts, #225), so swarm workers can reuse it. Every state change goes through the mission's
 * `MissionStateMachine` (mission_state.ts, #226): one `mission:status` event per transition.
 */
export class AgentRuntime {
  private static instance: AgentRuntime | null = null;
  private activeMission: Mission | null = null;
  private machine: MissionStateMachine | null = null;
  private abortController: AbortController | null = null;
  private activeSwarm: SwarmManager | null = null;
  private isPaused: boolean = false;
  private pausePromiseResolve: (() => void) | null = null;
  private usageLedger: UsageLedger = new UsageLedger();
  private actionLedger: ActionLedger = new ActionLedger();
  private steeringQueue: MidRunSteeringQueue = new MidRunSteeringQueue();
  private pendingQuestion: { question: MissionQuestionPayload; resolve: (a: string) => void; reject: (e: Error) => void } | null = null;
  private activeLoop: AgentLoop | null = null;
  private pendingMessage: string | undefined;
  private crashSeq = 0;
  private ckptActions: CheckpointAction[] = [];
  private ckptNotes: string[] = [];
  private ckptResumedFrom: string | undefined;
  public lastCheckpointError: string | null = null;
  /** Emits `status` (MissionStatusPayload), `question` (MissionQuestionPayload) and `evidence` (EvidenceEventPayload). */
  public readonly events = new EventEmitter();
  /** Swarm missions: every worker waits on this gate and shares this question queue (#227). */
  private swarmGate = new PauseGate();
  private swarmQuestions = new QuestionQueue();
  /** Per-worker controls, gates, supervisor, and resource governor (#231). */
  private governor: ResourceGovernor;
  private workerSupervisor: WorkerSupervisor | null = null;
  private workerGates = new Map<string, PauseGate>();
  private workerAbortHandles = new Map<string, (reason: string) => void>();
  private stoppedWorkers = new Set<string>();
  private workerTakeoverIds = new Set<string>();
  private workerMeta = new Map<string, WorkerEventPayload>();

  private viewManager: ViewManager;
  private window: BrowserWindow;
  private deps: RuntimeDeps;

  private constructor(window: BrowserWindow, viewManager: ViewManager, deps: RuntimeDeps = {}) {
    this.window = window;
    this.viewManager = viewManager;
    this.deps = deps;
    this.governor = deps.resourceGovernor ?? new ResourceGovernor({ checkIntervalMs: 2000 });
    this.governor.on('metrics', (m) => this.emitGovernanceMetrics(m));
    this.governor.on('throttle', () => {
      void this.viewManager.hibernateIdleTabs(this.governor);
    });
    viewManager.onTabCrashed = (tabId, reason) => this.handleTabCrash(tabId, reason);
  }

  public static initialize(window: BrowserWindow, viewManager: ViewManager, deps?: RuntimeDeps): AgentRuntime {
    if (!AgentRuntime.instance) {
      AgentRuntime.instance = new AgentRuntime(window, viewManager, deps);
    }
    return AgentRuntime.instance;
  }

  /** A runtime that is not the app singleton (tests run several against one window). */
  public static createDetached(window: BrowserWindow, viewManager: ViewManager, deps: RuntimeDeps = {}): AgentRuntime {
    return new AgentRuntime(window, viewManager, deps);
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

  /** True when no mission is live (never started, or the last one reached a terminal state). */
  public isIdle(): boolean {
    return !this.activeMission || isTerminal(this.activeMission.state);
  }

  /** The runtime-level state: `idle` between missions, otherwise the live mission's state. */
  public getState(): MissionState {
    return this.isIdle() ? 'idle' : this.activeMission!.state;
  }

  public getPendingQuestion(): MissionQuestionPayload | null {
    return this.pendingQuestion?.question ?? null;
  }

  private get strict(): boolean {
    return this.deps.strict ?? !app.isPackaged;
  }

  private userData(): string {
    return (this.deps.userDataDir ?? (() => getAppPaths().userData))();
  }

  /** Moves the live mission to `next` (see MissionStateMachine); one `mission:status` event per call that changes state. */
  private transition(next: MissionState, reason: string, message?: string): boolean {
    if (!this.machine) return false;
    this.pendingMessage = message;
    try {
      return this.machine.transition(next, reason);
    } finally {
      this.pendingMessage = undefined;
    }
  }

  private newMachine(mission: Mission): MissionStateMachine {
    return new MissionStateMachine({
      missionId: mission.id,
      strict: this.strict,
      onTransition: (ev: MissionStatusEvent) => {
        mission.state = ev.state;
        this.emitMissionStatus(ev, this.pendingMessage ?? ev.reason);
        this.persistCheckpoint(mission);
      },
      onIllegal: (from, to, reason) => logger.error('Illegal mission state transition ignored', undefined, { missionId: mission.id, from, to, reason })
    });
  }

  public async startMission(
    prompt: string,
    modelName?: string,
    brief?: MissionBrief,
    options?: { approvedPlan?: MissionDecompositionPlan; approvedMode?: 'single' | 'swarm' }
  ): Promise<{ ok: boolean; missionId?: string; error?: string; code?: 'MODEL_NOT_CONFIGURED' | 'MISSION_ACTIVE'; provider?: ModelProviderId }> {
    return this.launch(prompt, modelName, brief, { approvedPlan: options?.approvedPlan, approvedMode: options?.approvedMode });
  }

  private async launch(prompt: string, modelName: string | undefined, brief: MissionBrief | undefined, opts: LaunchOptions = {}): Promise<{ ok: boolean; missionId?: string; error?: string; code?: 'MODEL_NOT_CONFIGURED' | 'MISSION_ACTIVE'; provider?: ModelProviderId }> {
    // Single-mission rule (#226): a second start while one is live is refused with a typed code; the UI shows a toast.
    if (!this.isIdle()) {
      return {
        ok: false,
        code: 'MISSION_ACTIVE',
        error: 'A mission is already running. Cancel it or wait for it to finish before starting another.'
      };
    }

    const settings = getSettings();
    const targetModel = modelName || settings.modelName || 'gemini-2.0-flash';

    // Verify credential availability upfront (typed MODEL_NOT_CONFIGURED, #224)
    const modelCheck = (this.deps.inspect ?? ((m: string) => ModelProviderFactory.inspect(m)))(targetModel);
    if (!modelCheck.configured) {
      return { ok: false, error: modelCheck.message, code: 'MODEL_NOT_CONFIGURED', provider: modelCheck.provider };
    }

    const missionId = `m_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    let targetTab: TabView | undefined;
    try {
      if (opts.resume) {
        // Resume: re-open the last URL in a fresh agent tab; nothing from the earlier run is replayed.
        targetTab = this.viewManager.createTab(opts.resume.url || 'https://duckduckgo.com', false, `agent:${missionId}`);
      } else {
        targetTab = this.viewManager.getActiveTab();
        if (!targetTab) targetTab = this.viewManager.createTab('https://duckduckgo.com', false, `agent:${missionId}`);
      }
    } catch (err: any) {
      logger.error('Could not open a tab for the mission', err);
      return { ok: false, error: `Could not open a browser tab for the mission: ${err?.message ?? err}` };
    }

    this.abortController = new AbortController();
    this.isPaused = false;
    this.pausePromiseResolve = null;
    this.usageLedger.reset();
    this.ckptActions = opts.resume ? [...opts.resume.actions] : [];
    this.ckptNotes = opts.resume ? [...opts.resume.notes] : [];
    this.ckptResumedFrom = opts.resume?.missionId;

    const mission: Mission = {
      id: missionId,
      prompt,
      model: targetModel,
      state: 'idle',
      mode: opts.approvedMode,
      approvedPlan: opts.approvedPlan,
      approvedMode: opts.approvedMode,
      stepCount: 0,
      maxSteps: Math.min(brief?.maxSteps ?? settings.maxSteps, settings.maxSteps),
      history: [],
      tabId: targetTab.id,
      evidenceCollected: [],
      brief
    };
    this.activeMission = mission;
    this.machine = this.newMachine(mission);
    MissionRecorder.checkpoint(mission); // mission row must exist before its first event (FK)

    logger.info('Starting mission', { missionId, prompt, model: mission.model, tabId: targetTab.id, resumedFrom: opts.resume?.missionId });

    this.transition('planning', opts.resume ? 'mission_resumed' : 'mission_started', `Planning goal: "${prompt.slice(0, 50)}..."`);
    this.emitWorkerEvent({
      id: 'worker-agent-1',
      name: 'Agent [Planner]',
      task: `Analyzing goal: "${prompt.slice(0, 40)}"`,
      progress: 10,
      status: 'running'
    });
    this.emitEvidence(`[Mission ${missionId}] Initialized with goal: "${prompt}"`);

    void this.runGuarded(mission, opts.resume);

    return { ok: true, missionId };
  }

  public pause(reason = 'user_pause'): void {
    if (this.activeMission && this.activeMission.state === 'running') {
      this.isPaused = true;
      this.swarmGate.pause();
      this.transition('paused', reason, 'Mission paused by user');
      this.emitEvidence('[Agent] Execution paused');
      logger.info('Mission paused', { missionId: this.activeMission.id });
    }
  }

  public resume(): void {
    if (!this.activeMission || this.activeMission.state !== 'paused') return;
    if (this.pendingQuestion?.question.kind === 'crash') return; // the crash banner must be answered first
    this.isPaused = false;
    this.transition('running', 'user_resume', 'Mission resumed');
    this.wakePausedLoop();
    this.emitEvidence('[Agent] Execution resumed');
    logger.info('Mission resumed', { missionId: this.activeMission.id });
  }

  private wakePausedLoop(): void {
    if (this.pausePromiseResolve) {
      this.pausePromiseResolve();
      this.pausePromiseResolve = null;
    }
  }

  public takeover(): void {
    const m = this.activeMission;
    if (m && (m.state === 'running' || m.state === 'paused')) {
      this.isPaused = true;
      this.transition('takeover', 'user_takeover', 'Manual human takeover active');
      this.emitEvidence('[Manual Takeover] Human operator took manual control of the browser.');
    }
  }

  public async handBack(): Promise<void> {
    const mission = this.activeMission;
    if (mission && mission.state === 'takeover') {
      this.emitEvidence('[Hand Back] Human operator returned control to agent. Reconciling page state...');
      const tab = this.activeLoop?.tab || this.viewManager.getActiveTab();
      if (tab) {
        try {
          const snapshot = await PerceptionEngine.captureSnapshot(tab.view.webContents, false);
          mission.history.push({
            role: 'user',
            content: `[Operator Hand Back] The user completed manual interaction and returned control. Current page: ${snapshot.url} "${snapshot.title}"`
          });
        } catch (err: any) {
          logger.warn('Hand back: could not snapshot the page', { error: err?.message });
        }
      }
      if (this.activeMission !== mission || mission.state !== 'takeover') return; // cancelled while reconciling
      this.isPaused = false;
      this.transition('running', 'user_handback', 'Control handed back to the agent');
      this.wakePausedLoop();
    }
  }

  public cancel(): void {
    const mission = this.activeMission;
    if (!mission || isTerminal(mission.state)) return;
    logger.info('Cancelling mission', { missionId: mission.id });
    // Aborts the model HTTP request, the governor queue/backoff, page settles and the tool in flight (raceAbort in the loop).
    this.abortController?.abort();
    for (const abortWorker of this.workerAbortHandles.values()) {
      try { abortWorker('cancelled'); } catch {}
    }
    for (const gate of this.workerGates.values()) gate.resume();
    void this.activeSwarm?.shutdown();
    this.wakePausedLoop();
    if (this.pendingQuestion) {
      this.pendingQuestion.reject(new Error('Mission cancelled'));
      this.pendingQuestion = null;
    }
    this.finishMission('cancelled', undefined, 'Mission cancelled by user', 'user_cancel');
  }

  /**
   * Emergency Global Kill Switch (#231): stops any live mission/swarm, aborts all model calls and closes
   * agent-owned tabs within < 1 s. Emits `mission:status: cancelled` even if called between missions.
   */
  public killAll(reason = 'Global kill switch triggered'): void {
    logger.error('Global kill switch invoked on runtime', undefined, { reason });
    this.abortController?.abort();
    for (const abortWorker of this.workerAbortHandles.values()) {
      try { abortWorker('cancelled'); } catch {}
    }
    for (const gate of this.workerGates.values()) gate.resume();
    this.swarmGate.resume();
    void this.activeSwarm?.shutdown();
    this.wakePausedLoop();

    const mission = this.activeMission;
    if (mission && !isTerminal(mission.state)) {
      if (this.pendingQuestion) {
        this.pendingQuestion.reject(new Error('Mission killed'));
        this.pendingQuestion = null;
      }
      this.finishMission('cancelled', undefined, reason, 'kill_switch');
    } else {
      const payload: MissionStatusPayload = {
        missionId: mission?.id ?? 'kill_switch',
        status: 'cancelled',
        message: reason,
        reason: 'kill_switch',
        ts: Date.now()
      };
      this.events.emit('status', payload);
      try {
        if (!this.window.isDestroyed()) this.window.webContents.send(IPC_CHANNELS.EVENT_MISSION_STATUS, payload);
      } catch {}
    }

    this.viewManager.closeAgentTabs();
  }

  public getGovernanceMetrics(): GovernanceMetricsPayload {
    const m = this.governor.getMetrics();
    return {
      recommendedConcurrency: m.recommendedConcurrency,
      limitReason: m.limitReason,
      limitDescription: m.limitDescription,
      cpuPercent: m.cpuPercent,
      freeSystemMemMb: m.freeSystemMemMb,
      totalSystemMemMb: m.totalSystemMemMb,
      appWorkingSetMb: m.appWorkingSetMb,
      eventLoopLagMs: m.eventLoopLagMs,
      activeWebContentsCount: m.activeWebContentsCount,
      isThrottled: m.isThrottled,
      metricsAvailable: m.metricsAvailable
    };
  }

  public pauseWorker(workerId: string): WorkerControlResponse {
    if (workerId === 'worker-agent-1') {
      this.pause();
      const meta = this.workerMeta.get(workerId);
      this.emitWorkerEvent({
        ...(meta || { id: workerId, task: 'Paused by user', progress: 50 }),
        id: workerId,
        task: meta?.task ? `[Paused] ${meta.task}` : 'Paused by user',
        status: 'paused',
        at: Date.now()
      });
      return { ok: true, workerId, status: 'paused' };
    }
    const gate = this.workerGates.get(workerId);
    if (!gate) return { ok: false, workerId, error: 'Worker not active' };
    gate.pause();
    this.workerSupervisor?.pauseWorker(workerId);
    const meta = this.workerMeta.get(workerId);
    this.emitWorkerEvent({
      ...(meta || { id: workerId, workerId, task: 'Paused by user', progress: 50 }),
      id: workerId,
      workerId,
      task: meta?.task ? `[Paused] ${meta.task}` : 'Paused by user',
      status: 'paused',
      at: Date.now()
    });
    this.emitEvidence(`[Worker Control] Paused ${meta?.name ?? workerId}`);
    return { ok: true, workerId, status: 'paused' };
  }

  public resumeWorker(workerId: string): WorkerControlResponse {
    if (workerId === 'worker-agent-1') {
      this.resume();
      const meta = this.workerMeta.get(workerId);
      this.emitWorkerEvent({
        ...(meta || { id: workerId, task: 'Running', progress: 50 }),
        id: workerId,
        task: (meta?.task || 'Running').replace(/^\[(Paused|Takeover)\]\s*/i, ''),
        status: 'running',
        at: Date.now()
      });
      return { ok: true, workerId, status: 'running' };
    }
    const gate = this.workerGates.get(workerId);
    if (!gate) return { ok: false, workerId, error: 'Worker not active' };
    this.workerTakeoverIds.delete(workerId);
    gate.resume();
    this.workerSupervisor?.resumeWorker(workerId);
    const meta = this.workerMeta.get(workerId);
    this.emitWorkerEvent({
      ...(meta || { id: workerId, workerId, task: 'Resumed', progress: 50 }),
      id: workerId,
      workerId,
      task: (meta?.task || 'Running').replace(/^\[(Paused|Takeover)\]\s*/i, ''),
      status: 'running',
      at: Date.now()
    });
    this.emitEvidence(`[Worker Control] Resumed ${meta?.name ?? workerId}`);
    return { ok: true, workerId, status: 'running' };
  }

  public stopWorker(workerId: string): WorkerControlResponse {
    if (workerId === 'worker-agent-1') {
      this.cancel();
      return { ok: true, workerId, status: 'stopped' };
    }
    const abortFn = this.workerAbortHandles.get(workerId);
    if (!abortFn) return { ok: false, workerId, error: 'Worker not active' };
    this.stoppedWorkers.add(workerId);
    this.workerGates.get(workerId)?.resume();
    this.workerTakeoverIds.delete(workerId);
    abortFn('stopped');
    const meta = this.workerMeta.get(workerId);
    this.emitWorkerEvent({
      ...(meta || { id: workerId, workerId, task: 'Stopped by user', progress: 0 }),
      id: workerId,
      workerId,
      task: 'Stopped by user',
      status: 'stopped',
      at: Date.now()
    });
    this.emitEvidence(`[Worker Control] Stopped ${meta?.name ?? workerId}`);
    return { ok: true, workerId, status: 'stopped' };
  }

  public takeoverWorker(workerId: string): WorkerControlResponse {
    if (workerId === 'worker-agent-1') {
      const meta = this.workerMeta.get(workerId);
      if (this.activeMission?.state === 'takeover') {
        void this.handBack();
        this.emitWorkerEvent({
          ...(meta || { id: workerId, task: 'Running', progress: 50 }),
          id: workerId,
          task: (meta?.task || 'Running').replace(/^\[(Paused|Takeover)\]\s*/i, ''),
          status: 'running',
          at: Date.now()
        });
        return { ok: true, workerId, status: 'running' };
      }
      this.takeover();
      this.emitWorkerEvent({
        ...(meta || { id: workerId, task: 'Manual takeover', progress: 50 }),
        id: workerId,
        task: '[Takeover] Manual control',
        status: 'takeover',
        at: Date.now()
      });
      return { ok: true, workerId, status: 'takeover' };
    }
    const gate = this.workerGates.get(workerId);
    if (!gate) return { ok: false, workerId, error: 'Worker not active' };
    const meta = this.workerMeta.get(workerId);
    if (this.workerTakeoverIds.has(workerId)) {
      this.workerTakeoverIds.delete(workerId);
      gate.resume();
      this.workerSupervisor?.resumeWorker(workerId);
      this.emitWorkerEvent({
        ...(meta || { id: workerId, workerId, task: 'Handed back', progress: 50 }),
        id: workerId,
        workerId,
        task: (meta?.task || 'Running').replace(/^\[(Paused|Takeover)\]\s*/i, ''),
        status: 'running',
        at: Date.now()
      });
      this.emitEvidence(`[Worker Control] Handed back control to ${meta?.name ?? workerId}`);
      return { ok: true, workerId, status: 'running' };
    }
    this.workerTakeoverIds.add(workerId);
    gate.pause();
    this.workerSupervisor?.pauseWorker(workerId);
    this.viewManager.promote(workerId);
    this.emitWorkerEvent({
      ...(meta || { id: workerId, workerId, task: 'Manual takeover', progress: 50 }),
      id: workerId,
      workerId,
      task: '[Takeover] Manual control',
      status: 'takeover',
      at: Date.now()
    });
    this.emitEvidence(`[Worker Control] Manual takeover on ${meta?.name ?? workerId}`);
    return { ok: true, workerId, status: 'takeover' };
  }

  /** The user's answer to the open question (ask_user, approval, stuck escalation, crash banner). */
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

  // ------------------------------------------------------------------------------------------- tab crash (#226 step 5)
  private handleTabCrash(tabId: string, reason: string): void {
    const mission = this.activeMission;
    if (!mission || isTerminal(mission.state)) return;
    const missionTabId = this.activeLoop?.tab.id ?? mission.tabId;
    if (tabId !== missionTabId) return; // a tab the mission does not use
    logger.warn('The mission tab crashed', { missionId: mission.id, tabId, reason });
    this.emitEvidence(`[Tab Crashed] The page the agent was working on crashed (${reason}).`);
    if (mission.state !== 'running') {
      // Not mid-action (planning, a question is open, already paused): the next observation will see the dead page.
      return;
    }
    this.isPaused = true;
    this.transition('paused', 'tab_crashed', 'Page crashed: reload it or skip?');
    const question: MissionQuestionPayload = {
      missionId: mission.id,
      id: `crash${++this.crashSeq}`,
      text: `The page crashed (${reason}). Reload it and continue, or skip it?`,
      options: ['Reload page', 'Skip'],
      kind: 'crash'
    };
    this.pendingQuestion = {
      question,
      reject: () => {},
      resolve: (answer: string) => { void this.finishCrashQuestion(mission, tabId, answer); }
    };
    this.events.emit('question', question);
    try {
      if (!this.window.isDestroyed()) this.window.webContents.send(IPC_CHANNELS.EVENT_MISSION_QUESTION, question);
    } catch { /* window gone */ }
  }

  private async finishCrashQuestion(mission: Mission, tabId: string, answer: string): Promise<void> {
    if (this.activeMission !== mission || mission.state !== 'paused') return;
    const reload = /^reload/i.test(answer);
    const tab = this.viewManager.getTab(tabId);
    if (reload && tab) {
      this.emitEvidence('[Tab Crashed] Reloading the page');
      try {
        await new Promise<void>(resolve => {
          const t = setTimeout(resolve, 10000);
          tab.view.webContents.once('did-stop-loading', () => { clearTimeout(t); resolve(); });
          tab.view.webContents.reload();
        });
      } catch (err: any) {
        logger.warn('Reload after crash failed', { error: err?.message });
      }
      mission.history.push({ role: 'user', content: '[System Notice] The page crashed and the user had it reloaded. Re-read the page before acting; earlier element references are stale.' });
    } else {
      // Skip = abandon the dead page: the mission continues in a fresh blank agent tab (the crashed tab stays for the user to close).
      this.emitEvidence('[Tab Crashed] User chose to skip the crashed page; continuing in a new blank tab');
      const lastUrl = (() => { try { return readCheckpoint(this.userData(), mission.id)?.url; } catch { return undefined; } })();
      try {
        const fresh = this.viewManager.createTab('about:blank', false, `agent:${mission.id}`);
        try { await fresh.executor.ensureReady(); } catch { /* tools report their own errors */ }
        if (this.activeLoop) this.activeLoop.tab = fresh;
        mission.tabId = fresh.id;
      } catch (err: any) {
        logger.error('Could not open a replacement tab after the crash', err);
      }
      mission.history.push({ role: 'user', content: `[System Notice] The page crashed and the user chose to skip it. The mission continues in a new blank tab${lastUrl ? ` (the crashed page was ${lastUrl})` : ''}. Navigate again if you still need that page; earlier element references are stale.` });
    }
    if (this.activeMission !== mission || mission.state !== 'paused') return; // cancelled meanwhile
    this.isPaused = false;
    this.transition('running', reload ? 'crash_reload' : 'crash_skip', reload ? 'Page reloaded after crash' : 'Crashed page skipped');
    this.wakePausedLoop();
  }

  // ------------------------------------------------------------------------------------------- swarm
  private async runSwarmLoop(mission: Mission, plan: MissionDecompositionPlan, getOrchestratorProvider: () => Promise<IModelProvider>): Promise<void> {
    const settings = getSettings();
    const maxWorkers = clampMaxWorkers(settings.maxWorkers);
    const signal = this.abortController!.signal;
    // One manager per mission: its workers get `agent-<missionId>-<workerId>` in-memory partitions and their own
    // views (shown in the Grid by ViewManager, #232); they are all torn down in the finally below (also when the
    // window closes or the mission is cancelled). The user's tabs are never used.
    const stallMs =
      this.deps.stallThresholdMs ??
      (Number(process.env.AEGIS_WORKER_STALL_MS) > 0 ? Number(process.env.AEGIS_WORKER_STALL_MS) : DEFAULT_STALL_THRESHOLD_MS);
    const checkMs = Math.min(1000, Math.max(100, Math.floor(stallMs / 4)));
    const swarm = new SwarmManager({ maxWorkers, missionId: mission.id, parentWindow: this.window });
    this.activeSwarm = swarm;
    const supervisor = new WorkerSupervisor({ checkIntervalMs: checkMs, stallThresholdMs: stallMs });
    this.workerSupervisor = supervisor;
    this.workerGates.clear();
    this.workerAbortHandles.clear();
    this.stoppedWorkers.clear();
    this.workerTakeoverIds.clear();
    const coordinator = new SwarmCoordinator({
      swarm,
      blackboard: new SharedBlackboard({ missionId: mission.id }),
      governor: this.governor,
      supervisor,
      maxWorkers
    });
    const abortHandles = this.workerAbortHandles;
    this.swarmGate = new PauseGate();
    this.swarmQuestions = new QuestionQueue();

    coordinator.on('stageStarted', (ev: any) => {
      this.emitEvidence(`[Swarm Stage Started] ${ev.stageName} (${ev.taskCount} tasks)`);
    });
    coordinator.on('governanceMetrics', (m: any) => {
      this.emitGovernanceMetrics(m);
    });
    coordinator.on('planUpdated', (ev: any) => {
      this.emitEvidence(`[Replan ${ev.attempt}] ${ev.justification} (${(ev.diff || []).join(' | ')})`);
    });

    // The coordinator's own verifier/summariser tasks have no view: they are log lines, not a worker in the Grid.
    const workerEvent = (ev: any, task: string, status: WorkerEventPayload['status'], progress: number) => ev.workerId === 'coordinator' ? this.emitEvidence(`[Swarm] ${task}`) : this.emitWorkerEvent({
      id: ev.workerId, workerId: ev.workerId, name: ev.identity?.name, color: ev.identity?.color, glyph: ev.identity?.glyph,
      task, progress, status, at: Date.now()
    });
    coordinator.on('taskStarted', (ev: any) => {
      if (ev.workerId !== 'coordinator' && !this.workerGates.has(ev.workerId)) {
        this.workerGates.set(ev.workerId, new PauseGate());
      }
      workerEvent(ev, `Starting: ${ev.name ?? ev.taskId}`, 'running', 5);
      if (ev.workerId !== 'coordinator') {
        this.ensureEventLog(mission.id).emit('step_started', {
          name: ev.identity?.name ?? ev.workerId,
          color: ev.identity?.color,
          glyph: ev.identity?.glyph,
          task: ev.name ?? ev.taskId
        }, { workerId: ev.workerId, stepId: ev.taskId });
      }
    });
    coordinator.on('taskRetry', (ev: any) => workerEvent(ev, `Retrying after: ${String(ev.error).slice(0, 80)}`, 'running', 5));
    coordinator.on('taskFailed', (ev: any) => {
      if (signal.aborted) return; // cancelled: the shutdown rejects in-flight tasks; that is not a task failure
      const isStalled = this.workerSupervisor?.getTelemetry(ev.workerId)?.status === 'stalled' || /stalled/i.test(String(ev.error));
      workerEvent(
        ev,
        `${ev.stoppedByUser ? 'Stopped' : isStalled ? 'Stalled' : 'Failed'}: ${String(ev.error).slice(0, 80)}`,
        ev.stoppedByUser ? 'stopped' : isStalled ? 'stalled' : 'failed',
        100
      );
    });
    coordinator.on('taskNeedsHuman', (ev: any) => this.emitEvidence(`[Needs You] ${ev.identity?.name ?? ev.workerId}: ${String(ev.reason).slice(0, 160)}`));
    coordinator.on('workerStalled', (ev: any) => {
      this.emitEvidence(`[Supervisor] ${ev.workerId} stalled (${ev.stallClass}; ${ev.final ? 'stalled cleanly' : 'aborting and retrying once'})`);
      if (ev.final) {
        const meta = this.workerMeta.get(ev.workerId);
        this.emitWorkerEvent({
          ...(meta || { id: ev.workerId, workerId: ev.workerId, progress: 0 }),
          id: ev.workerId,
          workerId: ev.workerId,
          task: `Stalled (${ev.stallClass})`,
          status: 'stalled',
          at: Date.now()
        });
      }
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
      const provider = governed(await (this.deps.createProvider ?? ((m: string) => ModelProviderFactory.createProvider(m)))(mission.model));
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
        workerGates: this.workerGates,
        stoppedWorkers: this.stoppedWorkers,
        waitWhilePaused: () => this.swarmGate.wait(signal),
        askUser: q => questions.ask(() => this.askUser(mission, q), signal),
        emitWorker: p => this.emitWorkerEvent(p),
        emitEvidence: t => this.emitEvidence(t),
        recordEvent: (kind, data) => {
          const d = (data && typeof data === 'object') ? data as Record<string, any> : { value: data };
          const rawWorkerId = typeof d.workerId === 'string' ? d.workerId : undefined;
          const rawStepId = typeof d.taskId === 'string' ? d.taskId : undefined;
          const inner = (d.data && typeof d.data === 'object') ? d.data as Record<string, any> : d;
          const mappedKind = kind.startsWith('worker.') ? kind.slice('worker.'.length) : kind;
          const meta = rawWorkerId ? this.workerMeta.get(rawWorkerId) : undefined;
          const payload = meta ? { ...inner, workerName: meta.name, color: meta.color, glyph: meta.glyph } : inner;
          this.ensureEventLog(mission.id).emit(mappedKind, payload, { workerId: rawWorkerId, stepId: rawStepId });
        }
      };
      result = await coordinator.executeMission(
        mission.id,
        mission.prompt,
        (worker, task) => runWorkerTask(worker, task, runDeps),
        {
          plan,
          inlineExecutorFn: task => runNonBrowserTask(task, runDeps),
          signal,
          replanFn: async (_currentPlan, failureSummary) => {
            const next = await planWithOrchestrator({
              provider: await getOrchestratorProvider(),
              missionId: mission.id,
              goal: mission.prompt,
              model: mission.model,
              maxWorkers,
              brief: mission.brief,
              forceSwarm: true,
              failureSummary,
              signal
            });
            return next.plan;
          }
        }
      );
    } catch (err) {
      // Cancelling shuts the swarm down underneath the coordinator ("Swarm is shut down"): expected, not a failure.
      if (signal.aborted) {
        logger.info('Swarm mission stopped by cancel', { missionId: mission.id });
        return;
      }
      throw err;
    } finally {
      this.activeSwarm = null;
      this.workerSupervisor = null;
      this.workerGates.clear();
      this.workerAbortHandles.clear();
      this.stoppedWorkers.clear();
      this.workerTakeoverIds.clear();
      await swarm.shutdown();
    }
    if (signal.aborted || this.activeMission !== mission || isTerminal(mission.state)) return; // cancelled while the swarm was unwinding
    if (result.success) {
      this.finishMission('completed', result.deliverableMarkdown, undefined, 'swarm_done');
    } else {
      this.finishMission('failed', undefined, result.errors.join('; ') || 'No worker finished its task', 'swarm_failed');
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
      const dir = path.join(this.userData(), 'missions', missionId, 'files');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      return undefined;
    }
  }

  /**
   * Top-level guard (#226 step 4): whatever the loop throws becomes a `failed` mission with a message the user can
   * read and a log entry; it never becomes an unhandled rejection and never takes the main process down.
   */
  private async runGuarded(mission: Mission, resume?: MissionCheckpoint): Promise<void> {
    try {
      await this.runLoop(mission, resume);
    } catch (err: any) {
      const raw = String(err?.message ?? err);
      logger.error('Mission loop crashed', err instanceof Error ? err : undefined, { missionId: mission.id, error: raw });
      MissionRecorder.event(mission.id, 'error', { message: raw, stack: err?.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : undefined });
      if (this.activeMission === mission && !isTerminal(mission.state)) {
        this.finishMission('failed', undefined, `The mission stopped because of an internal error: ${raw.slice(0, 300)}`, 'loop_error');
      }
    }
  }

  private async runLoop(mission: Mission, resume?: MissionCheckpoint): Promise<void> {
    if (this.activeMission !== mission) return;
    // Captured before any await: a cancel during setup followed by a new mission replaces this.abortController, and this
    // (cancelled) run must keep seeing ITS OWN aborted signal, not the new mission's live one.
    const signal = this.abortController!.signal;
    this.transition('running', 'loop_started', 'Mission running');

    const settings = getSettings();
    const maxWorkers = clampMaxWorkers(settings.maxWorkers);
    // Only explicit `/swarm` is preserved as a user override; regex routing and hardcoded keyword heuristics are removed (#228).
    const forceSwarm = mission.prompt.trim().startsWith('/swarm');
    const createOrch = this.deps.createOrchestratorProvider ?? ((m: string, o?: string) => ModelProviderFactory.createOrchestratorProvider(m, o));
    let cachedOrch: IModelProvider | undefined;
    const getOrch = async (): Promise<IModelProvider> => {
      if (!cachedOrch) cachedOrch = governed(await createOrch(mission.model));
      return cachedOrch;
    };

    let chosenMode: 'single' | 'swarm' = 'single';
    let chosenPlan: MissionDecompositionPlan | undefined = mission.approvedPlan;
    if (!resume) {
      if (chosenPlan) {
        chosenMode = forceSwarm ? 'swarm' : (mission.approvedMode ?? 'single');
        mission.mode = chosenMode;
        this.emitEvidence(`[Orchestrator Plan] Mode=${chosenMode} (approved preview): ${chosenPlan.justification}`);
      } else {
        const decision = await planWithOrchestrator({
          provider: await getOrch(),
          missionId: mission.id,
          goal: mission.prompt,
          model: mission.model,
          maxWorkers,
          brief: mission.brief,
          forceSwarm,
          signal
        });
        if (signal.aborted || this.activeMission !== mission) return;
        chosenMode = decision.mode;
        chosenPlan = decision.plan;
        mission.mode = chosenMode;
        this.emitEvidence(`[Orchestrator Plan] Mode=${chosenMode} (${decision.plan.stages.length} stage(s)): ${decision.justification}`);
        MissionRecorder.event(mission.id, 'orchestrator.plan', {
          mode: chosenMode,
          justification: decision.justification,
          stages: decision.plan.stages
        });
      }
    }

    if (chosenMode === 'swarm' && chosenPlan) {
      await this.runSwarmLoop(mission, chosenPlan, getOrch);
      return;
    }

    const tab: TabView | undefined = this.viewManager.getTab(mission.tabId || '') || this.viewManager.getActiveTab();
    if (!tab) {
      throw new Error('No active browser tab found to operate on');
    }
    try {
      await tab.executor.ensureReady();
    } catch { /* CDP unavailable: tools report their own errors */ }

    const provider = governed(await (this.deps.createProvider ?? ((m: string) => ModelProviderFactory.createProvider(m)))(mission.model));
    const verifier = governed(await (this.deps.createVerifierProvider ?? ((m: string, v?: string) => ModelProviderFactory.createVerifierProvider(m, v)))(mission.model, settings.verifierModel));
    if (signal.aborted || this.activeMission !== mission) return; // cancelled while the provider was being created
    const live = () => this.activeMission === mission && !isTerminal(mission.state);

    const effectiveGoal = chosenPlan?.stages?.[0]?.tasks?.[0]?.instruction || mission.prompt;
    const loop = new AgentLoop({
      missionId: mission.id,
      goal: effectiveGoal,
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
      resumeNote: resume ? buildResumeNote(resume) : undefined,
      stepDelayMs: this.deps.stepDelayMs,
      settleMaxMs: this.deps.settleMaxMs,
      drainSteering: () => this.steeringQueue.drain().map(s => `${s.type}: ${s.text}`),
      waitWhilePaused: async () => {
        while (this.isPaused && !signal.aborted) {
          await new Promise<void>(resolve => { this.pausePromiseResolve = resolve; });
        }
      },
      askUser: q => this.askUser(mission, q),
      emit: {
        evidence: t => {
          if (!live()) return;
          const m = /^\[Agent Thought\] (.*)$/.exec(t);
          if (m) { this.ckptNotes.push(m[1].slice(0, 160)); if (this.ckptNotes.length > 5) this.ckptNotes.shift(); }
          this.emitEvidence(t);
        },
        status: (s, m) => {
          if (!live()) return;
          this.transition(s, s === 'running' ? 'question_answered' : 'question_asked', m);
        },
        telemetry: p => { if (live()) this.emitTelemetry(p); },
        worker: p => { if (live()) this.emitWorkerEvent({ id: 'worker-agent-1', name: 'Agent [Operator]', task: p.task, progress: p.progress, status: 'running' }); },
        event: (kind, data) => {
          const d = (data && typeof data === 'object') ? data as Record<string, any> : { value: data };
          this.ensureEventLog(mission.id).emit(kind, d, { workerId: 'worker-agent-1', stepId: typeof d.step === 'number' ? `step_${d.step}` : undefined });
        },
        toolPhase: a => {
          if (!live()) return;
          const url = (() => { try { return loop.tab.view.webContents.getURL(); } catch { return undefined; } })();
          if (a.phase === 'start') {
            this.ckptActions.push({ step: a.step, tool: a.tool, summary: summarizeAction(a.tool, a.args, a.label), sideEffect: SIDE_EFFECT_TOOLS.has(a.tool), phase: 'in_flight', url });
          } else {
            const open = [...this.ckptActions].reverse().find(x => x.step === a.step && x.tool === a.tool && x.phase === 'in_flight');
            if (open) { open.phase = 'done'; open.ok = a.ok; }
          }
          mission.stepCount = loop.stepCount;
          this.persistCheckpoint(mission, loop);
        },
        checkpoint: () => {
          if (!live()) return;
          mission.stepCount = loop.stepCount;
          mission.tabId = loop.tab.id;
          MissionRecorder.checkpoint(mission);
          this.persistCheckpoint(mission, loop);
        }
      }
    });
    this.activeLoop = loop;
    mission.maxSteps = loop.getMaxSteps();

    let outcome: LoopOutcome;
    try {
      outcome = await loop.run();
    } finally {
      if (this.activeLoop === loop) this.activeLoop = null;
    }
    if (!live()) return; // cancelled while the loop was finishing
    mission.stepCount = loop.stepCount;
    for (const e of outcome.evidence) if (!mission.evidenceCollected.includes(e)) mission.evidenceCollected.push(e);
    mission.verification = outcome.verification;
    this.finishMission(outcome.state, outcome.result, outcome.error, 'loop_finished');
  }

  private askUser(mission: Mission, q: UserQuestion): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const payload: MissionQuestionPayload = { missionId: mission.id, id: q.id, text: q.text, options: q.options, kind: q.kind };
      this.pendingQuestion = { question: payload, resolve, reject };
      this.events.emit('question', payload);
      try {
        if (!this.window.isDestroyed()) this.window.webContents.send(IPC_CHANNELS.EVENT_MISSION_QUESTION, payload);
      } catch { /* window gone; the mission can still be cancelled */ }
    });
  }

  // ------------------------------------------------------------------------------------------- checkpoint & resume (#226 step 6)
  /** Best effort: a full disk or a locked file must never stop the mission. Written under the app data dir, not the cwd. */
  private persistCheckpoint(mission: Mission, loop?: AgentLoop): void {
    if (mission.mode === 'swarm' || mission.prompt.trim().startsWith('/swarm')) return; // a swarm has no resumable single-tab state
    try {
      const l = loop ?? this.activeLoop;
      let url: string | undefined;
      let title: string | undefined;
      try {
        const wc = (l?.tab ?? this.viewManager.getTab(mission.tabId || ''))?.view.webContents;
        url = wc?.getURL() || undefined;
        title = wc?.getTitle() || undefined;
      } catch { /* the tab is gone */ }
      const prev = readCheckpoint(this.userData(), mission.id);
      writeCheckpoint(this.userData(), {
        version: 1,
        missionId: mission.id,
        prompt: mission.prompt,
        model: mission.model,
        state: mission.state,
        stepCount: mission.stepCount,
        url: url && /^https?:/i.test(url) ? url : prev?.url,
        title,
        savedAt: Date.now(),
        actions: this.ckptActions,
        notes: this.ckptNotes,
        brief: mission.brief,
        resumedFrom: this.ckptResumedFrom
      });
      this.lastCheckpointError = null;
    } catch (err: any) {
      this.lastCheckpointError = String(err?.message ?? err);
      logger.warn('Could not write the mission checkpoint', { error: this.lastCheckpointError });
    }
  }

  /** The newest mission a previous run left unfinished, for the "Resume interrupted mission" banner. */
  public getInterruptedMission(): InterruptedMission | null {
    let list: MissionCheckpoint[] = [];
    try { list = listInterrupted(this.userData(), { exclude: this.activeMission?.id }); } catch { return null; }
    const cp = list[0];
    if (!cp) return null;
    const unknown = cp.actions.find(a => a.phase === 'in_flight' && a.sideEffect);
    return {
      missionId: cp.missionId,
      prompt: cp.prompt,
      url: cp.url,
      stepCount: cp.stepCount,
      savedAt: cp.savedAt,
      performed: cp.actions.filter(a => a.sideEffect && a.phase === 'done' && a.ok !== false).map(a => `step ${a.step}: ${a.summary}`),
      unknownOutcome: unknown ? `step ${unknown.step}: ${unknown.summary}` : undefined
    };
  }

  public discardInterrupted(missionId: string): void {
    removeCheckpoint(this.userData(), missionId);
  }

  public async resumeInterrupted(missionId: string): ReturnType<AgentRuntime['launch']> {
    const cp = readCheckpoint(this.userData(), missionId);
    if (!cp) return { ok: false, error: 'There is no resumable checkpoint for that mission (it may have been resumed or discarded already).' };
    if (!this.isIdle()) return { ok: false, code: 'MISSION_ACTIVE', error: 'A mission is already running.' };
    const r = await this.launch(cp.prompt, cp.model, cp.brief as MissionBrief | undefined, { resume: cp });
    if (r.ok) removeCheckpoint(this.userData(), missionId); // consumed: it is offered once
    return r;
  }

  private saveDeliverableReport(mission: Mission): void {
    try {
      const deliverablesDir = path.join(this.userData(), 'deliverables');
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

  private finishMission(state: MissionState, result: string | undefined, error: string | undefined, reason: string): void {
    const mission = this.activeMission;
    if (!mission || !this.machine) return;
    if (isTerminal(mission.state)) return; // already finished (e.g. cancelled while the loop unwound)
    mission.result = result;
    mission.error = error;
    this.isPaused = false;
    this.wakePausedLoop();
    if (this.pendingQuestion) {
      this.pendingQuestion.reject(new Error('Mission ended'));
      this.pendingQuestion = null;
    }
    // A pause/takeover/question that raced with the loop's last step: the mission was effectively running again.
    if (state !== 'cancelled' && state !== 'failed' && mission.state !== 'running') this.transition('running', 'loop_finished');

    const v = mission.verification;
    logger.info('Mission finished', { state, result, error, verifier: v?.verdict });
    if (v) MissionRecorder.event(mission.id, 'mission.verification', v);

    const verdictText = v ? ` (verifier: ${v.verdict})` : '';
    const statusText = state === 'completed'
      ? `Mission succeeded${verdictText}: ${result?.slice(0, 100) || 'Complete'}`
      : state === 'completed_unverified'
        ? `Mission finished UNVERIFIED${verdictText}: ${result?.slice(0, 100) || ''}${v?.reasons.length ? ` | checker: ${v.reasons.join('; ').slice(0, 120)}` : ''}`
        : `Mission ${state}: ${error || 'Ended'}`;

    this.transition(state, reason, statusText); // emits the terminal mission:status event and writes the final checkpoint

    // Native OS Notification (Issue #146: Background awareness)
    try {
      const { Notification } = require('electron');
      if (Notification && Notification.isSupported && Notification.isSupported()) {
        new Notification({
          title: `Aegis Mission ${state === 'completed' ? 'Completed' : 'Finished'}`,
          body: `Status: ${state} - "${mission.prompt.slice(0, 50)}"`
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

    MissionRecorder.checkpoint(mission);
    if (ok) {
      this.saveDeliverableReport(mission);
    }
  }

  private emitMissionStatus(ev: MissionStatusEvent, message: string): void {
    const payload: MissionStatusPayload = {
      missionId: ev.missionId,
      status: ev.state,
      message,
      reason: ev.reason,
      ts: ev.ts,
      seq: ev.seq
    };
    this.events.emit('status', payload);
    try {
      if (this.activeMission) MissionRecorder.checkpoint(this.activeMission);
      MissionRecorder.event(ev.missionId, 'status', payload);
      if (!this.window.isDestroyed()) this.window.webContents.send(IPC_CHANNELS.EVENT_MISSION_STATUS, payload);
    } catch {}
  }

  private emitWorkerEvent(payload: WorkerEventPayload): void {
    try {
      this.workerMeta.set(payload.id, payload);
      if (!this.window.isDestroyed()) {
        MissionRecorder.event(this.activeMission?.id, 'worker', payload);
        this.window.webContents.send(IPC_CHANNELS.EVENT_WORKER, payload);
      }
    } catch {}
  }

  private emitGovernanceMetrics(metrics: any): void {
    const payload: GovernanceMetricsPayload = {
      recommendedConcurrency: metrics.recommendedConcurrency,
      limitReason: metrics.limitReason ?? null,
      limitDescription: metrics.limitDescription ?? null,
      cpuPercent: metrics.cpuPercent,
      freeSystemMemMb: metrics.freeSystemMemMb,
      totalSystemMemMb: metrics.totalSystemMemMb,
      appWorkingSetMb: metrics.appWorkingSetMb,
      eventLoopLagMs: metrics.eventLoopLagMs,
      activeWebContentsCount: metrics.activeWebContentsCount,
      isThrottled: Boolean(metrics.isThrottled),
      metricsAvailable: metrics.metricsAvailable !== false
    };
    this.events.emit('governance', payload);
    try {
      if (!this.window.isDestroyed()) {
        this.window.webContents.send(IPC_CHANNELS.EVENT_GOVERNANCE, payload);
      }
    } catch {}
  }

  private activeEventLog: EventLog | null = null;

  private ensureEventLog(missionId: string): EventLog {
    if (!this.activeEventLog || (this.activeEventLog as any).missionId !== missionId) {
      this.activeEventLog = new EventLog(missionId, {
        privacyMode: getSettings().privacyMode,
        persist: ev => MissionRecorder.event(ev.missionId, ev.kind, {
          ...ev.data,
          ...(ev.workerId ? { workerId: ev.workerId } : {}),
          ...(ev.stepId ? { stepId: ev.stepId } : {})
        }),
        forward: ev => {
          if (!this.window.isDestroyed()) {
            this.window.webContents.send(IPC_CHANNELS.EVENT_MISSION_EVENT, ev);
          }
        }
      });
    }
    return this.activeEventLog;
  }

  private emitEvidence(text: string): void {
    try {
      const payload: EvidenceEventPayload = {
        text,
        timestamp: new Date().toTimeString().slice(0, 8)
      };
      this.events.emit('evidence', payload);
      if (!this.window.isDestroyed()) {
        this.window.webContents.send(IPC_CHANNELS.EVENT_EVIDENCE, payload);
      }
      if (this.activeMission?.id) {
        const lower = text.toLowerCase();
        const kind = lower.includes('[blackboard evidence]') || lower.includes('[evidence]')
          ? 'evidence'
          : lower.includes('[blackboard conflict')
            ? 'conflict'
            : lower.includes('[error') || lower.includes('[roadblock')
              ? 'error'
              : lower.includes('[thought')
                ? 'thought'
                : 'status';
        this.ensureEventLog(this.activeMission.id).emit(kind, { text });
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
