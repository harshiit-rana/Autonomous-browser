import { WebContentsView, BrowserWindow } from 'electron';
import { ActionExecutor } from '../core/action_executor.js';
import {
  TabState, TabsSnapshot, TabPatch, IPC_CHANNELS, PresenceEvent,
  GridSource, GridSourcesPayload, LayoutRect, LayoutReport, WorkerPresentation
} from '../ipc/contract.js';
import { rootLogger } from '../infrastructure/logger.js';
import { TabGroupManager } from '../browser/tab_group_manager.js';
import { PopupManager } from '../browser/popup_manager.js';
import { ErrorPageRenderer } from '../browser/error_pages.js';
import { FrameHub, electronFrameSource } from './frame_hub.js';
import { parseLayoutReport, tilesById, tileZoomFactor } from './grid_layout.js';
import { workerViews, WorkerViewRegistry, LiveWorkerView } from '../swarm/worker_view_registry.js';
import type { WorkerEvent } from '../swarm/worker_host.js';
import type { ExecutorPresence } from '../core/action_executor.js';
import { PresenceLayer } from './presence_layer.js';
import { electronDisplays, electronOverlayFactory } from './presence_window.js';

export interface TabView {
  id: string;
  view: WebContentsView;
  executor: ActionExecutor;
  state: TabState;
  openerId?: string;
}

interface WorkerEntry {
  worker: LiveWorkerView;
  crashed: boolean;
  loading: boolean;
  cleanups: Array<() => void>;
}

const logger = rootLogger.child('view-manager');

