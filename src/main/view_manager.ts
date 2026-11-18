import { WebContentsView, BrowserWindow } from 'electron';
import { ActionExecutor } from '../core/action_executor.js';
import { CURSOR_OVERLAY_SCRIPT } from '../stealth/cursor_overlay.js';
import { TabState, TabsSnapshot, TabPatch, IPC_CHANNELS } from '../ipc/contract.js';
import { rootLogger } from '../infrastructure/logger.js';

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

  constructor(window: BrowserWindow) {
    this.window = window;
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
      owner: isBackgroundAgent ? (owner.startsWith('agent:') ? owner : `agent:${owner}`) : 'user'
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

      wc.executeJavaScript(CURSOR_OVERLAY_SCRIPT).catch(() => {});

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
    });

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

  public setDrawerWidth(width: number): void {
    this.drawerWidth = width;
    this.relayout();
  }

  public relayout(): void {
    const bounds = this.window.getBounds();
    if (!this.activeTabId) return;

    const activeTab = this.tabs.get(this.activeTabId);
    if (!activeTab) return;

    const contentWidth = Math.max(200, bounds.width - this.drawerWidth);
    const contentHeight = Math.max(200, bounds.height - this.topChromeHeight);

    try {
      activeTab.view.setBounds({
        x: 0,
        y: this.topChromeHeight,
        width: contentWidth,
        height: contentHeight
      });
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
