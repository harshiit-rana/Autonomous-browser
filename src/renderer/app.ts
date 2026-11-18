/**
 * Project Aegis - Browser Chrome Application Controller
 * Implements: UI-01, UI-02, UI-03, UI-04, UI-05, M0 Foundations, M1 Agent Controls & Settings
 */

import { OmnibarParser } from '../ui/omnibar_parser.js';
import { TabState, TabsSnapshot, TabPatch, WorkerEventPayload, EvidenceEventPayload } from '../ipc/contract.js';

function sanitizeText(str: string): string {
  if (!str) return '';
  // Strip control characters and bidirectional overrides to prevent spoofing
  return str.replace(/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E]/g, '').trim();
}

class BrowserApp {
  private omnibarInput: HTMLInputElement;
  private swarmRunBtn: HTMLButtonElement;
  private drawerToggleBtn: HTMLButtonElement;
  private swarmDrawer: HTMLElement;
  private tabsContainer: HTMLElement;
  private newTabBtn: HTMLButtonElement;
  private pauseBtn: HTMLButtonElement;
  private takeoverBtn: HTMLButtonElement;
  private modelSelect: HTMLSelectElement;
  private workerCardsContainer: HTMLElement;
  private evidenceFeed: HTMLElement;
  private workerCountStat: HTMLElement;
  private tokensStat: HTMLElement;
  private costStat: HTMLElement;

  // Settings Modal elements
  private settingsBtn: HTMLButtonElement;
  private settingsModal: HTMLElement;
  private closeSettingsBtn: HTMLButtonElement;
  private cancelSettingsBtn: HTMLButtonElement;
  private saveSettingsBtn: HTMLButtonElement;
  private settingsProvider: HTMLSelectElement;
  private settingsGeminiKey: HTMLInputElement;
  private settingsOpenaiKey: HTMLInputElement;
  private settingsOllamaUrl: HTMLInputElement;
  private settingsDemoMode: HTMLInputElement;
  private groupGeminiKey: HTMLElement;
  private groupOpenaiKey: HTMLElement;
  private groupOllamaUrl: HTMLElement;
  private settingsStatusMsg: HTMLElement;

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
    this.pauseBtn = document.getElementById('pause-agent-btn') as HTMLButtonElement;
    this.takeoverBtn = document.getElementById('takeover-btn') as HTMLButtonElement;
    this.modelSelect = document.getElementById('model-select') as HTMLSelectElement;
    this.workerCardsContainer = document.getElementById('worker-cards-container') as HTMLElement;
    this.evidenceFeed = document.getElementById('evidence-feed') as HTMLElement;
    this.workerCountStat = document.getElementById('worker-count-stat') as HTMLElement;
    this.tokensStat = document.getElementById('tokens-stat') as HTMLElement;
    this.costStat = document.getElementById('cost-stat') as HTMLElement;

    // Settings elements
    this.settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;
    this.settingsModal = document.getElementById('settings-modal') as HTMLElement;
    this.closeSettingsBtn = document.getElementById('close-settings-btn') as HTMLButtonElement;
    this.cancelSettingsBtn = document.getElementById('cancel-settings-btn') as HTMLButtonElement;
    this.saveSettingsBtn = document.getElementById('save-settings-btn') as HTMLButtonElement;
    this.settingsProvider = document.getElementById('settings-provider') as HTMLSelectElement;
    this.settingsGeminiKey = document.getElementById('settings-gemini-key') as HTMLInputElement;
    this.settingsOpenaiKey = document.getElementById('settings-openai-key') as HTMLInputElement;
    this.settingsOllamaUrl = document.getElementById('settings-ollama-url') as HTMLInputElement;
    this.settingsDemoMode = document.getElementById('settings-demo-mode') as HTMLInputElement;
    this.groupGeminiKey = document.getElementById('group-gemini-key') as HTMLElement;
    this.groupOpenaiKey = document.getElementById('group-openai-key') as HTMLElement;
    this.groupOllamaUrl = document.getElementById('group-ollama-url') as HTMLElement;
    this.settingsStatusMsg = document.getElementById('settings-status-msg') as HTMLElement;

    this.bindEvents();
    this.bindSettingsEvents();
    this.registerBridgeListeners();

