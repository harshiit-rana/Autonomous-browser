/**
 * Project Aegis - Mission Control & Chrome UX Controller
 * Implements: Issues #134, #135, #136, #137, #138, #139, #140, #141, #142, #143, #211, #214
 */

import { OmnibarParser } from '../ui/omnibar_parser.js';
import { HistoryPanel } from './history_panel.js';
import { SwarmGrid } from './swarm_grid.js';
import {
  TabState,
  TabsSnapshot,
  TabPatch,
  WorkerEventPayload,
  EvidenceEventPayload,
  GridSourcesPayload,
  MissionStatusPayload,
  MissionQuestionPayload,
  MODEL_NOT_CONFIGURED,
  MISSION_ACTIVE
} from '../ipc/contract.js';

function sanitizeText(str: string): string {
  if (!str) return '';
  return str.replace(/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E]/g, '').trim();
}

type TimelineCategory = 'all' | 'actions' | 'thoughts' | 'evidence' | 'errors';

export class BrowserApp {
  // Omnibar & Navigation
  private omnibarInput: HTMLInputElement;
  private swarmRunBtn: HTMLButtonElement;
  private drawerToggleBtn: HTMLButtonElement;
  private swarmDrawer: HTMLElement;
  private tabsContainer: HTMLElement;
  private newTabBtn: HTMLButtonElement;
  private modelSelect: HTMLSelectElement;

  // Real Controls (Issue #139, #231)
  private pauseBtn: HTMLButtonElement;
  private takeoverBtn: HTMLButtonElement;
  private undoBtn: HTMLButtonElement;
  private cancelMissionBtn: HTMLButtonElement;
  private killSwitchBtn: HTMLButtonElement;

  // Layout Switcher (Issue #138)
  private layoutStageBtn: HTMLButtonElement;
  private layoutGridBtn: HTMLButtonElement;
  private layoutTheatreBtn: HTMLButtonElement;
  private currentLayout: 'stage' | 'grid' | 'theatre' = 'stage';

  // Draggable Pane Resizer (Issue #138)
  private paneResizer: HTMLElement;
  private isResizing = false;
  private drawerWidth = 340;

  // Swarm Grid & Presence Overlay (Issues #135, #136)
  private swarmGridContainer: HTMLElement;
  private swarmGrid: SwarmGrid;

  // Live Timeline & Steering (Issues #137, #211)
  private evidenceFeed: HTMLElement;
  private steeringInput: HTMLInputElement;
  private steeringSendBtn: HTMLButtonElement;
  private currentFilter: TimelineCategory = 'all';

  // Telemetry Stats (Issue #141)
  private workerCardsContainer: HTMLElement;
  private workerCountStat: HTMLElement;
  private tokensStat: HTMLElement;
  private costStat: HTMLElement;

  // Plan Preview Modal (Issues #140, #228)
  private planPreviewModal: HTMLElement;
  private planGoalText: HTMLElement;
  private planModeBadge: HTMLElement;
  private planJustificationText: HTMLElement;
  private switchSinglePlanBtn: HTMLButtonElement;
  private planStepsContainer: HTMLElement;
  private planEstDuration: HTMLElement;
  private planEstCost: HTMLElement;
  private closePlanBtn: HTMLButtonElement;
  private cancelPlanBtn: HTMLButtonElement;
  private executePlanBtn: HTMLButtonElement;
  private pendingPlanPrompt: string | null = null;
  private pendingPreviewPlan: any | null = null;

  // Settings Modal (Issues #129, #133)
  private settingsBtn: HTMLButtonElement;
  private settingsModal: HTMLElement;
  private closeSettingsBtn: HTMLButtonElement;
  private cancelSettingsBtn: HTMLButtonElement;
  private saveSettingsBtn: HTMLButtonElement;
  private settingsProvider: HTMLSelectElement;
  private settingsGeminiKey: HTMLInputElement;
  private settingsAnthropicKey: HTMLInputElement;
  private settingsOpenaiKey: HTMLInputElement;
  private settingsOllamaUrl: HTMLInputElement;
  private settingsSkipLowRiskPreview: HTMLInputElement;
  private settingsNotice: HTMLElement;
  private demoBanner: HTMLElement;
  private groupGeminiKey: HTMLElement;
  private groupAnthropicKey: HTMLElement;
  private groupOpenaiKey: HTMLElement;
  private groupOllamaUrl: HTMLElement;
  private settingsStatusMsg: HTMLElement;

  // State
  private isPaused = false;
  private isTakeover = false;
  private currentTabs: TabState[] = [];
  private activeTabId: string | null = null;
  private activeWorkers: Map<string, WorkerEventPayload> = new Map();
  private governanceLimitDesc: string | null = null;

