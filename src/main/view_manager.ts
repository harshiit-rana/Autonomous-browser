import { WebContentsView, BrowserWindow } from 'electron';
import { ActionExecutor } from '../core/action_executor.js';
import { TabState, TabsSnapshot, TabPatch, IPC_CHANNELS, SwarmPreviewItem, PresenceEventPayload } from '../ipc/contract.js';
import { rootLogger } from '../infrastructure/logger.js';
import { TabGroupManager } from '../browser/tab_group_manager.js';
import { PopupManager } from '../browser/popup_manager.js';
import { ErrorPageRenderer } from '../browser/error_pages.js';

export interface TabView {
  id: string;
  view: WebContentsView;
  executor: ActionExecutor;
  state: TabState;
  openerId?: string;
}

const logger = rootLogger.child('view-manager');

export class ViewManager {
  private window: BrowserWindow;
  private tabs: Map<string, TabView> = new Map();
  private tabOrder: string[] = [];
  private activeTabId: string | null = null;
  private topChromeHeight: number = 88;
  private drawerWidth: number = 320;
  private layoutMode: 'stage' | 'grid' | 'theatre' = 'stage';
  private isOverlayActive: boolean = false;
  private tabGroupManager: TabGroupManager = new TabGroupManager();
  private popupManager: PopupManager = new PopupManager();

  constructor(window: BrowserWindow) {
    this.window = window;
  }

  public getTabGroupManager(): TabGroupManager {
    return this.tabGroupManager;
  }

  public getPopupManager(): PopupManager {
    return this.popupManager;
  }

