import { app, BrowserWindow, Tray, Menu, Notification, powerSaveBlocker, nativeImage } from 'electron';
import path from 'node:path';
import { ViewManager } from './view_manager.js';
import { initializeAppPaths, getAppPaths } from '../infrastructure/paths.js';
import { rootLogger } from '../infrastructure/logger.js';
import { getSettings, updateSettings } from '../infrastructure/settings.js';
import { credentialVault } from '../infrastructure/credentials.js';
import { registerTypedHandler } from '../ipc/main_handler.js';
import { AgentRuntime } from '../agent/runtime.js';
import { ModelProviderFactory } from '../models/provider_factory.js';
import { estimateStepCost } from '../models/pricing.js';
import type { DemoHost, ReplayDemoSession } from '../models/demo/replay_player.js';
import { SwarmCoordinator } from '../swarm/coordinator.js';
import { GlobalKillSwitch, AuditLog } from '../security/audit_log.js';
import { initialisePersistence, registerPersistenceIPC } from './persistence.js';
import { ContentBlocker } from '../browser/content_blocker.js';
import { BrowserUXManager } from '../browser/browser_ux.js';
import {
  IPC_CHANNELS,
  TabCreateRequest,
  TabNavigateRequest,
  TabSwitchRequest,
  TabCloseRequest,
  DrawerToggleRequest,
  MissionStartRequest,
  MissionStartResponse,
  ModelStatusRequest,
  ModelStatusResponse,
  DemoStartResponse,
  MODEL_NOT_CONFIGURED
} from '../ipc/contract.js';

/** Model used for the cost estimate shown after a successful "Test Key" for each provider. */
const KEY_TEST_ESTIMATE_MODEL: Record<string, string> = {
  gemini: 'gemini-2.0-flash',
  anthropic: 'claude-3-7-sonnet-latest',
  openai: 'gpt-4o',
  ollama: 'deepseek-r1:8b'
};

const logger = rootLogger.child('main');

class MainApp {
  private window: BrowserWindow | null = null;
  private viewManager: ViewManager | null = null;
  private tray: Tray | null = null;
  private powerSaveBlockerId: number | null = null;
  private demoSession: ReplayDemoSession | null = null;

  public async init(): Promise<void> {
    logger.info('Initializing Autonomous Browser...');

    // Enforce single instance lock
    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
      logger.warn('Another instance is already running. Quitting.');
      app.quit();
      return;
    }

    app.on('second-instance', () => {
      if (this.window) {
        if (this.window.isMinimized()) this.window.restore();
        this.window.focus();
      }
    });

    // 1. Initialize centralized application paths
    const paths = initializeAppPaths();
    logger.info('App paths initialized', { paths });

    // 2. Global error boundaries and process observability
    this.registerProcessErrorHandlers();