  constructor() {
    this.omnibarInput = document.getElementById('omnibar-input') as HTMLInputElement;
    this.swarmRunBtn = document.getElementById('swarm-run-btn') as HTMLButtonElement;
    this.drawerToggleBtn = document.getElementById('toggle-drawer-btn') as HTMLButtonElement;
    this.swarmDrawer = document.getElementById('swarm-drawer') as HTMLElement;
    this.tabsContainer = document.getElementById('tabs-container') as HTMLElement;
    this.newTabBtn = document.getElementById('new-tab-btn') as HTMLButtonElement;
    this.modelSelect = document.getElementById('model-select') as HTMLSelectElement;

    // Controls
    this.pauseBtn = document.getElementById('pause-agent-btn') as HTMLButtonElement;
    this.takeoverBtn = document.getElementById('takeover-btn') as HTMLButtonElement;
    this.undoBtn = document.getElementById('undo-btn') as HTMLButtonElement;
    this.cancelMissionBtn = document.getElementById('cancel-mission-btn') as HTMLButtonElement;
    this.killSwitchBtn = document.getElementById('kill-switch-btn') as HTMLButtonElement;

    // Layout
    this.layoutStageBtn = document.getElementById('layout-stage-btn') as HTMLButtonElement;
    this.layoutGridBtn = document.getElementById('layout-grid-btn') as HTMLButtonElement;
    this.layoutTheatreBtn = document.getElementById('layout-theatre-btn') as HTMLButtonElement;
    this.paneResizer = document.getElementById('pane-resizer') as HTMLElement;
    this.swarmGridContainer = document.getElementById('swarm-grid-container') as HTMLElement;

    // Timeline & Steering
    this.evidenceFeed = document.getElementById('evidence-feed') as HTMLElement;
    this.steeringInput = document.getElementById('steering-input') as HTMLInputElement;
    this.steeringSendBtn = document.getElementById('steering-send-btn') as HTMLButtonElement;

    // Telemetry
    this.workerCardsContainer = document.getElementById('worker-cards-container') as HTMLElement;
    this.workerCountStat = document.getElementById('worker-count-stat') as HTMLElement;
    this.tokensStat = document.getElementById('tokens-stat') as HTMLElement;
    this.costStat = document.getElementById('cost-stat') as HTMLElement;

    // Plan Preview
    this.planPreviewModal = document.getElementById('plan-preview-modal') as HTMLElement;
    this.planGoalText = document.getElementById('plan-goal-text') as HTMLElement;
    this.planModeBadge = document.getElementById('plan-mode-badge') as HTMLElement;
    this.planJustificationText = document.getElementById('plan-justification-text') as HTMLElement;
    this.switchSinglePlanBtn = document.getElementById('switch-single-plan-btn') as HTMLButtonElement;
    this.planStepsContainer = document.getElementById('plan-steps-container') as HTMLElement;
    this.planEstDuration = document.getElementById('plan-est-duration') as HTMLElement;
    this.planEstCost = document.getElementById('plan-est-cost') as HTMLElement;
    this.closePlanBtn = document.getElementById('close-plan-btn') as HTMLButtonElement;
    this.cancelPlanBtn = document.getElementById('cancel-plan-btn') as HTMLButtonElement;
    this.executePlanBtn = document.getElementById('execute-plan-btn') as HTMLButtonElement;

    // Settings
    this.settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;
    this.settingsModal = document.getElementById('settings-modal') as HTMLElement;
    this.closeSettingsBtn = document.getElementById('close-settings-btn') as HTMLButtonElement;
    this.cancelSettingsBtn = document.getElementById('cancel-settings-btn') as HTMLButtonElement;
    this.saveSettingsBtn = document.getElementById('save-settings-btn') as HTMLButtonElement;
    this.settingsProvider = document.getElementById('settings-provider') as HTMLSelectElement;
    this.settingsGeminiKey = document.getElementById('settings-gemini-key') as HTMLInputElement;
    this.settingsAnthropicKey = document.getElementById('settings-anthropic-key') as HTMLInputElement;
    this.settingsOpenaiKey = document.getElementById('settings-openai-key') as HTMLInputElement;
    this.settingsOllamaUrl = document.getElementById('settings-ollama-url') as HTMLInputElement;
    this.settingsSkipLowRiskPreview = document.getElementById('settings-skip-low-risk-preview') as HTMLInputElement;
    this.settingsNotice = document.getElementById('settings-notice') as HTMLElement;
    this.demoBanner = document.getElementById('demo-banner') as HTMLElement;
    this.groupGeminiKey = document.getElementById('group-gemini-key') as HTMLElement;
    this.groupAnthropicKey = document.getElementById('group-anthropic-key') as HTMLElement;
    this.groupOpenaiKey = document.getElementById('group-openai-key') as HTMLElement;
    this.groupOllamaUrl = document.getElementById('group-ollama-url') as HTMLElement;
    this.settingsStatusMsg = document.getElementById('settings-status-msg') as HTMLElement;

    // Live Swarm Grid (#232). The frames port is handed over by the preload with window.postMessage.
    this.swarmGrid = new SwarmGrid(this.swarmGridContainer, (window as any).aegis || {}, {
      testMode: false,
      onPromote: () => this.setLayout('stage')
    });
    window.addEventListener('message', (ev: MessageEvent) => {
      if (ev.source === window && ev.data?.type === 'aegis:frames-port' && ev.ports?.[0]) this.swarmGrid.attachPort(ev.ports[0]);
    });

    this.bindEvents();
    this.bindLayoutEvents();
    this.bindControls();
    this.bindSettingsEvents();
    new HistoryPanel();
    this.registerBridgeListeners();

    // Initial snapshot request
    const aegis = (window as any).aegis;
    if (aegis?.requestTabsSync) {
      aegis.requestTabsSync();
    }
  }

  private registerBridgeListeners(): void {
    const aegis = (window as any).aegis;
    if (!aegis) return;

    // Tab synchronization
    aegis.onTabsSync((snapshot: TabsSnapshot) => {
      this.currentTabs = snapshot.tabs;
      this.activeTabId = snapshot.activeTabId;
      this.renderTabs();
    });

    // Live Grid sources (tabs + workers, with their presentation) pushed by the main process (#232)
    aegis.onGridSources?.((data: GridSourcesPayload) => {
      this.swarmGrid.setSources(data.sources || []);
    });
    aegis.getRuntimeFlags?.().then((res: any) => {
      if (res?.data?.testMode) this.swarmGrid.enableTestStats();
    }).catch(() => {});

    aegis.onTabPatch((patchData: TabPatch) => {
      const tab = this.currentTabs.find(t => t.id === patchData.id);
      if (tab) {
        Object.assign(tab, patchData.patch);
        this.updateTabElement(tab);
      }
    });

    // Worker status updates
    aegis.onWorkerEvent((data: WorkerEventPayload) => {
      this.activeWorkers.set(data.id, data);
      this.renderWorkerCards();
      this.swarmGrid.onWorkerEvent(data);
    });

    // Replay demo banner (#224): shown while a demo transcript plays, and for its final result
    aegis.onMissionStatus?.((data: MissionStatusPayload) => {
      if (data.source === 'demo') {
        this.demoBanner.classList.toggle('hidden', data.status !== 'running' && data.status !== 'completed' && data.status !== 'planning');
        this.addTimelineItem(`[DEMO] ${data.message || data.status}`, undefined, 'actions');
      } else if (data.status === 'running' || data.status === 'planning') {
        this.demoBanner.classList.add('hidden');
      }
    });

    // Agent question / approval card (#225): the loop waits (no model calls) until this is answered.
    aegis.onMissionQuestion?.((q: MissionQuestionPayload) => this.showQuestion(q));
    aegis.onMissionStatus?.((data: MissionStatusPayload) => {
      this.applyMissionStatus(data);
      // The crash banner is a question on a PAUSED mission: it stays until answered.
      const keep = data.status === 'waiting_user' || data.status === 'waiting_approval' || (data.status === 'paused' && data.reason === 'tab_crashed');
      if (!keep) this.hideQuestion();
    });
    void this.checkInterruptedMission();

    // Evidence & Activity Timeline feed
    aegis.onEvidenceEvent((data: EvidenceEventPayload) => {
      this.addTimelineItem(data.text, data.timestamp);
    });

    // Telemetry stats & Resource Governance (#141, #231)
    aegis.onGovernanceMetrics?.((g: any) => {
      this.governanceLimitDesc = g?.limitDescription || null;
      this.updateWorkerCountLabel();
    });
    aegis.onTelemetry((data: { tokensTotal: number; costTotal: number }) => {
      if (this.tokensStat) {
        this.tokensStat.textContent = data.tokensTotal.toLocaleString();
      }
      if (this.costStat) {
        this.costStat.textContent = `$${data.costTotal.toFixed(4)}`;
      }
    });
  }

