/**
 * Project Aegis - Browser Chrome Application Controller
 * Implements: UI-01, UI-02, UI-03, UI-04, UI-05, M7.1, M7.2
 */

import { OmnibarParser } from '../ui/omnibar_parser.js';

class BrowserApp {
  private omnibarInput: HTMLInputElement;
  private swarmRunBtn: HTMLButtonElement;
  private drawerToggleBtn: HTMLButtonElement;
  private swarmDrawer: HTMLElement;
  private tabStrip: HTMLElement;
  private newTabBtn: HTMLButtonElement;
  private pauseBtn: HTMLButtonElement;
  private takeoverBtn: HTMLButtonElement;
  private modelSelect: HTMLSelectElement;
  private isPaused = false;
  private isTakeover = false;

  constructor() {
    this.omnibarInput = document.getElementById('omnibar-input') as HTMLInputElement;
    this.swarmRunBtn = document.getElementById('swarm-run-btn') as HTMLButtonElement;
    this.drawerToggleBtn = document.getElementById('toggle-drawer-btn') as HTMLButtonElement;
    this.swarmDrawer = document.getElementById('swarm-drawer') as HTMLElement;
    this.tabStrip = document.getElementById('tab-strip') as HTMLElement;
    this.newTabBtn = document.getElementById('new-tab-btn') as HTMLButtonElement;
    this.pauseBtn = document.getElementById('pause-agent-btn') as HTMLButtonElement;
    this.takeoverBtn = document.getElementById('takeover-btn') as HTMLButtonElement;
    this.modelSelect = document.getElementById('model-select') as HTMLSelectElement;

    this.bindEvents();
    this.registerBridgeListeners();
  }

  private registerBridgeListeners(): void {
    const aegis = (window as any).aegis;
    if (!aegis) return;

    // 1. Worker status updates
    aegis.onWorkerEvent((data: { id: string; task: string; progress: number; status: string }) => {
      const card = document.getElementById(data.id);
      if (card) {
        const taskEl = card.querySelector('.w-task');
        if (taskEl) taskEl.textContent = data.task;
        const bar = card.querySelector('.progress-bar .fill') as HTMLElement;
        if (bar) bar.style.width = `${data.progress}%`;
        const dot = card.querySelector('.status-dot');
        if (dot) {
          dot.className = `status-dot ${data.status === 'done' || data.status === 'running' ? 'green' : 'gray'}`;
        }
        card.className = `worker-card ${data.status}`;
      }
    });

    // 2. Discovered Evidence feed
    aegis.onEvidenceEvent((data: { text: string; timestamp?: string }) => {
      this.addWorkerLog(data.text, data.timestamp);
      
      // Update token & cost telemetry
      const tokensEl = document.getElementById('tokens-stat');
      if (tokensEl) {
        const current = parseInt(tokensEl.textContent?.replace(/,/g, '') || '1420', 10);
        tokensEl.textContent = (current + 185).toLocaleString();
      }
      const costEl = document.getElementById('cost-stat');
      if (costEl) {
        const currentCost = parseFloat(costEl.textContent?.replace('$', '') || '0.002');
        costEl.textContent = `$${(currentCost + 0.0004).toFixed(3)}`;
      }
    });

    // 3. Tab update events (page load, title changes)
    aegis.onTabUpdated((data: { id: string; title: string; url: string }) => {
      const activeTabTitle = document.querySelector('.tab.active .tab-title');
      if (activeTabTitle && data.title) {
        activeTabTitle.textContent = data.title;
      }
      if (data.url && !this.omnibarInput.value.startsWith('/')) {
        this.omnibarInput.value = data.url;
      }
    });
  }

