import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { ViewManager } from './view_manager.js';
import { initializeAppPaths, getAppPaths } from '../infrastructure/paths.js';
import { rootLogger } from '../infrastructure/logger.js';
import { getSettings, updateSettings } from '../infrastructure/settings.js';
import { credentialVault } from '../infrastructure/credentials.js';
import { registerTypedHandler } from '../ipc/main_handler.js';
import { AgentRuntime } from '../agent/runtime.js';
import {
  IPC_CHANNELS,
  TabCreateRequest,
  TabNavigateRequest,
  TabSwitchRequest,
  TabCloseRequest,
  DrawerToggleRequest,
  MissionStartRequest,
  MissionStartResponse
} from '../ipc/contract.js';

const logger = rootLogger.child('main');

class MainApp {
  private window: BrowserWindow | null = null;
  private viewManager: ViewManager | null = null;

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
    logger.info('Electron app ready. Creating primary window...');
    this.createWindow();
    this.registerIPC();

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        app.quit();
      }
    });
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

  private createWindow(): void {
    this.window = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 800,
      minHeight: 600,
      title: 'Autonomous Browser',
      show: true,
      backgroundColor: '#0F1117',
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

    // Window controls
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

    // Mission Execution (Real Agent Runtime - Issues #115, #116, #128)
    registerTypedHandler<MissionStartRequest, MissionStartResponse>(
      IPC_CHANNELS.MISSION_START,
      getChrome,
      async (req) => {
        logger.info('Mission start requested', { prompt: req.prompt, model: req.model });
        try {
          const runtime = AgentRuntime.getInstance();
          const result = await runtime.startMission(req.prompt, req.model);
          return {
            started: result.ok,
            missionId: result.missionId,
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
        return credentialVault.testCredentials(req.provider, req.key, req.baseUrl);
      }
    );

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
  }
}

const mainApp = new MainApp();
mainApp.init().catch(err => {
  logger.error('Fatal initialization error in main process', err);
});