  // ==========================================
  // Layout & Resizing (#138)
  // ==========================================
  private bindLayoutEvents(): void {
    const aegis = (window as any).aegis;

    this.layoutStageBtn.addEventListener('click', () => {
      this.setLayout('stage');
    });

    this.layoutGridBtn.addEventListener('click', () => {
      this.setLayout('grid');
    });

    this.layoutTheatreBtn.addEventListener('click', () => {
      this.setLayout('theatre');
    });

    // Draggable Resizer
    this.paneResizer.addEventListener('mousedown', () => {
      this.isResizing = true;
      this.paneResizer.classList.add('active');
    });

    window.addEventListener('mousemove', (e: MouseEvent) => {
      if (!this.isResizing) return;
      const newWidth = Math.max(260, Math.min(600, window.innerWidth - e.clientX));
      this.drawerWidth = newWidth;
      this.swarmDrawer.style.width = `${newWidth}px`;
      aegis?.toggleDrawer(true, newWidth);
    });

    window.addEventListener('mouseup', () => {
      if (this.isResizing) {
        this.isResizing = false;
        this.paneResizer.classList.remove('active');
      }
    });
  }

  private setLayout(mode: 'stage' | 'grid' | 'theatre'): void {
    this.currentLayout = mode;
    this.layoutStageBtn.classList.toggle('active', mode === 'stage');
    this.layoutGridBtn.classList.toggle('active', mode === 'grid');
    this.layoutTheatreBtn.classList.toggle('active', mode === 'theatre');

    const aegis = (window as any).aegis;
    aegis?.setLayoutMode?.(mode);

    this.swarmGridContainer.classList.toggle('hidden', mode !== 'grid');
    this.swarmGrid.setActive(mode === 'grid');
  }