/** Default layout viewport of a worker when its host does not say (WorkerHost default). */
const DEFAULT_WORKER_VIEWPORT = { width: 1280, height: 800 };

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

  // Live Grid (#232)
  public readonly frameHub: FrameHub = new FrameHub();
  private workers: Map<string, WorkerEntry> = new Map();
  /** Views this manager added to the window (the only code that adds/removes child views, ADR 0012). */
  private attached = new Set<WebContentsView>();
  private presentation = new Map<string, WorkerPresentation>();
  private stagedWorkerId: string | null = null;
  private lastReport: LayoutReport | null = null;
  private lastReportSeq = 0;
  private gridBroadcastTimer: NodeJS.Timeout | null = null;
  private registry: WorkerViewRegistry;
  /** Click-through window that draws the agents' cursors above the native views (#233, ADR 0011). Not part of the view stack. */
  public readonly presence: PresenceLayer;
  private presenceSeq = 0;

  constructor(window: BrowserWindow, registry: WorkerViewRegistry = workerViews) {
    this.window = window;
    this.registry = registry;
    this.presence = new PresenceLayer(window, { createOverlay: electronOverlayFactory(window), displays: electronDisplays() });
    const onAdded = (w: LiveWorkerView) => this.addWorker(w);
    const onRemoved = (w: LiveWorkerView) => this.removeWorker(w.id);
    registry.on('added', onAdded);
    registry.on('removed', onRemoved);
    for (const w of registry.list()) this.addWorker(w);
    window.once('closed', () => {
      registry.removeListener('added', onAdded);
      registry.removeListener('removed', onRemoved);
      this.frameHub.dispose();
    });
  }

  public getTabGroupManager(): TabGroupManager {
    return this.tabGroupManager;
  }

  public getPopupManager(): PopupManager {
    return this.popupManager;
  }

  // ------------------------------------------------------------------------------------------- child views
  private ensureAttached(view: WebContentsView): void {
    if (this.attached.has(view) || this.window.isDestroyed()) return;
    try {
      this.window.contentView.addChildView(view);
      this.attached.add(view);
    } catch {}
  }

  private detachView(view: WebContentsView): void {
    if (!this.attached.has(view)) return;
    this.attached.delete(view);
    try {
      this.window.contentView.removeChildView(view);
    } catch {}
  }

  /** ADR 0012: a view that should not be seen is hidden with setVisible(false), never shrunk to 0x0. */
  private setViewVisible(view: WebContentsView, visible: boolean): void {
    try { view.setVisible(visible); } catch {}
  }

  private present(id: string, p: WorkerPresentation): void {
    if (this.presentation.get(id) === p) return;
    this.presentation.set(id, p);
    this.frameHub.setPresentation(id, p);
    this.scheduleGridBroadcast();
  }

  // ------------------------------------------------------------------------------------------- tabs
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
    this.frameHub.addSource(electronFrameSource(id, view.webContents, executor));
    this.presentation.set(id, 'parked');
    executor.setPresenceSink((e) => this.stampPresence(id, view.webContents, e, { name: tab.state.owner.startsWith('agent:') ? 'Agent' : 'Agent', color: '#7C5CFF' }));

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
      if (this.layoutMode === 'grid') this.relayout();
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
      const recovered = tab.state.isCrashed;
      tab.state.isCrashed = false;

      this.broadcastTabPatch(id, {
        isLoading: false,
        title: tab.state.title,
        url: tab.state.url,
        canGoBack: tab.state.canGoBack,
        canGoForward: tab.state.canGoForward,
        ...(recovered ? { isCrashed: false } : {})
      });
      if (recovered) this.relayout();
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
      // The crashed page shows nothing: hide it so its tile shows the last frame with a badge.
      this.relayout();
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
    this.stagedWorkerId = null;

    if (this.activeTabId === id) {
      this.relayout();
      return;
    }

    this.activeTabId = id;
    this.ensureAttached(targetTab.view);
    this.relayout();
    this.broadcastTabsSnapshot();
  }

  public closeTab(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;

    logger.info('Closing tab', { id });

    const closedIndex = this.tabOrder.indexOf(id);
    const wasActive = this.activeTabId === id;

    // Frames first: the hub must stop using the page's debugger session before the executor detaches it.
    this.frameHub.removeSource(id);
    this.presentation.delete(id);
    tab.executor.setPresenceSink(null);
    this.presence.removeWorker(id);
    this.detachView(tab.view);
    if (wasActive) this.activeTabId = null;

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
      this.relayout();
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

  // ------------------------------------------------------------------------------------------- workers (#232)
  private addWorker(worker: LiveWorkerView): void {
    if (this.workers.has(worker.id)) return;
    const wc = worker.webContents;
    const entry: WorkerEntry = { worker, crashed: false, loading: false, cleanups: [] };
    this.workers.set(worker.id, entry);
    this.frameHub.addSource(electronFrameSource(worker.id, wc, worker.executor));
    this.presentation.set(worker.id, 'parked');
    worker.executor.setPresenceSink((e) => this.stampPresence(worker.id, wc, e, { name: worker.identity.name, color: worker.identity.color, glyph: worker.identity.glyph }));
    // Attached from the start (ADR 0010 decision 1); hidden until the Grid or the Stage shows it.
    this.setViewVisible(worker.view, false);
    this.ensureAttached(worker.view);

    const onEvent = (e: WorkerEvent) => {
      if (e.type === 'render-process-gone') { entry.crashed = true; this.relayout(); }
      else if (e.type === 'recovered') { entry.crashed = false; this.relayout(); }
      this.scheduleGridBroadcast();
    };
    worker.on('event', onEvent);
    entry.cleanups.push(() => worker.off('event', onEvent));
    const touch = () => this.scheduleGridBroadcast();
    const onStart = () => { entry.loading = true; touch(); };
    const onStop = () => { entry.loading = false; touch(); };
    for (const [ev, fn] of [['did-start-loading', onStart], ['did-stop-loading', onStop], ['page-title-updated', touch], ['did-navigate', touch]] as const) {
      try { wc.on(ev as any, fn as any); entry.cleanups.push(() => { try { wc.removeListener(ev as any, fn as any); } catch {} }); } catch {}
    }
    logger.info('Worker view registered for the Grid', { workerId: worker.id });
    this.relayout();
    this.scheduleGridBroadcast();
  }

  /** Runs synchronously from the registry, before the worker's teardown detaches CDP and closes the contents. */
  private removeWorker(id: string): void {
    const entry = this.workers.get(id);
    if (!entry) return;
    this.frameHub.removeSource(id);
    this.presentation.delete(id);
    entry.worker.executor.setPresenceSink(null);
    this.presence.removeWorker(id);
    for (const c of entry.cleanups.splice(0)) c();
    this.setViewVisible(entry.worker.view, false);
    this.detachView(entry.worker.view);
    this.workers.delete(id);
    if (this.stagedWorkerId === id) this.stagedWorkerId = null;
    this.relayout();
    this.scheduleGridBroadcast();
  }

  /** Click on a Grid tile: show that source on the Stage without reloading it (#232 step 4). */
  public promote(id: string): boolean {
    if (this.tabs.has(id)) {
      this.layoutMode = 'stage';
      this.setActiveTab(id);
      this.scheduleGridBroadcast();
      return true;
    }
    if (this.workers.has(id)) {
      this.stagedWorkerId = id;
      this.layoutMode = 'stage';
      this.relayout();
      this.scheduleGridBroadcast();
      return true;
    }
    return false;
  }

  private workerViewport(w: LiveWorkerView): { width: number; height: number } {
    const vp = (w as any).viewport;
    return vp && vp.width > 0 && vp.height > 0 ? vp : DEFAULT_WORKER_VIEWPORT;
  }

  private setWorkerZoom(w: LiveWorkerView, factor: number): void {
    try {
      if (!w.webContents.isDestroyed() && Math.abs(w.webContents.getZoomFactor() - factor) > 0.001) w.webContents.setZoomFactor(factor);
    } catch {}
  }

  /** A worker that is not shown keeps its full layout viewport (bounds = viewport, zoom 1) while hidden. */
  private parkWorker(entry: WorkerEntry): void {
    const w = entry.worker;
    this.setViewVisible(w.view, false);
    const vp = this.workerViewport(w);
    try { w.view.setBounds({ x: 0, y: 0, width: vp.width, height: vp.height }); } catch {}
    this.setWorkerZoom(w, 1);
    this.present(w.id, 'parked');
  }

  // ------------------------------------------------------------------------------------------- layout
  public setDrawerWidth(width: number): void {
    this.drawerWidth = width;
    this.relayout();
  }

  public setLayoutMode(mode: 'stage' | 'grid' | 'theatre'): void {
    logger.info('Setting layout mode', { mode });
    this.layoutMode = mode;
    if (mode === 'grid') this.stagedWorkerId = null;
    this.relayout();
    this.scheduleGridBroadcast();
  }

  public getLayoutMode(): 'stage' | 'grid' | 'theatre' {
    return this.layoutMode;
  }

  public setOverlayActive(active: boolean): void {
    this.isOverlayActive = active;
    this.relayout();
  }

  /** `layout:report` from the chrome renderer (ADR 0012). Only the newest seq is applied. */
  public applyLayoutReport(raw: unknown): boolean {
    const report = parseLayoutReport(raw, this.lastReportSeq);
    if (!report) return false;
    this.lastReportSeq = report.seq;
    this.lastReport = report;
    if (this.layoutMode === 'grid') this.relayout();
    return true;
  }

  /** The chrome renderer reloaded: its layout reports start again from seq 1 and it starts in Stage. */
  public resetRendererState(): void {
    this.lastReportSeq = 0;
    this.lastReport = null;
    this.layoutMode = 'stage';
    this.stagedWorkerId = null;
    this.relayout();
  }

  public setWindowMinimised(minimised: boolean): void {
    this.frameHub.setWindowMinimised(minimised);
    this.scheduleGridBroadcast();
  }

  /** Adds identity, sequence, time and the page's live zoom factor to what an executor reported, and hands it to the layer. */
  private stampPresence(workerId: string, wc: Electron.WebContents, e: ExecutorPresence, who: { name?: string; color?: string; glyph?: string }): void {
    let zoom = 1;
    try { zoom = wc.isDestroyed() ? 1 : wc.getZoomFactor(); } catch {}
    this.presence.emit({ workerId, seq: ++this.presenceSeq, ts: Date.now(), zoom, ...who, ...e });
  }

  /** Tell the presence layer where every page view is, and that parked/hidden ones are not (nothing may be drawn over them). */
  private syncPresenceRects(): void {
    const views: Array<[string, WebContentsView]> = [
      ...[...this.tabs.values()].map(t => [t.id, t.view] as [string, WebContentsView]),
      ...[...this.workers.values()].map(e => [e.worker.id, e.worker.view] as [string, WebContentsView])
    ];
    for (const [id, view] of views) {
      const shown = this.presentation.get(id) === 'visible' && !this.isOverlayActive;
      let rect: LayoutRect | null = null;
      if (shown) { try { const b = view.getBounds(); rect = { x: b.x, y: b.y, width: b.width, height: b.height }; } catch {} }
      this.presence.setViewRect(id, rect);
    }
  }

  public relayout(): void {
    this.doRelayout();
    this.syncPresenceRects();
  }

  private doRelayout(): void {
    if (this.window.isDestroyed()) return;

    // Issue #138 / ADR 0012: while a DOM modal is open no native view may cover it; hide them all (setVisible).
    if (this.isOverlayActive) {
      for (const tab of this.tabs.values()) { this.setViewVisible(tab.view, false); this.present(tab.id, 'parked'); }
      for (const entry of this.workers.values()) this.parkWorker(entry);
      return;
    }

    if (this.layoutMode === 'grid') {
      this.layoutGrid();
      return;
    }

    const bounds = this.window.getBounds();
    const contentWidth = Math.max(200, bounds.width - this.drawerWidth);
    const contentHeight = Math.max(200, bounds.height - this.topChromeHeight);
    const stageRect: LayoutRect = this.layoutMode === 'theatre'
      // Centered cinematic view with focus borders
      ? { x: 24, y: this.topChromeHeight + 12, width: Math.max(200, contentWidth - 48), height: Math.max(200, contentHeight - 24) }
      // Standard Stage layout
      : { x: 0, y: this.topChromeHeight, width: contentWidth, height: contentHeight };

    const staged = this.stagedWorkerId ? this.workers.get(this.stagedWorkerId) : undefined;
    for (const tab of this.tabs.values()) {
      const show = !staged && tab.id === this.activeTabId;
      if (show) {
        this.ensureAttached(tab.view);
        try { tab.view.setBounds(stageRect); } catch {}
      }
      this.setViewVisible(tab.view, show);
      this.present(tab.id, show ? 'visible' : 'parked');
    }
    for (const entry of this.workers.values()) {
      if (entry === staged && !entry.crashed) {
        this.setWorkerZoom(entry.worker, 1);
        try { entry.worker.view.setBounds(stageRect); } catch {}
        this.setViewVisible(entry.worker.view, true);
        this.present(entry.worker.id, 'visible');
      } else {
        this.parkWorker(entry);
      }
    }
  }

  /** Grid (ADR 0010 / 0012): every source whose tile frame is fully on screen is its own live native view there. */
  private layoutGrid(): void {
    const content = this.window.getContentBounds();
    const tiles = tilesById(this.lastReport?.mode === 'grid' ? this.lastReport : null, content);
    for (const tab of this.tabs.values()) {
      const rect = tiles.get(tab.id);
      if (rect && !tab.state.isCrashed) {
        this.ensureAttached(tab.view);
        // User tabs share the default session, where zoom is stored per host and persists: never zoom them.
        try { tab.view.setBounds(rect); } catch {}
        this.setViewVisible(tab.view, true);
        this.present(tab.id, 'visible');
      } else {
        this.setViewVisible(tab.view, false);
        this.present(tab.id, 'parked');
      }
    }
    for (const entry of this.workers.values()) {
      const rect = tiles.get(entry.worker.id);
      if (rect && !entry.crashed) {
        const w = entry.worker;
        this.ensureAttached(w.view);
        this.setWorkerZoom(w, tileZoomFactor(rect.width, this.workerViewport(w).width));
        try { w.view.setBounds(rect); } catch {}
        this.setViewVisible(w.view, true);
        this.present(w.id, 'visible');
      } else {
        this.parkWorker(entry);
      }
    }
  }

  // ------------------------------------------------------------------------------------------- grid sources
  public getGridSources(): GridSource[] {
    const out: GridSource[] = [];
    const staged = this.stagedWorkerId;
    for (const id of this.tabOrder) {
      const tab = this.tabs.get(id);
      if (!tab) continue;
      out.push({
        id, kind: 'tab', title: tab.state.title, url: tab.state.url, owner: tab.state.owner,
        presentation: this.presentation.get(id) || 'parked', crashed: !!tab.state.isCrashed, loading: !!tab.state.isLoading,
        isActive: id === this.activeTabId, staged: !staged && id === this.activeTabId && this.layoutMode !== 'grid'
      });
    }
    for (const entry of this.workers.values()) {
      const w = entry.worker;
      const wc = w.webContents;
      const gone = wc.isDestroyed();
      out.push({
        id: w.id, kind: 'worker', title: gone ? '' : wc.getTitle(), url: gone ? '' : wc.getURL(),
        name: w.identity.name, color: w.identity.color, glyph: w.identity.glyph,
        presentation: this.presentation.get(w.id) || 'parked', crashed: entry.crashed, loading: entry.loading,
        isActive: false, staged: staged === w.id && this.layoutMode !== 'grid'
      });
    }
    return out;
  }

  private scheduleGridBroadcast(): void {
    if (this.gridBroadcastTimer) return;
    this.gridBroadcastTimer = setTimeout(() => {
      this.gridBroadcastTimer = null;
      try {
        if (!this.window.isDestroyed()) {
          const payload: GridSourcesPayload = { sources: this.getGridSources() };
          this.window.webContents.send(IPC_CHANNELS.EVENT_GRID_SOURCES, payload);
        }
      } catch {}
    }, 50);
  }

  public listWorkerIds(): string[] {
    return [...this.workers.keys()];
  }

  public getWorker(id: string): LiveWorkerView | undefined {
    return this.workers.get(id)?.worker;
  }

  // ------------------------------------------------------------------------------------------- broadcast
  /** A presence event from any other source (e.g. 'think' / 'needs_you' from the mission). Drawn by the overlay window. */
  public broadcastPresence(event: PresenceEvent): void {
    this.presence.emit(event);
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
    this.scheduleGridBroadcast();
  }

  public broadcastTabPatch(id: string, patch: Partial<TabState>): void {
    try {
      if (!this.window.isDestroyed()) {
        const payload: TabPatch = { id, patch };
        this.window.webContents.send(IPC_CHANNELS.EVENT_TAB_PATCH, payload);
      }
    } catch {}
    this.scheduleGridBroadcast();
  }

  public getTab(id: string): TabView | undefined {
    return this.tabs.get(id);
  }

  public listTabs(): TabView[] {
    return this.tabOrder.map(id => this.tabs.get(id)).filter((t): t is TabView => !!t);
  }
}
