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

    this.bindEvents();
  }

  private bindEvents(): void {
    // 0. Native Window Controls
    document.getElementById('min-btn')?.addEventListener('click', () => {
      (window as any).aegis?.minimize();
    });
    document.getElementById('max-btn')?.addEventListener('click', () => {
      (window as any).aegis?.maximize();
    });
    document.getElementById('close-btn')?.addEventListener('click', () => {
      (window as any).aegis?.close();
    });

    // 1. Omnibar submit
    this.swarmRunBtn.addEventListener('click', () => this.handleOmnibarSubmit());
    this.omnibarInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleOmnibarSubmit();
    });

    // 2. Swarm Drawer toggle
    this.drawerToggleBtn.addEventListener('click', () => {
      this.swarmDrawer.classList.toggle('closed');
      this.drawerToggleBtn.classList.toggle('active');
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

  private handleOmnibarSubmit(): void {
    const raw = this.omnibarInput.value;
    const intent = OmnibarParser.parse(raw);
    console.log('[Omnibar] Parsed Intent:', intent);

    if (intent.type === 'agent_command') {
      // Add worker card or trigger coordinator
      this.addWorkerLog(`Started command: /${intent.command} "${intent.prompt}"`);
      // Open drawer if closed
      this.swarmDrawer.classList.remove('closed');
      this.drawerToggleBtn.classList.add('active');
    } else if (intent.type === 'url' || intent.type === 'search') {
      const target = intent.targetUrl || '';
      console.log('[Omnibar] Navigating to:', target);
      // Update active tab title
      const activeTab = document.querySelector('.tab.active .tab-title');
      if (activeTab) {
        try { activeTab.textContent = new URL(target).hostname; } catch { activeTab.textContent = target; }
      }
    }
  }

  private createNewTab(title: string, url: string): void {
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
    });

    const closeBtn = tab.querySelector('.tab-close-btn')!;
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      tab.remove();
    });

    this.tabStrip.insertBefore(tab, this.newTabBtn);
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
  }

  private addWorkerLog(text: string): void {
    const feed = document.getElementById('evidence-feed');
    if (!feed) return;
    const item = document.createElement('div');
    item.className = 'evidence-item';
    const time = new Date().toTimeString().slice(0, 8);
    item.innerHTML = `<span class="ev-time">${time}</span><span class="ev-text">${text}</span>`;
    feed.prepend(item);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new BrowserApp();
});
