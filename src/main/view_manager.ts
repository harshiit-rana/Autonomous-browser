import { WebContentsView, BaseWindow } from 'electron';
import { ActionExecutor } from '../core/action_executor.js';

export interface TabView {
  id: string;
  view: WebContentsView;
  executor: ActionExecutor;
  url: string;
  title: string;
  isLoading: boolean;
  isBackgroundAgent: boolean;
}

/**
 * ViewManager
 * Oversees all active and background WebContentsView instances.
 * Implements the dual-layer architecture:
 * - Active view is mounted to the host window below the browser chrome.
 * - Background agent worker tabs run unattached to the visible frame, avoiding screen conflicts.
 */
export class ViewManager {
  private window: BaseWindow;
  private tabs: Map<string, TabView> = new Map();
  private activeTabId: string | null = null;
  private topChromeHeight: number = 72;
  private drawerWidth: number = 0;

  constructor(window: BaseWindow) {
    this.window = window;
  }

  public createTab(url: string, isBackgroundAgent: boolean = false): TabView {
    const id = `tab_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true
      }
    });

    const executor = new ActionExecutor(view.webContents);
    const tab: TabView = {
      id,
      view,
      executor,
      url,
      title: 'New Tab',
      isLoading: true,
      isBackgroundAgent
    };

    view.webContents.on('did-start-loading', () => {
      tab.isLoading = true;
    });

    view.webContents.on('did-finish-load', () => {
      tab.isLoading = false;
      tab.title = view.webContents.getTitle();
      tab.url = view.webContents.getURL();
    });

    view.webContents.loadURL(url);
    this.tabs.set(id, tab);

    if (!isBackgroundAgent && !this.activeTabId) {
      this.setActiveTab(id);
    }

    return tab;
  }

  public setActiveTab(id: string): void {
    const targetTab = this.tabs.get(id);
    if (!targetTab) return;

    if (this.activeTabId && this.tabs.has(this.activeTabId)) {
      const currentTab = this.tabs.get(this.activeTabId)!;
      try {
        this.window.contentView.removeChildView(currentTab.view);
      } catch {}
    }

    this.activeTabId = id;
    this.window.contentView.addChildView(targetTab.view);
    this.relayout();
  }

  public closeTab(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;

    if (this.activeTabId === id) {
      try {
        this.window.contentView.removeChildView(tab.view);
      } catch {}
      this.activeTabId = null;
    }

    tab.executor.detachCDP();
    (tab.view.webContents as any).destroy?.();
    this.tabs.delete(id);

    // Switch to adjacent tab if active tab was closed
    if (!this.activeTabId && this.tabs.size > 0) {
      const firstId = this.tabs.keys().next().value;
      if (firstId) this.setActiveTab(firstId);
    }
  }

  public setDrawerWidth(width: number): void {
    this.drawerWidth = width;
    this.relayout();
  }

  public relayout(): void {
    if (!this.activeTabId) return;
    const activeTab = this.tabs.get(this.activeTabId);
    if (!activeTab) return;

    const bounds = this.window.getBounds();
    const contentWidth = Math.max(200, bounds.width - this.drawerWidth);
    const contentHeight = Math.max(200, bounds.height - this.topChromeHeight);

    activeTab.view.setBounds({
      x: 0,
      y: this.topChromeHeight,
      width: contentWidth,
      height: contentHeight
    });
  }

  public getTab(id: string): TabView | undefined {
    return this.tabs.get(id);
  }

  public listTabs(): TabView[] {
    return Array.from(this.tabs.values());
  }
}