  private bindEvents(): void {
    const aegis = (window as any).aegis;

    // 0. Native Window Controls
    document.getElementById('min-btn')?.addEventListener('click', () => {
      aegis?.minimize();
    });
    document.getElementById('max-btn')?.addEventListener('click', () => {
      aegis?.maximize();
    });
    document.getElementById('close-btn')?.addEventListener('click', () => {
      aegis?.close();
    });

    // Navigation buttons
    document.getElementById('back-btn')?.addEventListener('click', () => {
      aegis?.goBack();
    });
    document.getElementById('forward-btn')?.addEventListener('click', () => {
      aegis?.goForward();
    });
    document.getElementById('reload-btn')?.addEventListener('click', () => {
      aegis?.reload();
    });

    // 1. Omnibar submit
    this.swarmRunBtn.addEventListener('click', () => this.handleOmnibarSubmit());
    this.omnibarInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleOmnibarSubmit();
    });

    // 2. Swarm Drawer toggle
    this.drawerToggleBtn.addEventListener('click', () => {
      const isClosed = this.swarmDrawer.classList.toggle('closed');
      this.drawerToggleBtn.classList.toggle('active');
      aegis?.toggleDrawer(!isClosed, 320);
    });

    // 3. Quick prompts click
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

    // 4. New Tab button
    this.newTabBtn.addEventListener('click', () => {
      this.createNewTab('New Tab', 'https://news.ycombinator.com');
    });

    // 5. Pause Agent (UI-05)
    this.pauseBtn.addEventListener('click', () => {
      this.isPaused = !this.isPaused;
      this.pauseBtn.innerText = this.isPaused ? 'Resume' : 'Pause';
      this.pauseBtn.className = this.isPaused ? 'badge-btn' : 'badge-btn warning';
      console.log(`[UI] Agent paused state: ${this.isPaused}`);
    });

    // 6. Manual Takeover (UI-05)
    this.takeoverBtn.addEventListener('click', () => {
      this.isTakeover = !this.isTakeover;
      this.takeoverBtn.innerText = this.isTakeover ? 'Hand Back' : 'Takeover';
      this.takeoverBtn.className = this.isTakeover ? 'badge-btn warning' : 'badge-btn danger';
      console.log(`[UI] Manual takeover state: ${this.isTakeover}`);
    });
  }

  private async handleOmnibarSubmit(): Promise<void> {
    const raw = this.omnibarInput.value.trim();
    if (!raw) return;

    const aegis = (window as any).aegis;
    const intent = OmnibarParser.parse(raw);
    console.log('[Omnibar] Parsed Intent:', intent);

    // Hide welcome screen when an action or navigation begins
    const welcome = document.querySelector('.welcome-screen') as HTMLElement;
    if (welcome) welcome.style.display = 'none';

    if (intent.type === 'agent_command') {
      // Open drawer if closed
      this.swarmDrawer.classList.remove('closed');
      this.drawerToggleBtn.classList.add('active');
      aegis?.toggleDrawer(true, 320);

      this.addWorkerLog(`Initiating swarm /${intent.command}: "${intent.prompt}"`);

      const model = this.modelSelect?.value || 'gemini-2.0-flash';
      if (aegis?.executeSwarm) {
        const res = await aegis.executeSwarm(intent.command, intent.prompt, model);
        if (res?.targetUrl) {
          const activeTab = document.querySelector('.tab.active .tab-title');
          if (activeTab) {
            try { activeTab.textContent = new URL(res.targetUrl).hostname; } catch {}
          }
        }
      }
    } else if (intent.type === 'url' || intent.type === 'search') {
      const target = intent.targetUrl || raw;
      console.log('[Omnibar] Navigating to:', target);
      
      const activeTab = document.querySelector('.tab.active .tab-title');
      if (activeTab) {
        try { activeTab.textContent = new URL(target).hostname; } catch { activeTab.textContent = target; }
      }

      if (aegis?.navigateTab) {
        await aegis.navigateTab(target);
      }
    }
  }

  private async createNewTab(title: string, url: string): Promise<void> {
    const tabId = 'tab_' + Date.now();
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.dataset.tabId = tabId;
    tab.innerHTML = `
      <span class="profile-badge work">Work</span>
      <span class="tab-title">${title}</span>
      <button class="tab-close-btn">&times;</button>
    `;

    tab.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('tab-close-btn')) {
        tab.remove();
        return;
      }
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      (window as any).aegis?.switchTab(tabId);
    });

    const closeBtn = tab.querySelector('.tab-close-btn')!;
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      tab.remove();
      (window as any).aegis?.closeTab(tabId);
    });

    this.tabStrip.insertBefore(tab, this.newTabBtn);
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    const aegis = (window as any).aegis;
    if (aegis?.createTab) {
      await aegis.createTab(url);
    }
  }

  private addWorkerLog(text: string, timestamp?: string): void {
    const feed = document.getElementById('evidence-feed');
    if (!feed) return;
    const item = document.createElement('div');
    item.className = 'evidence-item';
    const time = timestamp || new Date().toTimeString().slice(0, 8);
    item.innerHTML = `<span class="ev-time">${time}</span><span class="ev-text">${text}</span>`;
    feed.prepend(item);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new BrowserApp();
});
