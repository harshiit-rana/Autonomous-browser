/**
 * Project Aegis - Mission Control & Chrome UX Controller
 * Implements: Issues #134, #135, #136, #137, #138, #139, #140, #141, #142, #143, #211, #214
 */

import { OmnibarParser } from '../ui/omnibar_parser.js';
import { HistoryPanel } from './history_panel.js';
import {
  TabState,
  TabsSnapshot,
  TabPatch,
  WorkerEventPayload,
  EvidenceEventPayload,
  PresenceEventPayload,
  SwarmPreviewItem
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

  // Real Controls (Issue #139)
  private pauseBtn: HTMLButtonElement;
  private takeoverBtn: HTMLButtonElement;
  private undoBtn: HTMLButtonElement;
  private cancelMissionBtn: HTMLButtonElement;

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
  private presenceOverlay: HTMLElement;
  private cursorElement: HTMLElement | null = null;

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

  // Plan Preview Modal (Issue #140)
  private planPreviewModal: HTMLElement;
  private planGoalText: HTMLElement;
  private planStepsContainer: HTMLElement;
  private planEstDuration: HTMLElement;
  private planEstCost: HTMLElement;
  private closePlanBtn: HTMLButtonElement;
  private cancelPlanBtn: HTMLButtonElement;
  private executePlanBtn: HTMLButtonElement;
  private pendingPlanPrompt: string | null = null;

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
  private settingsDemoMode: HTMLInputElement;
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

    // Layout
    this.layoutStageBtn = document.getElementById('layout-stage-btn') as HTMLButtonElement;
    this.layoutGridBtn = document.getElementById('layout-grid-btn') as HTMLButtonElement;
    this.layoutTheatreBtn = document.getElementById('layout-theatre-btn') as HTMLButtonElement;
    this.paneResizer = document.getElementById('pane-resizer') as HTMLElement;
    this.swarmGridContainer = document.getElementById('swarm-grid-container') as HTMLElement;
    this.presenceOverlay = document.getElementById('presence-overlay') as HTMLElement;

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
    this.settingsDemoMode = document.getElementById('settings-demo-mode') as HTMLInputElement;
    this.groupGeminiKey = document.getElementById('group-gemini-key') as HTMLElement;
    this.groupAnthropicKey = document.getElementById('group-anthropic-key') as HTMLElement;
    this.groupOpenaiKey = document.getElementById('group-openai-key') as HTMLElement;
    this.groupOllamaUrl = document.getElementById('group-ollama-url') as HTMLElement;
    this.settingsStatusMsg = document.getElementById('settings-status-msg') as HTMLElement;

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
      if (this.currentLayout === 'grid') {
        this.refreshSwarmGrid();
      }
    });

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
    });

    // Evidence & Activity Timeline feed
    aegis.onEvidenceEvent((data: EvidenceEventPayload) => {
      this.addTimelineItem(data.text, data.timestamp);
    });

    // Telemetry stats
    aegis.onTelemetry((data: { tokensTotal: number; costTotal: number }) => {
      if (this.tokensStat) {
        this.tokensStat.textContent = data.tokensTotal.toLocaleString();
      }
      if (this.costStat) {
        this.costStat.textContent = `$${data.costTotal.toFixed(4)}`;
      }
    });

    // Agent Presence Layer (Issue #136: Rendering outside page DOM)
    aegis.onPresence?.((data: PresenceEventPayload) => {
      this.handlePresenceEvent(data);
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

    if (mode === 'grid') {
      this.swarmGridContainer.classList.remove('hidden');
      this.refreshSwarmGrid();
    } else {
      this.swarmGridContainer.classList.add('hidden');
    }
  }

  private async refreshSwarmGrid(): Promise<void> {
    const aegis = (window as any).aegis;
    if (!aegis?.getSwarmPreviews) return;

    const res = await aegis.getSwarmPreviews();
    const items: SwarmPreviewItem[] = res?.data || res || [];

    this.swarmGridContainer.replaceChildren();

    if (items.length === 0) {
      const msg = document.createElement('div');
      msg.className = 'empty-state-text';
      msg.textContent = 'No open tabs or active workers in swarm grid';
      this.swarmGridContainer.appendChild(msg);
      return;
    }

    for (const item of items) {
      const card = document.createElement('div');
      card.className = `swarm-grid-card ${item.isActive ? 'active-tab' : ''}`;

      if (item.thumbnailBase64) {
        const img = document.createElement('img');
        img.className = 'swarm-card-thumb';
        img.src = item.thumbnailBase64;
        card.appendChild(img);
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'swarm-card-thumb';
        placeholder.style.display = 'flex';
        placeholder.style.alignItems = 'center';
        placeholder.style.justifyContent = 'center';
        placeholder.style.color = 'var(--text-muted)';
        placeholder.textContent = 'Rendering...';
        card.appendChild(placeholder);
      }

      const body = document.createElement('div');
      body.className = 'swarm-card-body';

      const title = document.createElement('div');
      title.className = 'swarm-card-title';
      title.textContent = sanitizeText(item.title || 'Tab');
      body.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'swarm-card-meta';
      meta.textContent = item.owner.startsWith('agent:') ? 'Agent Worker' : 'User Tab';
      body.appendChild(meta);

      card.appendChild(body);

      // Clicking card switches active tab and promotes back to Stage
      card.addEventListener('click', () => {
        aegis?.switchTab(item.tabId);
        this.setLayout('stage');
      });

      this.swarmGridContainer.appendChild(card);
    }
  }

  // ==========================================
  // Presence Overlay Layer (#136)
  // ==========================================
  private handlePresenceEvent(data: PresenceEventPayload): void {
    if (!this.presenceOverlay) return;

    if (!this.cursorElement) {
      this.cursorElement = document.createElement('div');
      this.cursorElement.className = '__presence_cursor__';
      const chip = document.createElement('span');
      chip.className = 'cursor-chip';
      chip.textContent = sanitizeText(data.workerName || 'Aegis Agent');
      this.cursorElement.appendChild(chip);
      this.presenceOverlay.appendChild(this.cursorElement);
    }

    if (data.type === 'move') {
      this.cursorElement.style.transform = `translate(${data.x - 9}px, ${data.y - 9}px)`;
    } else if (data.type === 'click') {
      this.cursorElement.style.transform = `translate(${data.x - 9}px, ${data.y - 9}px)`;
      const ripple = document.createElement('div');
      ripple.className = '__presence_ripple__';
      ripple.style.left = `${data.x}px`;
      ripple.style.top = `${data.y}px`;
      this.presenceOverlay.appendChild(ripple);
      setTimeout(() => ripple.remove(), 400);
    }
  }

  // ==========================================
  // Real Controls & Steering (#139, #211, #214)
  // ==========================================
  private bindControls(): void {
    const aegis = (window as any).aegis;

    // Pause / Resume
    this.pauseBtn.addEventListener('click', () => {
      this.isPaused = !this.isPaused;
      this.pauseBtn.textContent = this.isPaused ? 'Resume' : 'Pause';
      this.pauseBtn.className = this.isPaused ? 'badge-btn' : 'badge-btn warning';
      if (this.isPaused) {
        aegis?.pauseMission?.();
      } else {
        aegis?.resumeMission?.();
      }
    });

    // Manual Takeover
    this.takeoverBtn.addEventListener('click', () => {
      this.isTakeover = !this.isTakeover;
      this.takeoverBtn.textContent = this.isTakeover ? 'Hand Back' : 'Takeover';
      this.takeoverBtn.className = this.isTakeover ? 'badge-btn warning' : 'badge-btn danger';
      if (this.isTakeover) {
        aegis?.takeoverMission?.();
      } else {
        aegis?.handBackMission?.();
      }
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
    aegis.setOverlayActive?.(true); // Occlusion protection (Issue #138)

    const model = this.modelSelect?.value || 'gemini-2.0-flash';
    const res = await aegis.previewPlan(goal, model);
    const plan = res?.data || res;

    this.planGoalText.textContent = sanitizeText(goal);
    this.planStepsContainer.replaceChildren();

    if (plan?.steps) {
      for (const step of plan.steps) {
        const stepEl = document.createElement('div');
        stepEl.className = 'plan-step-item';

        const badge = document.createElement('div');
        badge.className = 'step-num-badge';
        badge.textContent = String(step.stepNumber);
        stepEl.appendChild(badge);

        const content = document.createElement('div');
        content.className = 'step-content';

        const title = document.createElement('div');
        title.className = 'step-title';
        title.textContent = sanitizeText(step.title);
        content.appendChild(title);

        const desc = document.createElement('div');
        desc.className = 'step-desc';
        desc.textContent = sanitizeText(step.description);
        content.appendChild(desc);

        stepEl.appendChild(content);
        this.planStepsContainer.appendChild(stepEl);
      }
    }

    if (plan?.estimatedDurationSec) {
      this.planEstDuration.textContent = `~${plan.estimatedDurationSec}s`;
    }
    if (plan?.estimatedCostUSD) {
      this.planEstCost.textContent = `~$${plan.estimatedCostUSD.toFixed(4)}`;
    }

    this.planPreviewModal.classList.remove('hidden');
  }

  private closePlanPreview(): void {
    this.planPreviewModal.classList.add('hidden');
    (window as any).aegis?.setOverlayActive?.(false);
  }

  private async executeConfirmedPlan(): Promise<void> {
    const goal = this.pendingPlanPrompt;
    this.closePlanPreview();
    if (!goal) return;

    const aegis = (window as any).aegis;
    this.swarmDrawer.classList.remove('closed');
    this.drawerToggleBtn.classList.add('active');
    aegis?.toggleDrawer(true, this.drawerWidth);

    const model = this.modelSelect?.value || 'gemini-2.0-flash';
    this.addTimelineItem(`[Mission Plan Confirmed] "${goal}"`, undefined, 'actions');

    const res = await aegis.startMission(goal, model);
    if (!res?.data?.started) {
      const reason = res?.data?.message || 'Agent runtime not configured.';
      this.addTimelineItem(`[Notice] ${reason}`, undefined, 'errors');
      if (reason.toLowerCase().includes('settings') || reason.toLowerCase().includes('api key')) {
        this.openSettings();
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

    // Plan Preview buttons
    this.closePlanBtn.addEventListener('click', () => this.closePlanPreview());
    this.cancelPlanBtn.addEventListener('click', () => this.closePlanPreview());
    this.executePlanBtn.addEventListener('click', () => this.executeConfirmedPlan());

    // Credential test probes
    document.getElementById('test-gemini-btn')?.addEventListener('click', () => this.testKey('gemini'));
    document.getElementById('test-anthropic-btn')?.addEventListener('click', () => this.testKey('anthropic'));
    document.getElementById('test-openai-btn')?.addEventListener('click', () => this.testKey('openai'));
    document.getElementById('test-ollama-btn')?.addEventListener('click', () => this.testKey('ollama'));
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
      this.settingsStatusMsg.textContent = `✓ ${data.message}`;
      this.settingsStatusMsg.style.color = 'var(--success)';
    } else {
      this.settingsStatusMsg.textContent = `✗ ${data?.message || 'Verification failed'}`;
      this.settingsStatusMsg.style.color = 'var(--danger)';
    }
  }

  private async openSettings(): Promise<void> {
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
        this.settingsDemoMode.checked = !!settings.demoMode;
      }
    } catch (err) {
      console.error('Failed to load settings', err);
    }

    this.updateProviderVisibility();
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
      demoMode: this.settingsDemoMode.checked
    };

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
      const promptText = intent.prompt || raw;
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

  private renderWorkerCards(): void {
    const cards = Array.from(this.activeWorkers.values());
    if (this.workerCountStat) {
      this.workerCountStat.textContent = String(cards.length);
    }

    this.workerCardsContainer.replaceChildren();

    if (cards.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'empty-state-text';
      emptyMsg.textContent = 'No active agent workers';
      this.workerCardsContainer.appendChild(emptyMsg);
      return;
    }

    for (const worker of cards) {
      const card = document.createElement('div');
      card.className = `worker-card ${worker.status}`;
      card.id = sanitizeText(worker.id);

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

      this.workerCardsContainer.appendChild(card);
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new BrowserApp();
});