    await app.whenReady();
    if (!initialisePersistence()) return; // database could not be opened; the user was told and the app is exiting
    logger.info('Electron app ready. Creating primary window...');
    this.createWindow();
    this.registerIPC();
    this.setupTray();

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        app.quit();
      }
    });
  }

  /** Adapter between the Electron-free replay player and the window / tab strip. */
  private createDemoHost(): DemoHost {
    let tabId: string | null = null;
    const send = (channel: string, payload: unknown) => {
      if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, payload);
    };
    return {
      openTab: (url) => { tabId = this.viewManager?.createTab(url, false, 'agent:demo-replay').id ?? null; },
      closeTab: () => { if (tabId) { this.viewManager?.closeTab(tabId); tabId = null; } },
      emitStatus: (p) => send(IPC_CHANNELS.EVENT_MISSION_STATUS, p),
      emitEvidence: (p) => send(IPC_CHANNELS.EVENT_EVIDENCE, p),
      emitWorker: (p) => send(IPC_CHANNELS.EVENT_WORKER, p)
    };
  }

  private registerProcessErrorHandlers(): void {
    process.on('uncaughtException', (err: Error) => {
      logger.error('Uncaught Exception in main process', err);
    });

    process.on('unhandledRejection', (reason: any) => {
      logger.error('Unhandled Promise Rejection in main process', undefined, { reason });
    });

    app.on('render-process-gone', (_, webContents, details) => {
      logger.error('Render process gone', undefined, {
        webContentsId: webContents.id,
        reason: details.reason,
        exitCode: details.exitCode
      });
    });

    app.on('child-process-gone', (_, details) => {
      logger.error('Child process gone', undefined, {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode
      });
    });
  }

  private setupTray(): void {
    try {
      // 16x16 transparent PNG icon fallback
      const iconBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAA7SURBVDhPY/wPBAwUACYoZhjVAMwASk2AOQADpC5gGIwG0N0AUk0g1QByTSAFAH3DQCUAk+sPGBgAfl0gQQrYtVkAAAAASUVORK5CYII=', 'base64');
      const trayIcon = nativeImage.createFromBuffer(iconBuffer);
      this.tray = new Tray(trayIcon);
      this.tray.setToolTip('Project Aegis Autonomous Browser');

      const menu = Menu.buildFromTemplate([
        {
          label: 'Show Browser',
          click: () => {
            if (this.window) {
              this.window.show();
              this.window.focus();
            }
          }
        },
        {
          label: 'Pause Running Mission',
          click: () => {
            AgentRuntime.getInstance().pause();
          }
        },
        {
          label: 'Stop Mission',
          click: () => {
            AgentRuntime.getInstance().cancel();
          }
        },
        { type: 'separator' },
        {
          label: 'Quit Aegis',
          click: () => {
            app.quit();
          }
        }
      ]);
      this.tray.setContextMenu(menu);
      this.tray.on('double-click', () => {
        if (this.window) {
          this.window.show();
          this.window.focus();
        }
      });
    } catch (err: any) {
      logger.warn('Failed to initialize system tray', { error: err.message });
    }
  }

  private createWindow(): void {
    this.window = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 800,
      minHeight: 600,
      title: 'Autonomous Browser',
      show: true,
      backgroundColor: '#0F1117',
      titleBarStyle: 'hidden',
      titleBarOverlay: process.platform === 'darwin' ? false : {
        color: '#090d16',
        symbolColor: '#94a3b8',
        height: 38
      },
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        preload: path.resolve(__dirname, 'preload.js')
      }
    });

    // Security Hardening: deny popups and external navigation from chrome
    this.window.webContents.setWindowOpenHandler(() => {
      logger.warn('Window open request denied from chrome');
      return { action: 'deny' };
    });

    this.window.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('file://')) {
        event.preventDefault();
        logger.warn('Blocked attempted external navigation in chrome window', { url });
      }
    });

    // Deny permission requests from chrome renderer
    this.window.webContents.session.setPermissionRequestHandler((_, permission, callback) => {
      logger.warn('Permission request denied', { permission });
      callback(false);
    });

    this.viewManager = new ViewManager(this.window);
    AgentRuntime.initialize(this.window, this.viewManager);

    const rendererHtml = path.resolve(__dirname, '../renderer/index.html');
    logger.info('Loading chrome renderer HTML', { rendererHtml });
    this.window.loadFile(rendererHtml);

    this.window.webContents.on('did-finish-load', () => {
      logger.info('Chrome renderer loaded successfully');
      // Create initial active tab and sync snapshot
      if (this.viewManager && this.viewManager.listTabs().length === 0) {
        this.viewManager.createTab('https://duckduckgo.com', false);
      }
      this.viewManager?.broadcastTabsSnapshot();
    });

    this.window.on('resize', () => {
      this.viewManager?.relayout();
    });
  }

  private registerIPC(): void {
    const getChrome = () => this.window?.webContents || null;

    // Window & Layout controls (Issue #138)
    registerTypedHandler(IPC_CHANNELS.WINDOW_MINIMIZE, getChrome, () => {
      this.window?.minimize();
      return true;
    });

    registerTypedHandler(IPC_CHANNELS.WINDOW_MAXIMIZE, getChrome, () => {
      if (this.window?.isMaximized()) {
        this.window.unmaximize();
      } else {
        this.window?.maximize();
      }
      return true;
    });

    registerTypedHandler(IPC_CHANNELS.WINDOW_CLOSE, getChrome, () => {
      this.window?.close();
      return true;
    });

    registerTypedHandler<{ mode: 'stage' | 'grid' | 'theatre' }, boolean>(
      IPC_CHANNELS.LAYOUT_SET,
      getChrome,
      (req) => {
        this.viewManager?.setLayoutMode(req.mode);
        return true;
      }
    );

    registerTypedHandler<{ active: boolean }, boolean>(
      IPC_CHANNELS.OVERLAY_SET_ACTIVE,
      getChrome,
      (req) => {
        this.viewManager?.setOverlayActive(req.active);
        return true;
      }
    );

    registerTypedHandler(
      IPC_CHANNELS.SWARM_PREVIEWS_GET,
      getChrome,
      async () => {
        return this.viewManager?.getSwarmPreviews() || [];
      }
    );

    // Drawer control
    registerTypedHandler<DrawerToggleRequest, boolean>(
      IPC_CHANNELS.DRAWER_TOGGLE,
      getChrome,
      (req) => {
        this.viewManager?.setDrawerWidth(req.open ? (req.width || 320) : 0);
        return true;
      }
    );

    // Tab management
    registerTypedHandler<TabCreateRequest, { id: string }>(
      IPC_CHANNELS.TAB_CREATE,
      getChrome,
      (req) => {
        const tab = this.viewManager?.createTab(req?.url || 'https://duckduckgo.com', req?.isBackground || false);
        return { id: tab?.id || '' };
      }
    );

    registerTypedHandler<TabNavigateRequest, { id: string }>(
      IPC_CHANNELS.TAB_NAVIGATE,
      getChrome,
      (req) => {
        let tab;
        if (req.tabId) {
          tab = this.viewManager?.getTab(req.tabId);
          if (tab) {
            tab.view.webContents.loadURL(req.url);
          }
        } else {
          tab = this.viewManager?.navigateActiveTab(req.url);
        }
        return { id: tab?.id || '' };
      }
    );

    registerTypedHandler<TabSwitchRequest, boolean>(
      IPC_CHANNELS.TAB_SWITCH,
      getChrome,
      (req) => {
        this.viewManager?.setActiveTab(req.id);
        return true;
      }
    );

    registerTypedHandler<TabCloseRequest, boolean>(
      IPC_CHANNELS.TAB_CLOSE,
      getChrome,
      (req) => {
        this.viewManager?.closeTab(req.id);
        return true;
      }
    );

    registerTypedHandler(IPC_CHANNELS.TAB_SYNC_REQUEST, getChrome, () => {
      this.viewManager?.broadcastTabsSnapshot();
      return true;
    });

    registerTypedHandler(IPC_CHANNELS.TAB_GO_BACK, getChrome, () => {
      const tab = this.viewManager?.getActiveTab();
      if (tab?.view.webContents.navigationHistory.canGoBack()) {
        tab.view.webContents.navigationHistory.goBack();
      }
      return true;
    });

    registerTypedHandler(IPC_CHANNELS.TAB_GO_FORWARD, getChrome, () => {
      const tab = this.viewManager?.getActiveTab();
      if (tab?.view.webContents.navigationHistory.canGoForward()) {
        tab.view.webContents.navigationHistory.goForward();
      }
      return true;
    });

    registerTypedHandler(IPC_CHANNELS.TAB_RELOAD, getChrome, () => {
      const tab = this.viewManager?.getActiveTab();
      tab?.view.webContents.reload();
      return true;
    });

    registerTypedHandler(IPC_CHANNELS.TAB_REOPEN, getChrome, () => {
      const tab = this.viewManager?.reopenClosedTab();
      return { id: tab?.id || '' };
    });

    registerTypedHandler<{ id: string }, { id: string }>(IPC_CHANNELS.TAB_DUPLICATE, getChrome, (req) => {
      const tab = this.viewManager?.duplicateTab(req.id);
      return { id: tab?.id || '' };
    });

    // Content Blocker & Browser UX
    const contentBlocker = new ContentBlocker();
    const browserUx = new BrowserUXManager();

    registerTypedHandler(IPC_CHANNELS.CONTENT_BLOCKER_GET_STATS, getChrome, () => {
      return contentBlocker.getStats();
    });

    registerTypedHandler<{ origin: string }, boolean>(IPC_CHANNELS.CONTENT_BLOCKER_ALLOW_ORIGIN, getChrome, (req) => {
      contentBlocker.allowOrigin(req.origin);
      return true;
    });

    registerTypedHandler(IPC_CHANNELS.ZOOM_IN, getChrome, () => {
      const tab = this.viewManager?.getActiveTab();
      if (tab) {
        const cur = tab.view.webContents.getZoomFactor();
        const next = Math.min(5.0, cur + 0.1);
        tab.view.webContents.setZoomFactor(next);
      }
      return true;
    });

    registerTypedHandler(IPC_CHANNELS.ZOOM_OUT, getChrome, () => {
      const tab = this.viewManager?.getActiveTab();
      if (tab) {
        const cur = tab.view.webContents.getZoomFactor();
        const next = Math.max(0.25, cur - 0.1);
        tab.view.webContents.setZoomFactor(next);
      }
      return true;
    });

    registerTypedHandler(IPC_CHANNELS.ZOOM_RESET, getChrome, () => {
      const tab = this.viewManager?.getActiveTab();
      if (tab) {
        tab.view.webContents.setZoomFactor(1.0);
      }
      return true;
    });

    // Plan Preview (Issue #140, #147)
    registerTypedHandler<{ prompt: string; model?: string }, any>(
      IPC_CHANNELS.MISSION_PLAN_PREVIEW,
      getChrome,
      async (req) => {
        const prompt = req.prompt.trim();

        if (prompt.startsWith('/swarm') || prompt.startsWith('/research') || /compare.*across/i.test(prompt)) {
          const coordinator = new SwarmCoordinator();
          const swarmPlan = coordinator.planMission('preview', prompt);
          const steps = swarmPlan.stages.flatMap((s, sIdx) => 
            s.tasks.map((t, tIdx) => ({
              stepNumber: sIdx * 10 + tIdx + 1,
              title: `[${s.stageName}] ${t.name}`,
              description: t.instruction,
              toolHint: `${t.role} (${t.effectClass})`
            }))
          );

          return {
            goal: prompt,
            justification: swarmPlan.justification,
            steps,
            estimatedCostUSD: 0.0075,
            estimatedDurationSec: 25
          };
        }

        const steps = [
          {
            stepNumber: 1,
            title: 'Target Navigation & Domain Discovery',
            description: `Inspect active tab or navigate to primary domain for: "${prompt.slice(0, 50)}"`,
            toolHint: 'navigate / observe'
          },
          {
            stepNumber: 2,
            title: 'Perception & Action Dispatch',
            description: 'Extract interactive element refs ([e1], [e2]), compute center quad targets, and execute CDP actions',
            toolHint: 'click / type / scroll'
          },
          {
            stepNumber: 3,
            title: 'Evidence Extraction & Verification',
            description: 'Validate extracted facts against goal criteria and generate structured markdown deliverable',
            toolHint: 'done'
          }
        ];

        return {
          goal: prompt,
          justification: 'Single linear task execution using dedicated operator agent.',
          steps,
          estimatedCostUSD: 0.0035,
          estimatedDurationSec: 12
        };
      }
    );

    // Mission Execution (Real Agent Runtime - Issues #115, #116, #128)
    registerTypedHandler<MissionStartRequest, MissionStartResponse>(
      IPC_CHANNELS.MISSION_START,
      getChrome,
      async (req) => {
        logger.info('Mission start requested', { prompt: req.prompt, model: req.model });
        try {
          if (this.demoSession?.isActive()) {
            return { started: false, reason: 'error', message: 'A replay demo is playing. Stop it before starting a mission.' };
          }
          // No usable model: a normal first-run state, answered with a typed code so the renderer opens Settings (#224).
          const modelCheck = await ModelProviderFactory.checkConfigured(req.model);
          if (!modelCheck.configured) {
            logger.info('Mission not started: model not configured', { provider: modelCheck.provider });
            return { started: false, code: MODEL_NOT_CONFIGURED, provider: modelCheck.provider, message: modelCheck.message };
          }
          if (this.powerSaveBlockerId === null) {
            this.powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
            logger.info('PowerSaveBlocker activated for background mission', { blockerId: this.powerSaveBlockerId });
          }
          const runtime = AgentRuntime.getInstance();
          const result = await runtime.startMission(req.prompt, req.model);
          return {
            started: result.ok,
            missionId: result.missionId,
            code: result.code,
            provider: result.provider,
            message: result.error
          };
        } catch (err: any) {
          logger.error('Failed to start mission', err);
          return {
            started: false,
            reason: 'error',
            message: err.message
          };
        }
      }
    );

    registerTypedHandler(IPC_CHANNELS.MISSION_PAUSE, getChrome, () => {
      AgentRuntime.getInstance().pause();
      return true;
    });

    registerTypedHandler(IPC_CHANNELS.MISSION_RESUME, getChrome, () => {
      AgentRuntime.getInstance().resume();
      return true;
    });

    registerTypedHandler(IPC_CHANNELS.MISSION_CANCEL, getChrome, () => {
      AgentRuntime.getInstance().cancel();
      return true;
    });

    registerTypedHandler(IPC_CHANNELS.MISSION_TAKEOVER, getChrome, () => {
      AgentRuntime.getInstance().takeover();
      return true;
    });

    registerTypedHandler(IPC_CHANNELS.MISSION_HANDBACK, getChrome, async () => {
      await AgentRuntime.getInstance().handBack();
      return true;
    });

    registerTypedHandler<{ message: string; type?: any }, boolean>(
      IPC_CHANNELS.MISSION_STEER,
      getChrome,
      (req) => {
        AgentRuntime.getInstance().steer(req.message, req.type);
        return true;
      }
    );

    registerTypedHandler(
      IPC_CHANNELS.MISSION_UNDO,
      getChrome,
      async () => {
        return AgentRuntime.getInstance().undoLastAction();
      }
    );

    // Settings
    registerTypedHandler(IPC_CHANNELS.SETTINGS_GET, getChrome, () => {
      return getSettings();
    });

    registerTypedHandler<{ settings: any }, any>(
      IPC_CHANNELS.SETTINGS_UPDATE,
      getChrome,
      (req) => {
        return updateSettings(req.settings);
      }
    );

    // Secure Credentials Vault (Issue #133)
    registerTypedHandler<{ provider: string; key: string; baseUrl?: string }, any>(
      IPC_CHANNELS.CREDENTIALS_TEST,
      getChrome,
      async (req) => {
        const result = await credentialVault.testCredentials(req.provider, req.key, req.baseUrl);
        const model = KEY_TEST_ESTIMATE_MODEL[req.provider];
        return model ? { ...result, model, estimate: estimateStepCost(model) } : result;
      }
    );

    // First-run readiness: is a model usable, and roughly what does one step cost (#224)
    registerTypedHandler<ModelStatusRequest, ModelStatusResponse>(
      IPC_CHANNELS.MODEL_STATUS,
      getChrome,
      (req) => ModelProviderFactory.describe(req?.model)
    );

    // Replay demo: labelled playback of a recorded transcript, no model (#224)
    registerTypedHandler<void, DemoStartResponse>(
      IPC_CHANNELS.DEMO_START,
      getChrome,
      async () => {
        const liveState = AgentRuntime.getInstance().getActiveMission()?.state;
        if (liveState === 'running' || liveState === 'planning') {
          return { started: false, message: 'A mission is running. Cancel it before starting the replay demo.' };
        }
        try {
          if (!this.demoSession) {
            const { ReplayDemoSession: Session } = await import('../models/demo/replay_player.js');
            this.demoSession = new Session(this.createDemoHost());
          }
          const { goal } = await this.demoSession.start();
          return { started: true, message: goal };
        } catch (err: any) {
          logger.error('Replay demo failed to start', err);
          return { started: false, message: err.message };
        }
      }
    );

    registerTypedHandler<void, boolean>(IPC_CHANNELS.DEMO_STOP, getChrome, async () => {
      await this.demoSession?.stop();
      return true;
    });

    registerTypedHandler<{ provider: string; key: string }, boolean>(
      IPC_CHANNELS.CREDENTIALS_SET,
      getChrome,
      async (req) => {
        await credentialVault.setKey(req.provider, req.key);
        return true;
      }
    );

    registerTypedHandler(
      IPC_CHANNELS.CREDENTIALS_GET_STATUS,
      getChrome,
      async () => {
        const gemini = Boolean(await credentialVault.getKey('gemini') || process.env.GEMINI_API_KEY);
        const anthropic = Boolean(await credentialVault.getKey('anthropic') || process.env.ANTHROPIC_API_KEY);
        const openai = Boolean(await credentialVault.getKey('openai') || process.env.OPENAI_API_KEY);
        return { gemini, anthropic, openai };
      }
    );

    registerPersistenceIPC(() => this.window);

    // Global Kill Switch & Security Audit (Issue #164)
    registerTypedHandler<{ reason?: string }, boolean>(
      IPC_CHANNELS.KILL_SWITCH_TRIGGER,
      getChrome,
      (req) => {
        GlobalKillSwitch.getInstance().triggerKill(req?.reason || 'User triggered kill switch via UI');
        AgentRuntime.getInstance().cancel();
        return true;
      }
    );

    registerTypedHandler(
      IPC_CHANNELS.KILL_SWITCH_RESET,
      getChrome,
      () => {
        GlobalKillSwitch.getInstance().reset();
        return true;
      }
    );

    registerTypedHandler(
      IPC_CHANNELS.KILL_SWITCH_GET_STATUS,
      getChrome,
      () => {
        return GlobalKillSwitch.getInstance().getStatus();
      }
    );

    registerTypedHandler(
      IPC_CHANNELS.AUDIT_LOG_GET,
      getChrome,
      () => {
        return new AuditLog().getRecords();
      }
    );

    registerTypedHandler(
      IPC_CHANNELS.AUDIT_LOG_VERIFY,
      getChrome,
      () => {
        return new AuditLog().verifyIntegrity();
      }
    );
  }
}

const mainApp = new MainApp();
mainApp.init().catch(err => {
  logger.error('Fatal initialization error in main process', err);
});