  // ==========================================
  // Real Controls & Steering (#139, #211, #214)
  // ==========================================
  private bindControls(): void {
    const aegis = (window as any).aegis;

    // Pause / Resume: the label follows the mission:status events from the main process (#226), never a local toggle,
    // so it cannot disagree with the real state (it used to flip even when nothing was running).
    this.pauseBtn.addEventListener('click', () => {
      if (this.missionStatus === 'paused') aegis?.resumeMission?.();
      else if (this.missionStatus === 'running') aegis?.pauseMission?.();
    });

    // Manual Takeover / Hand Back, same rule
    this.takeoverBtn.addEventListener('click', () => {
      if (this.missionStatus === 'takeover') aegis?.handBackMission?.();
      else if (this.missionStatus === 'running' || this.missionStatus === 'paused') aegis?.takeoverMission?.();
    });

    // Undo Last Action (Issue #214)
    this.undoBtn.addEventListener('click', async () => {
      if (aegis?.undoAction) {
        const res = await aegis.undoAction();
        const msg = res?.data?.message || (res?.ok ? 'Last action undone' : 'Nothing to undo');
        this.addTimelineItem(`[Undo] ${msg}`, undefined, 'actions');
      }
    });

    // Cancel Running Mission
    this.cancelMissionBtn.addEventListener('click', () => {
      aegis?.cancelMission?.();
      this.addTimelineItem('[Mission] Cancelled by user', undefined, 'errors');
    });

    // Global Kill Switch (#231)
    this.killSwitchBtn?.addEventListener('click', () => {
      aegis?.triggerKillSwitch?.('Emergency Kill Switch clicked');
      this.addTimelineItem('[Kill Switch] Halted all agents and closed agent tabs', undefined, 'errors');
    });

    // Mid-Run Steering (Issue #211)
    const sendSteering = () => {
      const text = this.steeringInput.value.trim();
      if (!text) return;
      this.steeringInput.value = '';
      aegis?.steerMission?.(text, 'steering');
      this.addTimelineItem(`[Steer] "${text}"`, undefined, 'thoughts');
    };

    this.steeringSendBtn.addEventListener('click', sendSteering);
    this.steeringInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendSteering();
    });

    // Timeline Filter Chips (Issue #137)
    document.querySelectorAll('.filter-chip').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('active'));
        const target = e.currentTarget as HTMLElement;
        target.classList.add('active');
        this.currentFilter = (target.dataset.filter || 'all') as TimelineCategory;
        this.applyTimelineFilter();
      });
    });
  }

  private openQuestion: MissionQuestionPayload | null = null;
  private missionStatus: MissionStatusPayload['status'] = 'idle';

  /** Pause/Takeover buttons and their labels are a pure function of the mission status (#226). */
  private applyMissionStatus(data: MissionStatusPayload): void {
    if (data.source === 'demo') return;
    this.missionStatus = data.status;
    this.isPaused = data.status === 'paused';
    this.isTakeover = data.status === 'takeover';
    this.pauseBtn.textContent = this.isPaused ? 'Resume' : 'Pause';
    this.pauseBtn.className = this.isPaused ? 'badge-btn' : 'badge-btn warning';
    this.pauseBtn.disabled = !(data.status === 'running' || data.status === 'paused') || (data.status === 'paused' && data.reason === 'tab_crashed');
    this.takeoverBtn.textContent = this.isTakeover ? 'Hand Back' : 'Takeover';
    this.takeoverBtn.className = this.isTakeover ? 'badge-btn warning' : 'badge-btn danger';
    this.takeoverBtn.disabled = !(data.status === 'running' || data.status === 'paused' || data.status === 'takeover');
    this.addTimelineItem(`[Status] ${data.status}${data.reason ? ` (${data.reason})` : ''}`, undefined, 'actions');
  }

  /** A short-lived message at the bottom of the window (e.g. MISSION_ACTIVE). */
  private showToast(message: string): void {
    const t = document.createElement('div');
    t.className = 'aegis-toast';
    t.setAttribute('role', 'status');
    t.textContent = sanitizeText(message);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }

  /** "Resume interrupted mission" banner: shown at launch when the last run left a mission unfinished (#226 step 6). */
  private async checkInterruptedMission(): Promise<void> {
    const aegis = (window as any).aegis;
    if (!aegis?.getInterruptedMission) return;
    const res = await aegis.getInterruptedMission();
    const m = res?.data;
    if (!m?.missionId) return;
    const bar = document.createElement('div');
    bar.id = 'interrupted-banner';
    bar.className = 'interrupted-banner';
    const text = document.createElement('span');
    const unknown = m.unknownOutcome ? ` One action was running when the app closed and its outcome is unknown (${sanitizeText(m.unknownOutcome)}); the agent will check the page first.` : '';
    text.textContent = `Interrupted mission: "${sanitizeText(String(m.prompt)).slice(0, 80)}" (${m.stepCount} step(s) done${m.performed?.length ? `, ${m.performed.length} with side effects that will NOT be repeated` : ''}).${unknown}`;
    const resume = document.createElement('button');
    resume.id = 'interrupted-resume-btn';
    resume.className = 'badge-btn';
    resume.textContent = 'Resume interrupted mission';
    const discard = document.createElement('button');
    discard.id = 'interrupted-discard-btn';
    discard.className = 'badge-btn danger';
    discard.textContent = 'Discard';
    resume.addEventListener('click', async () => {
      bar.remove();
      const r = await aegis.resumeInterruptedMission(m.missionId);
      if (!r?.data?.started) this.showToast(r?.data?.message || r?.error || 'Could not resume the mission');
      else this.addTimelineItem(`[Mission] Resumed interrupted mission "${sanitizeText(String(m.prompt)).slice(0, 60)}"`, undefined, 'actions');
    });
    discard.addEventListener('click', () => { bar.remove(); void aegis.resumeInterruptedMission(m.missionId, true); });
    bar.append(text, resume, discard);
    document.body.appendChild(bar);
  }

  private showQuestion(q: MissionQuestionPayload): void {
    const card = document.getElementById('question-card');
    const text = document.getElementById('question-text');
    const kind = document.getElementById('question-kind');
    const opts = document.getElementById('question-options');
    const input = document.getElementById('question-input') as HTMLInputElement | null;
    const send = document.getElementById('question-send-btn') as HTMLButtonElement | null;
    if (!card || !text || !kind || !opts || !input || !send) return;
    this.openQuestion = q;
    kind.textContent = q.kind === 'crash' ? 'Page crashed' : q.kind === 'approval' ? 'Approval needed' : q.kind === 'stuck' ? 'The agent is stuck' : q.kind === 'handoff' ? 'Your help is needed in the page' : 'The agent is asking';
    text.textContent = sanitizeText(q.text);
    opts.textContent = '';
    for (const o of q.options || []) {
      const b = document.createElement('button');
      b.className = 'badge-btn question-option';
      b.textContent = sanitizeText(o);
      b.addEventListener('click', () => void this.sendAnswer(o));
      opts.appendChild(b);
    }
    input.value = '';
    send.onclick = () => { if (input.value.trim()) void this.sendAnswer(input.value.trim()); };
    input.onkeydown = (e) => { if (e.key === 'Enter' && input.value.trim()) void this.sendAnswer(input.value.trim()); };
    card.classList.remove('hidden');
    this.addTimelineItem(`[Question] ${q.text}`, undefined, 'actions');
  }

  private hideQuestion(): void {
    this.openQuestion = null;
    document.getElementById('question-card')?.classList.add('hidden');
  }

  private async sendAnswer(answer: string): Promise<void> {
    const q = this.openQuestion;
    if (!q) return;
    const res = await (window as any).aegis.answerQuestion(q.missionId, q.id, answer);
    const ok = res?.data?.ok ?? res?.ok;
    if (ok) this.hideQuestion();
    else this.addTimelineItem(`[Error] Answer not accepted: ${res?.data?.error || res?.error || 'unknown'}`);
  }

  private addTimelineItem(text: string, timestamp?: string, forcedCategory?: TimelineCategory): void {
    const emptyMsg = document.getElementById('no-evidence-msg');
    if (emptyMsg) emptyMsg.remove();

    let category: TimelineCategory = forcedCategory || 'evidence';
    const lower = text.toLowerCase();
    if (lower.includes('[action]') || lower.includes('[step') || lower.includes('[undo]')) {
      category = 'actions';
    } else if (lower.includes('[thought') || lower.includes('[steer]') || lower.includes('[agent thought]')) {
      category = 'thoughts';
    } else if (lower.includes('[error') || lower.includes('[roadblock') || lower.includes('[refusal]')) {
      category = 'errors';
    }

    const item = document.createElement('div');
    item.className = `evidence-item item-${category}`;
    item.dataset.category = category;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'ev-time';
    timeSpan.textContent = timestamp || new Date().toTimeString().slice(0, 8);
    item.appendChild(timeSpan);

    const textSpan = document.createElement('span');
    textSpan.className = 'ev-text';
    textSpan.textContent = sanitizeText(text);
    item.appendChild(textSpan);

    this.evidenceFeed.prepend(item);
    this.applyTimelineFilter();
  }

  private applyTimelineFilter(): void {
    const items = this.evidenceFeed.querySelectorAll('.evidence-item');
    items.forEach(el => {
      const cat = (el as HTMLElement).dataset.category;
      if (this.currentFilter === 'all' || cat === this.currentFilter) {
        (el as HTMLElement).style.display = 'flex';
      } else {
        (el as HTMLElement).style.display = 'none';
      }
    });
  }

  // ==========================================
  // Plan Preview & Composer (#140)
  // ==========================================
  private async promptPlanPreview(goal: string): Promise<void> {
    const aegis = (window as any).aegis;
    if (!aegis?.previewPlan) return;

    this.pendingPlanPrompt = goal;
    this.pendingPreviewPlan = null;
    aegis.setOverlayActive?.(true); // Occlusion protection (Issue #138)

    const model = this.modelSelect?.value || 'gemini-2.0-flash';
    const status = (await aegis.getModelStatus?.(model))?.data;
    if (status && !status.configured) {
      this.pendingPlanPrompt = '';
      this.openSettings({ provider: status.provider, notice: status.message });
      return;
    }
    const res = await aegis.previewPlan(goal, model);
    const plan = res?.data || res;

    if (plan?.ok === false || (!plan?.stages && plan?.error)) {
      this.pendingPlanPrompt = null;
      this.pendingPreviewPlan = null;
      aegis?.setOverlayActive?.(false);
      const errMsg = plan?.error || 'Failed to plan mission.';
      this.showToast(errMsg);
      this.addTimelineItem(`[Plan Error] ${errMsg}`, undefined, 'errors');
      return;
    }

    this.pendingPreviewPlan = {
      goal: plan.goal || goal,
      mode: plan.mode === 'swarm' ? 'swarm' : 'single',
      justification: plan.justification || '',
      stages: Array.isArray(plan.stages)
        ? plan.stages.map((s: any) => ({
            ...s,
            tasks: Array.isArray(s.tasks) ? s.tasks.map((t: any) => ({ ...t })) : []
          }))
        : [],
      estimatedDurationSec: plan.estimatedDurationSec ?? 0,
      estimatedCostUSD: plan.estimatedCostUSD ?? null
    };

    if (plan?.skipPreview) {
      await this.executeConfirmedPlan();
      return;
    }

    this.planGoalText.textContent = sanitizeText(goal);
    this.renderPlanPreviewBody();
    this.planPreviewModal.classList.remove('hidden');
  }

  private renderPlanPreviewBody(): void {
    const plan = this.pendingPreviewPlan;
    if (!plan) return;

    if (this.planModeBadge) {
      const isSwarm = plan.mode === 'swarm';
      this.planModeBadge.textContent = isSwarm ? 'SWARM' : 'SINGLE AGENT';
      this.planModeBadge.classList.toggle('swarm', isSwarm);
      this.planModeBadge.classList.toggle('single', !isSwarm);
    }
    if (this.planJustificationText) {
      this.planJustificationText.textContent = sanitizeText(plan.justification || 'No justification provided.');
    }
    if (this.switchSinglePlanBtn) {
      this.switchSinglePlanBtn.classList.toggle('hidden', plan.mode !== 'swarm');
    }

    this.planStepsContainer.replaceChildren();
    const totalTasks = plan.stages.reduce((acc: number, s: any) => acc + (s.tasks?.length || 0), 0);
    let stepNum = 0;

    for (let sIdx = 0; sIdx < plan.stages.length; sIdx++) {
      const stage = plan.stages[sIdx];
      for (let tIdx = 0; tIdx < (stage.tasks?.length || 0); tIdx++) {
        const task = stage.tasks[tIdx];
        stepNum++;
        const stepEl = document.createElement('div');
        stepEl.className = 'plan-step-item';

        const badge = document.createElement('div');
        badge.className = 'step-num-badge';
        badge.textContent = String(stepNum);
        stepEl.appendChild(badge);

        const content = document.createElement('div');
        content.className = 'step-content';

        const titleRow = document.createElement('div');
        titleRow.className = 'step-title';
        titleRow.textContent = sanitizeText(`[${stage.stageName}] ${task.name} (${task.role} · ${task.effectClass})`);
        content.appendChild(titleRow);

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'form-input plan-task-input';
        input.value = String(task.instruction || '');
        input.setAttribute('aria-label', `Edit instruction for ${task.name}`);
        input.addEventListener('input', () => {
          task.instruction = input.value;
        });
        content.appendChild(input);

        if (task.url) {
          const desc = document.createElement('div');
          desc.className = 'step-desc';
          desc.textContent = sanitizeText(task.url);
          content.appendChild(desc);
        }

        stepEl.appendChild(content);

        if (totalTasks > 1) {
          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'btn-secondary plan-remove-task-btn';
          removeBtn.textContent = 'Remove';
          removeBtn.addEventListener('click', () => {
            const removedId = task.id;
            stage.tasks.splice(tIdx, 1);
            for (const remStage of plan.stages) {
              for (const remTask of remStage.tasks) {
                if (Array.isArray(remTask.dependencies)) {
                  remTask.dependencies = remTask.dependencies.filter((d: string) => d !== removedId);
                }
              }
            }
            plan.stages = plan.stages.filter((s: any) => s.tasks.length > 0);
            for (const remStage of plan.stages) {
              remStage.parallelism = Math.max(1, Math.min(remStage.parallelism, remStage.tasks.length));
            }
            this.renderPlanPreviewBody();
          });
          stepEl.appendChild(removeBtn);
        }

        this.planStepsContainer.appendChild(stepEl);
      }
    }

    this.planEstDuration.textContent = plan.estimatedDurationSec ? `~${plan.estimatedDurationSec}s` : '—';
    if (plan.estimatedCostUSD === null || plan.estimatedCostUSD === undefined) {
      this.planEstCost.textContent = 'no pricing data';
    } else {
      this.planEstCost.textContent = `~$${Number(plan.estimatedCostUSD).toFixed(4)}`;
    }
  }

  private switchPlanToSingleAgent(): void {
    const plan = this.pendingPreviewPlan;
    if (!plan) return;
    const goal = this.pendingPlanPrompt || plan.goal;
    const allTasks = plan.stages.flatMap((s: any) => s.tasks || []);
    const hasApproval = allTasks.some((t: any) => t.requiresApproval);
    const nonRead = allTasks.find((t: any) => t.effectClass && t.effectClass !== 'read');
    const firstUrl = allTasks.find((t: any) => t.url)?.url;
    plan.mode = 'single';
    plan.justification = 'User switched plan to single-agent execution.';
    plan.stages = [
      {
        stageName: 'execute',
        parallelism: 1,
        tasks: [
          {
            id: 'task_single',
            name: 'Single-Agent Execution',
            role: nonRead ? 'actor' : 'researcher',
            ...(firstUrl ? { url: firstUrl } : {}),
            instruction: goal,
            effectClass: nonRead ? nonRead.effectClass : 'read',
            dependencies: [],
            ...(hasApproval ? { requiresApproval: true } : {})
          }
        ]
      }
    ];
    this.renderPlanPreviewBody();
  }

  private closePlanPreview(): void {
    this.planPreviewModal.classList.add('hidden');
    this.pendingPreviewPlan = null;
    (window as any).aegis?.setOverlayActive?.(false);
  }

  private async executeConfirmedPlan(): Promise<void> {
    const goal = this.pendingPlanPrompt;
    const editedPlan = this.pendingPreviewPlan;
    this.closePlanPreview();
    if (!goal) return;

    const aegis = (window as any).aegis;
    this.swarmDrawer.classList.remove('closed');
    this.drawerToggleBtn.classList.add('active');
    aegis?.toggleDrawer(true, this.drawerWidth);

    const model = this.modelSelect?.value || 'gemini-2.0-flash';
    this.addTimelineItem(`[Mission Plan Confirmed] "${goal}"`, undefined, 'actions');

    const startOptions = editedPlan
      ? {
          approvedMode: editedPlan.mode,
          approvedPlan: {
            missionId: `preview_${Date.now()}`,
            goal,
            justification: editedPlan.justification,
            stages: editedPlan.stages
          }
        }
      : undefined;

    const res = await aegis.startMission(goal, model, startOptions);
    if (!res?.data?.started) {
      const reason = res?.data?.message || res?.error || 'Agent runtime not configured.';
      if (res?.data?.code === MISSION_ACTIVE) {
        this.showToast(reason);
      } else if (res?.data?.code === MODEL_NOT_CONFIGURED) {
        // Typed first-run error (#224): open Settings on the provider with the message, no mission started
        this.openSettings({ provider: res.data.provider, notice: reason });
      } else {
        this.addTimelineItem(`[Notice] ${reason}`, undefined, 'errors');
      }
    }
  }

  // ==========================================
  // Settings & Credentials (#129, #133)
  // ==========================================
  private bindSettingsEvents(): void {
    this.settingsBtn.addEventListener('click', () => this.openSettings());
    this.closeSettingsBtn.addEventListener('click', () => this.closeSettings());
    this.cancelSettingsBtn.addEventListener('click', () => this.closeSettings());
    this.saveSettingsBtn.addEventListener('click', () => this.saveSettings());
    this.settingsProvider.addEventListener('change', () => this.updateProviderVisibility());
    document.getElementById('replay-demo-btn')?.addEventListener('click', () => this.startReplayDemo());
    document.getElementById('settings-replay-demo-btn')?.addEventListener('click', () => {
      this.closeSettings();
      void this.startReplayDemo();
    });

    // Plan Preview buttons
    this.closePlanBtn.addEventListener('click', () => this.closePlanPreview());
    this.cancelPlanBtn.addEventListener('click', () => this.closePlanPreview());
    this.executePlanBtn.addEventListener('click', () => this.executeConfirmedPlan());
    this.switchSinglePlanBtn?.addEventListener('click', () => this.switchPlanToSingleAgent());

    // Credential test probes
    document.getElementById('test-gemini-btn')?.addEventListener('click', () => this.testKey('gemini'));
    document.getElementById('test-anthropic-btn')?.addEventListener('click', () => this.testKey('anthropic'));
    document.getElementById('test-openai-btn')?.addEventListener('click', () => this.testKey('openai'));
    document.getElementById('test-ollama-btn')?.addEventListener('click', () => this.testKey('ollama'));
  }

  private unverifiedKeyArmed = '';

  /** Rough per-step cost from the main-process pricing table; states its assumptions, never guesses a missing price. */
  private estimateText(data: any): string {
    const e = data?.estimate;
    if (!e) return '';
    const basis = `assumes ~${e.promptTokens} prompt + ${e.completionTokens} completion tokens per step`;
    if (e.costUSD === null) return ` | no pricing data for ${data.model}`;
    return ` | ~${e.costUSD.toFixed(4)} per step on ${data.model} (${basis})`;
  }

  private showEstimate(data: any): void {
    this.settingsStatusMsg.textContent = `✓ ${data.message}${this.estimateText(data)}`;
    this.settingsStatusMsg.style.color = 'var(--success)';
  }

  /** The model picker decides the model per mission, so keep it on a model of the provider just saved. */
  private syncModelPickerToProvider(provider: string): void {
    const wanted: Record<string, string> = { gemini: 'gemini-2.0-flash', anthropic: 'claude-3-7-sonnet-latest', openai: 'gpt-4o', ollama: 'deepseek-r1:8b' };
    if (this.modelSelect && wanted[provider]) this.modelSelect.value = wanted[provider];
  }

  private async testKey(provider: string): Promise<void> {
    const aegis = (window as any).aegis;
    if (!aegis?.testCredentials) return;

    let key = '';
    let baseUrl: string | undefined = undefined;

    if (provider === 'gemini') key = this.settingsGeminiKey.value;
    else if (provider === 'anthropic') key = this.settingsAnthropicKey.value;
    else if (provider === 'openai') key = this.settingsOpenaiKey.value;
    else if (provider === 'ollama') {
      key = 'ollama';
      baseUrl = this.settingsOllamaUrl.value;
    }

    this.settingsStatusMsg.textContent = `Testing connection to ${provider}...`;
    this.settingsStatusMsg.style.color = 'var(--text-muted)';
    this.settingsStatusMsg.style.display = 'block';

    const res = await aegis.testCredentials(provider, key, baseUrl);
    const data = res?.data || res;

    if (data?.valid) {
      this.settingsStatusMsg.textContent = `✓ ${data.message}${this.estimateText(data)}`;
      this.settingsStatusMsg.style.color = 'var(--success)';
    } else {
      this.settingsStatusMsg.textContent = `✗ ${data?.message || 'Verification failed'}`;
      this.settingsStatusMsg.style.color = 'var(--danger)';
    }
  }

  private async startReplayDemo(): Promise<void> {
    const aegis = (window as any).aegis;
    const welcome = document.querySelector('.welcome-screen') as HTMLElement;
    if (welcome) welcome.style.display = 'none';
    this.swarmDrawer.classList.remove('closed');
    this.drawerToggleBtn.classList.add('active');
    aegis?.toggleDrawer(true, this.drawerWidth);
    const res = await aegis?.startDemo?.();
    if (!res?.data?.started) {
      this.addTimelineItem(`[Notice] ${res?.data?.message || res?.error || 'Replay demo could not start.'}`, undefined, 'errors');
    }
  }

  private async openSettings(opts?: { provider?: string; notice?: string }): Promise<void> {
    const aegis = (window as any).aegis;
    if (!aegis?.getSettings) return;

    aegis.setOverlayActive?.(true); // Occlusion protection (Issue #138)

    try {
      const res = await aegis.getSettings();
      const settings = res.data || res;

      if (settings) {
        this.settingsProvider.value = settings.modelProvider || 'gemini';
        this.settingsGeminiKey.value = settings.apiKeys?.gemini || '';
        this.settingsAnthropicKey.value = settings.apiKeys?.anthropic || '';
        this.settingsOpenaiKey.value = settings.apiKeys?.openai || '';
        this.settingsOllamaUrl.value = settings.ollamaBaseUrl || 'http://localhost:11434';
        if (this.settingsSkipLowRiskPreview) {
          this.settingsSkipLowRiskPreview.checked = Boolean(settings.skipLowRiskPlanPreview);
        }
      }
    } catch (err) {
      console.error('Failed to load settings', err);
    }

    // The provider the failed mission needed wins over the saved one, and the message must survive the load above
    if (opts?.provider) this.settingsProvider.value = opts.provider === 'ollama' ? 'ollama' : opts.provider;
    this.updateProviderVisibility();
    this.settingsNotice.textContent = opts?.notice || '';
    this.settingsNotice.classList.toggle('hidden', !opts?.notice);
    this.settingsStatusMsg.style.display = 'none';
    this.settingsModal.classList.remove('hidden');
  }

  private closeSettings(): void {
    this.settingsModal.classList.add('hidden');
    (window as any).aegis?.setOverlayActive?.(false);
  }

  private updateProviderVisibility(): void {
    const provider = this.settingsProvider.value;
    this.groupGeminiKey.style.display = provider === 'gemini' ? 'flex' : 'none';
    this.groupAnthropicKey.style.display = provider === 'anthropic' ? 'flex' : 'none';
    this.groupOpenaiKey.style.display = provider === 'openai' ? 'flex' : 'none';
    this.groupOllamaUrl.style.display = provider === 'ollama' ? 'flex' : 'none';
  }

  private async saveSettings(): Promise<void> {
    const aegis = (window as any).aegis;
    if (!aegis?.updateSettings) return;

    const provider = this.settingsProvider.value as any;
    const patch = {
      modelProvider: provider,
      apiKeys: {
        gemini: this.settingsGeminiKey.value.trim(),
        anthropic: this.settingsAnthropicKey.value.trim(),
        openai: this.settingsOpenaiKey.value.trim()
      },
      ollamaBaseUrl: this.settingsOllamaUrl.value.trim() || 'http://localhost:11434',
      skipLowRiskPlanPreview: Boolean(this.settingsSkipLowRiskPreview?.checked)
    };

    // Validate the selected provider's key before saving (CREDENTIALS_TEST). A second Save on the same
    // unchanged, unverified key stores it anyway (offline, or a provider the probe cannot reach).
    const typedKey = provider === 'gemini' ? patch.apiKeys.gemini : provider === 'anthropic' ? patch.apiKeys.anthropic : provider === 'openai' ? patch.apiKeys.openai : '';
    if (typedKey && aegis.testCredentials && this.unverifiedKeyArmed !== typedKey) {
      this.settingsStatusMsg.textContent = `Validating ${provider} key...`;
      this.settingsStatusMsg.style.color = 'var(--text-muted)';
      this.settingsStatusMsg.style.display = 'block';
      const test = await aegis.testCredentials(provider, typedKey);
      const data = test?.data || test;
      if (!data?.valid) {
        this.unverifiedKeyArmed = typedKey;
        this.settingsStatusMsg.textContent = `\u2717 ${data?.message || 'Key could not be verified'}. Press Save again to store it unverified.`;
        this.settingsStatusMsg.style.color = 'var(--danger)';
        return;
      }
      this.showEstimate(data);
    }
    this.unverifiedKeyArmed = '';
    this.syncModelPickerToProvider(provider);

    try {
      await aegis.updateSettings(patch);
      this.settingsStatusMsg.textContent = 'Settings saved successfully!';
      this.settingsStatusMsg.style.color = 'var(--success)';
      this.settingsStatusMsg.style.display = 'block';

      setTimeout(() => {
        this.closeSettings();
      }, 700);
    } catch (err: any) {
      this.settingsStatusMsg.textContent = `Error saving settings: ${err.message}`;
      this.settingsStatusMsg.style.color = 'var(--danger)';
      this.settingsStatusMsg.style.display = 'block';
    }
  }

  // ==========================================
  // Omnibar & Navigation
  // ==========================================
  private bindEvents(): void {
    const aegis = (window as any).aegis;

    // Window Controls
    document.getElementById('min-btn')?.addEventListener('click', () => aegis?.minimize());
    document.getElementById('max-btn')?.addEventListener('click', () => aegis?.maximize());
    document.getElementById('close-btn')?.addEventListener('click', () => aegis?.close());

    // Navigation
    document.getElementById('back-btn')?.addEventListener('click', () => aegis?.goBack());
    document.getElementById('forward-btn')?.addEventListener('click', () => aegis?.goForward());
    document.getElementById('reload-btn')?.addEventListener('click', () => aegis?.reload());

    // Omnibar
    this.swarmRunBtn.addEventListener('click', () => this.handleOmnibarSubmit());
    this.omnibarInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleOmnibarSubmit();
    });

    // Keyboard shortcuts (Issue #145: Accessibility & speed)
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      const isCtrl = e.ctrlKey || e.metaKey;
      if (isCtrl && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.omnibarInput.focus();
        this.omnibarInput.select();
      } else if (isCtrl && e.key.toLowerCase() === 't') {
        e.preventDefault();
        aegis?.createTab('https://duckduckgo.com');
      } else if (isCtrl && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        if (this.activeTabId) aegis?.closeTab(this.activeTabId);
      } else if (isCtrl && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        const isClosed = this.swarmDrawer.classList.toggle('closed');
        this.drawerToggleBtn.classList.toggle('active');
        aegis?.toggleDrawer(!isClosed, this.drawerWidth);
      } else if (e.key === 'Escape') {
        this.closeSettings();
        this.closePlanPreview();
      }
    });

    // Drawer toggle
    this.drawerToggleBtn.addEventListener('click', () => {
      const isClosed = this.swarmDrawer.classList.toggle('closed');
      this.drawerToggleBtn.classList.toggle('active');
      aegis?.toggleDrawer(!isClosed, this.drawerWidth);
    });

    // Quick prompts
    document.querySelectorAll('.pill').forEach(pill => {
      pill.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const prompt = target.getAttribute('data-prompt');
        if (prompt) {
          this.omnibarInput.value = prompt;
          this.handleOmnibarSubmit();
        }
      });
    });

    // New Tab
    this.newTabBtn.addEventListener('click', () => {
      aegis?.createTab('https://duckduckgo.com');
    });
  }

  private async handleOmnibarSubmit(): Promise<void> {
    const raw = this.omnibarInput.value.trim();
    if (!raw) return;

    const aegis = (window as any).aegis;
    const intent = OmnibarParser.parse(raw);

    const welcome = document.querySelector('.welcome-screen') as HTMLElement;
    if (welcome) welcome.style.display = 'none';

    if (intent.type === 'agent_command') {
      const promptText =
        intent.command === 'swarm'
          ? (intent.prompt ? `/swarm ${intent.prompt}` : '/swarm')
          : (intent.prompt || raw);
      // Show plan preview modal for approval before execution (Issue #140)
      await this.promptPlanPreview(promptText);
    } else if (intent.type === 'url' || intent.type === 'search') {
      const target = intent.targetUrl || raw;
      if (aegis?.navigateTab) {
        await aegis.navigateTab(target);
      }
    }
  }

  private renderTabs(): void {
    this.tabsContainer.replaceChildren();

    for (const tab of this.currentTabs) {
      const tabEl = document.createElement('div');
      tabEl.className = `tab ${tab.id === this.activeTabId ? 'active' : ''}`;
      tabEl.dataset.tabId = tab.id;

      const badge = document.createElement('span');
      if (tab.owner && tab.owner.startsWith('agent:')) {
        badge.className = 'profile-badge incognito';
        badge.textContent = 'Agent';
      } else {
        badge.className = 'profile-badge work';
        badge.textContent = 'Work';
      }
      tabEl.appendChild(badge);

      const titleSpan = document.createElement('span');
      titleSpan.className = 'tab-title';
      titleSpan.textContent = sanitizeText(tab.title || 'New Tab');
      tabEl.appendChild(titleSpan);

      const closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close-btn';
      closeBtn.textContent = '×';
      closeBtn.title = 'Close tab';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        (window as any).aegis?.closeTab(tab.id);
      });
      tabEl.appendChild(closeBtn);

      tabEl.addEventListener('click', () => {
        (window as any).aegis?.switchTab(tab.id);
      });

      this.tabsContainer.appendChild(tabEl);
    }

    const activeTab = this.currentTabs.find(t => t.id === this.activeTabId);
    if (activeTab && activeTab.url && !this.omnibarInput.value.startsWith('/')) {
      this.omnibarInput.value = activeTab.url;
    }
  }

  private updateTabElement(tab: TabState): void {
    const tabEl = this.tabsContainer.querySelector(`[data-tab-id="${tab.id}"]`);
    if (!tabEl) return;

    const titleSpan = tabEl.querySelector('.tab-title');
    if (titleSpan) {
      titleSpan.textContent = sanitizeText(tab.title || 'New Tab');
    }

    if (tab.id === this.activeTabId && tab.url && !this.omnibarInput.value.startsWith('/')) {
      this.omnibarInput.value = tab.url;
    }
  }

  private updateWorkerCountLabel(): void {
    if (!this.workerCountStat) return;
    const count = this.activeWorkers.size;
    this.workerCountStat.textContent = this.governanceLimitDesc
      ? `${count} workers (${this.governanceLimitDesc})`
      : String(count);
  }

  private renderWorkerCards(): void {
    const cards = Array.from(this.activeWorkers.values());
    this.updateWorkerCountLabel();

    this.workerCardsContainer.replaceChildren();

    if (cards.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'empty-state-text';
      emptyMsg.textContent = 'No active agent workers';
      this.workerCardsContainer.appendChild(emptyMsg);
      return;
    }

    const aegis = (window as any).aegis;
    for (const worker of cards) {
      const card = document.createElement('div');
      card.className = `worker-card ${worker.status}`;
      card.id = sanitizeText(worker.id);
      card.dataset.workerId = worker.id;

      const top = document.createElement('div');
      top.className = 'card-top';

      const name = document.createElement('span');
      name.className = 'w-name';
      name.textContent = sanitizeText(worker.name || worker.id);
      top.appendChild(name);

      const dot = document.createElement('span');
      dot.className = `status-dot ${worker.status === 'done' || worker.status === 'running' ? 'green' : 'gray'}`;
      top.appendChild(dot);
      card.appendChild(top);

      const task = document.createElement('div');
      task.className = 'w-task';
      task.textContent = sanitizeText(worker.task);
      card.appendChild(task);

      const progressBar = document.createElement('div');
      progressBar.className = 'progress-bar';
      const fill = document.createElement('div');
      fill.className = 'fill';
      fill.style.width = `${Math.min(100, Math.max(0, worker.progress))}%`;
      progressBar.appendChild(fill);
      card.appendChild(progressBar);

      if (worker.status === 'running' || worker.status === 'paused' || worker.status === 'takeover') {
        const actions = document.createElement('div');
        actions.className = 'card-actions';

        const pauseBtn = document.createElement('button');
        pauseBtn.type = 'button';
        pauseBtn.className = 'worker-ctrl-btn';
        pauseBtn.dataset.action = worker.status === 'paused' ? 'resume' : 'pause';
        pauseBtn.textContent = worker.status === 'paused' ? 'Resume' : 'Pause';
        pauseBtn.addEventListener('click', () => {
          if (worker.status === 'paused') aegis?.resumeWorker?.(worker.id);
          else aegis?.pauseWorker?.(worker.id);
        });
        actions.appendChild(pauseBtn);

        const takeoverBtn = document.createElement('button');
        takeoverBtn.type = 'button';
        takeoverBtn.className = 'worker-ctrl-btn';
        takeoverBtn.dataset.action = 'takeover';
        takeoverBtn.textContent = worker.status === 'takeover' ? 'Hand Back' : 'Takeover';
        takeoverBtn.addEventListener('click', () => {
          aegis?.takeoverWorker?.(worker.id);
        });
        actions.appendChild(takeoverBtn);

        const stopBtn = document.createElement('button');
        stopBtn.type = 'button';
        stopBtn.className = 'worker-ctrl-btn danger';
        stopBtn.dataset.action = 'stop';
        stopBtn.textContent = 'Stop';
        stopBtn.addEventListener('click', () => {
          aegis?.stopWorker?.(worker.id);
        });
        actions.appendChild(stopBtn);

        card.appendChild(actions);
      }

      this.workerCardsContainer.appendChild(card);
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new BrowserApp();
});