  public createTab(url: string = 'https://duckduckgo.com', isBackgroundAgent: boolean = false, owner: string = 'user'): TabView {
    const id = `tab_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    logger.info('Creating tab', { id, url, isBackgroundAgent, owner });

    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true
      }
    });

    const executor = new ActionExecutor(view.webContents);
    const state: TabState = {
      id,
      url,
      title: 'New Tab',
      isLoading: true,
      canGoBack: false,
      canGoForward: false,
      isAudible: false,
      isCrashed: false,
      // An explicit `agent:<missionId>` owner is kept for foreground tabs too (agent-opened tabs and their popups, #225).
      owner: owner.startsWith('agent:') ? owner : (isBackgroundAgent ? `agent:${owner}` : 'user')
    };

    const tab: TabView = {
      id,
      view,
      executor,
      state,
      openerId: this.activeTabId || undefined
    };

    this.tabs.set(id, tab);
    this.tabOrder.push(id);

    this.wireWebContentsEvents(tab);

    if (url) {
      view.webContents.loadURL(url).catch((err) => {
        logger.warn('Failed to load initial tab URL', { id, url, error: err.message });
      });
    }

    if (!isBackgroundAgent) {
      this.setActiveTab(id);
    } else {
      this.broadcastTabsSnapshot();
    }

    return tab;
  }

  private wireWebContentsEvents(tab: TabView): void {
    const wc = tab.view.webContents;
    const id = tab.id;

    wc.on('did-start-loading', () => {
      tab.state.isLoading = true;
      this.broadcastTabPatch(id, { isLoading: true });
    });

    wc.on('did-stop-loading', () => {
      tab.state.isLoading = false;
      this.broadcastTabPatch(id, { isLoading: false });
    });

    wc.on('did-finish-load', () => {
      tab.state.isLoading = false;
      tab.state.title = wc.getTitle() || tab.state.title;
      tab.state.url = wc.getURL() || tab.state.url;
      tab.state.canGoBack = wc.navigationHistory.canGoBack();
      tab.state.canGoForward = wc.navigationHistory.canGoForward();

      this.broadcastTabPatch(id, {
        isLoading: false,
        title: tab.state.title,
        url: tab.state.url,
        canGoBack: tab.state.canGoBack,
        canGoForward: tab.state.canGoForward
      });
    });

    wc.on('did-navigate', (_, url) => {
      tab.state.url = url;
      tab.state.canGoBack = wc.navigationHistory.canGoBack();
      tab.state.canGoForward = wc.navigationHistory.canGoForward();
      this.broadcastTabPatch(id, {
        url,
        canGoBack: tab.state.canGoBack,
        canGoForward: tab.state.canGoForward
      });
    });

    wc.on('did-navigate-in-page', (_, url) => {
      tab.state.url = url;
      tab.state.canGoBack = wc.navigationHistory.canGoBack();
      tab.state.canGoForward = wc.navigationHistory.canGoForward();
      this.broadcastTabPatch(id, {
        url,
        canGoBack: tab.state.canGoBack,
        canGoForward: tab.state.canGoForward
      });
    });

    wc.on('page-title-updated', (_, title) => {
      tab.state.title = title;
      this.broadcastTabPatch(id, { title });
    });

    wc.on('page-favicon-updated', (_, favicons) => {
      if (favicons && favicons.length > 0) {
        tab.state.favicon = favicons[0];
        this.broadcastTabPatch(id, { favicon: tab.state.favicon });
      }
    });

    wc.on('did-fail-load', (_, errorCode, errorDescription, validatedURL) => {
      logger.warn('Tab load failed', { id, errorCode, errorDescription, validatedURL });
      tab.state.isLoading = false;
      this.broadcastTabPatch(id, { isLoading: false });

      // Render native error page unless error is normal navigation cancel (errorCode -3)
      if (errorCode !== -3 && validatedURL && !validatedURL.startsWith('data:')) {
        const html = ErrorPageRenderer.renderErrorPage({
          errorCode: `ERR_${errorCode}`,
          errorDescription,
          failedUrl: validatedURL
        });
        wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
      }
    });

    try {
      wc.setWindowOpenHandler((details) => {
        const decision = this.popupManager.evaluateWindowOpen({
          url: details.url,
          frameName: details.frameName,
          features: details.features,
          disposition: details.disposition
        });

        if (decision.action === 'adopt_tab') {
          this.createTab(details.url, false, tab.state.owner);
          return { action: 'deny' };
        } else if (decision.action === 'open_oauth_window') {
          return {
            action: 'allow',
            overrideBrowserWindowOptions: {
              width: decision.features?.width || 600,
              height: decision.features?.height || 700,
              modal: true,
              parent: this.window
            }
          };
        } else {
          return { action: 'deny' };
        }
      });
    } catch {}

    wc.on('render-process-gone', (_, details) => {
      logger.error('Tab renderer process gone', undefined, { id, details });
      tab.state.isCrashed = true;
      tab.state.isLoading = false;
      this.broadcastTabPatch(id, { isCrashed: true, isLoading: false, title: 'Crashed' });
    });

    wc.on('unresponsive', () => {
      logger.warn('Tab webContents became unresponsive', { id });
    });
  }

  public getActiveTab(): TabView | undefined {
    return this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
  }

  public navigateActiveTab(url: string): TabView {
    let tab = this.getActiveTab();
    if (!tab) {
      tab = this.createTab(url, false);
    } else {
      tab.state.url = url;
      tab.state.isLoading = true;
      this.broadcastTabPatch(tab.id, { url, isLoading: true });
      tab.view.webContents.loadURL(url).catch((err) => {
        logger.warn('Navigation error', { tabId: tab?.id, url, error: err.message });
      });
    }
    return tab;
  }

  public setActiveTab(id: string): void {
    const targetTab = this.tabs.get(id);
    if (!targetTab) return;

    if (this.activeTabId === id) {
      this.relayout();
      return;
    }

    if (this.activeTabId && this.tabs.has(this.activeTabId)) {
      const currentTab = this.tabs.get(this.activeTabId)!;
      try {
        this.window.contentView.removeChildView(currentTab.view);
      } catch {}
    }

    this.activeTabId = id;
    try {
      this.window.contentView.addChildView(targetTab.view);
    } catch {}

    this.relayout();
    this.broadcastTabsSnapshot();
  }

  public closeTab(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;

    logger.info('Closing tab', { id });

    const closedIndex = this.tabOrder.indexOf(id);
    const wasActive = this.activeTabId === id;

    if (wasActive) {
      try {
        this.window.contentView.removeChildView(tab.view);
      } catch {}
      this.activeTabId = null;
    }

    tab.executor.detachCDP();
    try {
      (tab.view.webContents as any).close?.();
    } catch {}

    this.tabGroupManager.closeTab(id);
    this.tabs.delete(id);
    if (closedIndex !== -1) {
      this.tabOrder.splice(closedIndex, 1);
    }

    // Determine neighbor tab if the active tab was closed
    if (wasActive) {
      if (this.tabOrder.length > 0) {
        // Pick neighbor: next if available, else previous
        const nextIndex = Math.min(closedIndex, this.tabOrder.length - 1);
        const nextId = this.tabOrder[nextIndex];
        this.setActiveTab(nextId);
      } else {
        // All tabs closed -> create new blank/default tab
        this.createTab('https://duckduckgo.com', false);
      }
    } else {
      this.broadcastTabsSnapshot();
    }
  }

  public reopenClosedTab(): TabView | undefined {
    const restored = this.tabGroupManager.reopenLastClosedTab();
    if (!restored) return undefined;
    return this.createTab(restored.url, false, restored.owner);
  }

  public duplicateTab(id: string): TabView | undefined {
    const tab = this.tabs.get(id);
    if (!tab) return undefined;
    return this.createTab(tab.state.url, false, tab.state.owner);
  }

  public setDrawerWidth(width: number): void {
    this.drawerWidth = width;
    this.relayout();
  }

  public setLayoutMode(mode: 'stage' | 'grid' | 'theatre'): void {
    logger.info('Setting layout mode', { mode });
    this.layoutMode = mode;
    this.relayout();
  }

  public setOverlayActive(active: boolean): void {
    this.isOverlayActive = active;
    this.relayout();
  }

  public relayout(): void {
    const bounds = this.window.getBounds();
    if (!this.activeTabId) return;

    const activeTab = this.tabs.get(this.activeTabId);
    if (!activeTab) return;

    // Issue #138: If modal overlay is active or grid mode is active,
    // shrink native WebContentsView to 0x0 so renderer DOM is never occluded.
    if (this.isOverlayActive || this.layoutMode === 'grid') {
      try {
        activeTab.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      } catch {}
      return;
    }

    const contentWidth = Math.max(200, bounds.width - this.drawerWidth);
    const contentHeight = Math.max(200, bounds.height - this.topChromeHeight);

    try {
      if (this.layoutMode === 'theatre') {
        // Centered cinematic view with focus borders
        activeTab.view.setBounds({
          x: 24,
          y: this.topChromeHeight + 12,
          width: Math.max(200, contentWidth - 48),
          height: Math.max(200, contentHeight - 24)
        });
      } else {
        // Standard Stage layout
        activeTab.view.setBounds({
          x: 0,
          y: this.topChromeHeight,
          width: contentWidth,
          height: contentHeight
        });
      }
    } catch {}
  }

  public async getSwarmPreviews(): Promise<SwarmPreviewItem[]> {
    const items: SwarmPreviewItem[] = [];
    for (const id of this.tabOrder) {
      const tab = this.tabs.get(id);
      if (!tab) continue;

      let thumbnailBase64: string | undefined = undefined;
      try {
        const image = await tab.view.webContents.capturePage();
        if (!image.isEmpty()) {
          const resized = image.resize({ width: 320 });
          thumbnailBase64 = resized.toDataURL();
        }
      } catch {}

      items.push({
        tabId: tab.id,
        title: tab.state.title,
        url: tab.state.url,
        owner: tab.state.owner,
        thumbnailBase64,
        isActive: tab.id === this.activeTabId
      });
    }
    return items;
  }

  public broadcastPresence(payload: PresenceEventPayload): void {
    try {
      if (!this.window.isDestroyed()) {
        this.window.webContents.send(IPC_CHANNELS.EVENT_PRESENCE, payload);
      }
    } catch {}
  }

  public getSnapshot(): TabsSnapshot {
    const tabs: TabState[] = this.tabOrder
      .map(id => this.tabs.get(id)?.state)
      .filter((s): s is TabState => !!s);

    return {
      tabs,
      activeTabId: this.activeTabId
    };
  }

  public broadcastTabsSnapshot(): void {
    try {
      if (!this.window.isDestroyed()) {
        const snapshot = this.getSnapshot();
        this.window.webContents.send(IPC_CHANNELS.EVENT_TABS_SYNC, snapshot);
      }
    } catch {}
  }

  public broadcastTabPatch(id: string, patch: Partial<TabState>): void {
    try {
      if (!this.window.isDestroyed()) {
        const payload: TabPatch = { id, patch };
        this.window.webContents.send(IPC_CHANNELS.EVENT_TAB_PATCH, payload);
      }
    } catch {}
  }

  public getTab(id: string): TabView | undefined {
    return this.tabs.get(id);
  }

  public listTabs(): TabView[] {
    return this.tabOrder.map(id => this.tabs.get(id)).filter((t): t is TabView => !!t);
  }
}
