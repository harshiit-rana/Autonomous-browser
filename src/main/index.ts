import { app, BaseWindow, ipcMain } from 'electron';
import path from 'node:path';
import { ViewManager } from './view_manager.js';

/**
 * Main Application Controller
 * Initializes the root native window, sets up the dual-layer view manager,
 * and handles IPC messaging between the top browser chrome and active views.
 */
class MainApp {
  private window: BaseWindow | null = null;
  private viewManager: ViewManager | null = null;

  public async init(): Promise<void> {
    await app.whenReady();
    this.createWindow();
    this.registerIPC();

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        app.quit();
      }
    });
  }

  private createWindow(): void {
    this.window = new BaseWindow({
      width: 1400,
      height: 900,
      minWidth: 800,
      minHeight: 600,
      title: 'Autonomous Browser',
      frame: true,
      backgroundColor: '#0F1117'
    });

    this.viewManager = new ViewManager(this.window);

    // Create default home tab
    this.viewManager.createTab('https://github.com');

    this.window.on('resize', () => {
      this.viewManager?.relayout();
    });
  }

  private registerIPC(): void {
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
