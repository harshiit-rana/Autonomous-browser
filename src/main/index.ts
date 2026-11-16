import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { ViewManager } from './view_manager.js';

/**
 * Main Application Controller
 * Initializes the root native window, sets up the dual-layer view manager,
 * and handles IPC messaging between the top browser chrome and active views.
 */
class MainApp {
  private window: BrowserWindow | null = null;
  private viewManager: ViewManager | null = null;

  public async init(): Promise<void> {
    console.log('[Main] Initializing Autonomous Browser...');
    // Configure cache and user data directory strictly on D: drive
    const customUserData = path.join(process.cwd(), '.aegis-user-data');
    app.setPath('userData', customUserData);
    app.setPath('sessionData', path.join(customUserData, 'session'));
    app.commandLine.appendSwitch('disk-cache-dir', path.join(customUserData, 'Cache'));

    await app.whenReady();
    console.log('[Main] App ready event fired! Creating window...');
    this.createWindow();
    this.registerIPC();

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        app.quit();
      }
    });
  }

  private createWindow(): void {
    console.log('[Main] Creating BrowserWindow...');
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
        preload: path.resolve(__dirname, 'preload.js')
      }
    });

    this.viewManager = new ViewManager(this.window);

    const rendererHtml = path.resolve(__dirname, '../renderer/index.html');
    console.log('[Main] Loading renderer HTML:', rendererHtml);
    this.window.loadFile(rendererHtml);

    this.window.webContents.on('did-finish-load', () => {
      console.log('[Main] Renderer finished loading successfully!');
    });

    this.window.show();
    this.window.focus();

    this.window.on('resize', () => {
      this.viewManager?.relayout();
    });
  }

  private registerIPC(): void {
    // Window management controls
    ipcMain.handle('window:minimize', () => {
      this.window?.minimize();
      return true;
    });

    ipcMain.handle('window:maximize', () => {
      if (this.window?.isMaximized()) {
        this.window.unmaximize();
      } else {
        this.window?.maximize();
      }
      return true;
    });

    ipcMain.handle('window:close', () => {
      this.window?.close();
      return true;
    });

    ipcMain.handle('drawer:toggle', (_, { open, width }) => {
      this.viewManager?.setDrawerWidth(open ? (width || 320) : 0);
      return true;
    });

    ipcMain.handle('tab:create', (_, { url, isBackground }) => {
      return this.viewManager?.createTab(url, isBackground).id;
    });

    ipcMain.handle('tab:switch', (_, { id }) => {
      this.viewManager?.setActiveTab(id);
      return true;
    });

    ipcMain.handle('tab:close', (_, { id }) => {
      this.viewManager?.closeTab(id);
      return true;
    });

    ipcMain.handle('tab:list', () => {
      return this.viewManager?.listTabs().map(t => ({
        id: t.id,
        url: t.url,
        title: t.title,
        isLoading: t.isLoading,
        isBackgroundAgent: t.isBackgroundAgent
      }));
    });

    // Agent action execution API
    ipcMain.handle('agent:click', async (_, { tabId, agentId, options }) => {
      const tab = this.viewManager?.getTab(tabId);
      if (!tab) throw new Error(`Tab ${tabId} not found`);
      return await tab.executor.clickElement(agentId, options);
    });

    ipcMain.handle('agent:type', async (_, { tabId, agentId, text }) => {
      const tab = this.viewManager?.getTab(tabId);
      if (!tab) throw new Error(`Tab ${tabId} not found`);
      await tab.executor.typeText(agentId, text);
      return true;
    });

    ipcMain.handle('agent:get_dom', async (_, { tabId }) => {
      const tab = this.viewManager?.getTab(tabId);
      if (!tab) throw new Error(`Tab ${tabId} not found`);
      return await tab.executor.getDOMState();
    });
  }
}

const mainApp = new MainApp();
mainApp.init().catch(err => {
  console.error('[Main] Fatal initialization error:', err);
});