    // Request initial snapshot from main process
    const aegis = (window as any).aegis;
    if (aegis?.requestTabsSync) {
      aegis.requestTabsSync();
    }
  }

  private registerBridgeListeners(): void {
    const aegis = (window as any).aegis;
    if (!aegis) return;

    // 1. Tab snapshot sync (Single source of truth)
    aegis.onTabsSync((snapshot: TabsSnapshot) => {
      this.currentTabs = snapshot.tabs;
      this.activeTabId = snapshot.activeTabId;
      this.renderTabs();
    });

    // 2. Tab patch update
    aegis.onTabPatch((patchData: TabPatch) => {
      const tab = this.currentTabs.find(t => t.id === patchData.id);
      if (tab) {
        Object.assign(tab, patchData.patch);
        this.updateTabElement(tab);
      }
    });

    // 3. Worker status updates
    aegis.onWorkerEvent((data: WorkerEventPayload) => {
      this.activeWorkers.set(data.id, data);
      this.renderWorkerCards();
    });

    // 4. Discovered Evidence feed
    aegis.onEvidenceEvent((data: EvidenceEventPayload) => {
      this.addEvidenceItem(data.text, data.timestamp);
    });
  }

  private renderTabs(): void {
    this.tabsContainer.replaceChildren();

    for (const tab of this.currentTabs) {
      const tabEl = document.createElement('div');
      tabEl.className = `tab ${tab.id === this.activeTabId ? 'active' : ''}`;
      tabEl.dataset.tabId = tab.id;

      // Profile badge
      const badge = document.createElement('span');
      if (tab.owner && tab.owner.startsWith('agent:')) {
        badge.className = 'profile-badge incognito';
        badge.textContent = 'Agent';
      } else {
        badge.className = 'profile-badge work';
        badge.textContent = 'Work';
      }
      tabEl.appendChild(badge);

      // Title
      const titleSpan = document.createElement('span');
      titleSpan.className = 'tab-title';
      titleSpan.textContent = sanitizeText(tab.title || 'New Tab');
      tabEl.appendChild(titleSpan);

      // Close button
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

    // Update omnibar to reflect active tab URL
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
      emptyMsg.style.cssText = 'color: var(--text-muted); font-size: 13px; text-align: center; padding: 24px 0;';
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

  private addEvidenceItem(text: string, timestamp?: string): void {
    // Remove empty state message if present
    const emptyMsg = document.getElementById('no-evidence-msg');
    if (emptyMsg) {
      emptyMsg.remove();
    }

    const item = document.createElement('div');
    item.className = 'evidence-item';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'ev-time';
    timeSpan.textContent = timestamp || new Date().toTimeString().slice(0, 8);
    item.appendChild(timeSpan);

    const textSpan = document.createElement('span');
    textSpan.className = 'ev-text';
    textSpan.textContent = sanitizeText(text);
    item.appendChild(textSpan);

    this.evidenceFeed.prepend(item);
  }

  private bindEvents(): void {
    const aegis = (window as any).aegis;

    // Window Controls
    document.getElementById('min-btn')?.addEventListener('click', () => aegis?.minimize());
    document.getElementById('max-btn')?.addEventListener('click', () => aegis?.maximize());
    document.getElementById('close-btn')?.addEventListener('click', () => aegis?.close());

    // Navigation buttons
    document.getElementById('back-btn')?.addEventListener('click', () => aegis?.goBack());
    document.getElementById('forward-btn')?.addEventListener('click', () => aegis?.goForward());
    document.getElementById('reload-btn')?.addEventListener('click', () => aegis?.reload());

    // Omnibar submit
    this.swarmRunBtn.addEventListener('click', () => this.handleOmnibarSubmit());
    this.omnibarInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleOmnibarSubmit();
    });

    // Swarm Drawer toggle
    this.drawerToggleBtn.addEventListener('click', () => {
      const isClosed = this.swarmDrawer.classList.toggle('closed');
      this.drawerToggleBtn.classList.toggle('active');
      aegis?.toggleDrawer(!isClosed, 320);
    });

    // Quick prompts click
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

    // New Tab button
    this.newTabBtn.addEventListener('click', () => {
      aegis?.createTab('https://duckduckgo.com');
    });

    // Pause Agent
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
  }

  private bindSettingsEvents(): void {
    this.settingsBtn.addEventListener('click', () => this.openSettings());
    this.closeSettingsBtn.addEventListener('click', () => this.closeSettings());
    this.cancelSettingsBtn.addEventListener('click', () => this.closeSettings());
    this.saveSettingsBtn.addEventListener('click', () => this.saveSettings());

    this.settingsProvider.addEventListener('change', () => this.updateProviderVisibility());
  }

  private async openSettings(): Promise<void> {
    const aegis = (window as any).aegis;
    if (!aegis?.getSettings) return;

    try {
      const res = await aegis.getSettings();
      const settings = res.data || res;

      if (settings) {
        this.settingsProvider.value = settings.modelProvider || 'gemini';
        this.settingsGeminiKey.value = settings.apiKeys?.gemini || '';
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
  }

  private updateProviderVisibility(): void {
    const provider = this.settingsProvider.value;
    this.groupGeminiKey.style.display = provider === 'gemini' ? 'flex' : 'none';
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
        openai: this.settingsOpenaiKey.value.trim()
      },
      ollamaBaseUrl: this.settingsOllamaUrl.value.trim() || 'http://localhost:11434',
      demoMode: this.settingsDemoMode.checked
    };

    try {
      await aegis.updateSettings(patch);
      this.settingsStatusMsg.textContent = 'Settings saved successfully!';
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

  private async handleOmnibarSubmit(): Promise<void> {
    const raw = this.omnibarInput.value.trim();
    if (!raw) return;

    const aegis = (window as any).aegis;
    const intent = OmnibarParser.parse(raw);

    // Hide welcome screen when an action or navigation begins
    const welcome = document.querySelector('.welcome-screen') as HTMLElement;
    if (welcome) welcome.style.display = 'none';

    if (intent.type === 'agent_command') {
      // Open drawer if closed
      this.swarmDrawer.classList.remove('closed');
      this.drawerToggleBtn.classList.add('active');
      aegis?.toggleDrawer(true, 320);

      this.addEvidenceItem(`Command initiated: /${intent.command} "${intent.prompt}"`);

      const model = this.modelSelect?.value || 'gemini-2.0-flash';
      if (aegis?.startMission) {
        const res = await aegis.startMission(intent.prompt, model);
        if (!res?.data?.started) {
          const reason = res?.data?.message || 'Agent runtime not configured.';
          this.addEvidenceItem(`[Notice] ${reason}`);
          if (reason.toLowerCase().includes('settings') || reason.toLowerCase().includes('api key')) {
            // Automatically prompt the settings modal so user can enter key
            this.openSettings();
          }
        }
      }
    } else if (intent.type === 'url' || intent.type === 'search') {
      const target = intent.targetUrl || raw;
      if (aegis?.navigateTab) {
        await aegis.navigateTab(target);
      }
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new BrowserApp();
});
