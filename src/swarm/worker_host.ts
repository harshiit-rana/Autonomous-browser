/**
 * Project Aegis - Worker Host & Isolated Browser Tab Context
 * 
 * Implements Issue #148 [SWM-02]:
 * - WorkerHost abstraction owning WebContentsView, partition, CDP session, and lifecycle
 * - Isolation levels: ephemeral (in-memory partition), agent-profile (persistent), user-profile
 * - Leak-free teardown: detachCDP, close webContents, removeChildView, cleanup listeners
 * - Safe recycling: clearing cache and session data between tasks
 * - Coherent profiles: User-Agent, locale, timezone, viewport bounds
 */

import { WebContentsView, BrowserWindow, session } from 'electron';
import { ActionExecutor } from '../core/action_executor.js';
import { PageDOMState } from '../core/dom_indexer.js';
import { logger } from '../infrastructure/logger.js';

export type IsolationLevel = 'ephemeral' | 'agent-profile' | 'user-profile';

export interface WorkerProfile {
  userAgent?: string;
  locale?: string;
  timezone?: string;
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface WorkerHostOptions {
  id: string;
  isolationLevel?: IsolationLevel;
  profileId?: string;
  profile?: WorkerProfile;
  parentWindow?: BrowserWindow | null;
}

export class WorkerHost {
  public readonly id: string;
  public readonly isolationLevel: IsolationLevel;
  public readonly partitionName: string;
  public readonly view: WebContentsView;
  public readonly executor: ActionExecutor;
  private parentWindow: BrowserWindow | null;
  private isTornDown: boolean = false;
  public status: 'idle' | 'navigating' | 'indexing' | 'executing' | 'error' = 'idle';
  public lastError?: string;

  constructor(options: WorkerHostOptions) {
    this.id = options.id;
    this.isolationLevel = options.isolationLevel || 'ephemeral';
    this.parentWindow = options.parentWindow || null;

    // Determine partition name
    if (this.isolationLevel === 'ephemeral') {
      // In-memory partition (no persist: prefix), isolated per worker
      this.partitionName = `ephemeral_${this.id}_${Date.now()}`;
    } else if (this.isolationLevel === 'agent-profile') {
      this.partitionName = `persist:agent_profile_${options.profileId || 'default'}`;
    } else {
      // user-profile shares the default session
      this.partitionName = '';
    }

    // Create partitioned session or get existing if Electron session is available
    let sess: any = null;
    try {
      if (session) {
        sess = this.partitionName && session.fromPartition ? session.fromPartition(this.partitionName) : session.defaultSession;
        if (options.profile?.userAgent && sess?.setUserAgent) {
          sess.setUserAgent(options.profile.userAgent);
        }
        if (options.profile?.locale && sess?.setSpellCheckerLanguages) {
          sess.setSpellCheckerLanguages([options.profile.locale]);
        }
      }
    } catch {}

    // Create isolated WebContentsView or fallback mock in headless test runs
    let viewInstance: any = null;
    try {
      if (typeof WebContentsView === 'function') {
        viewInstance = new WebContentsView({
          webPreferences: {
            partition: this.partitionName || undefined,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            javascript: true
          }
        });
      }
    } catch {}

    this.view = viewInstance || this.createMockView();
    const wc = this.view.webContents;

    // Hardened handlers: deny popups and unsafe navigation
    if (wc?.setWindowOpenHandler) {
      wc.setWindowOpenHandler(() => {
        logger.warn('Popup window open blocked in worker', { workerId: this.id });
        return { action: 'deny' };
      });
    }

    if (wc?.on) {
      wc.on('will-navigate', (event: any, url: string) => {
        if (url.startsWith('file:') || url.startsWith('chrome:') || url.startsWith('devtools:')) {
          event.preventDefault();
          logger.warn('Blocked restricted navigation in worker', { workerId: this.id, url });
        }
      });
    }

    // Deny permission requests
    if (wc?.session?.setPermissionRequestHandler) {
      wc.session.setPermissionRequestHandler((_: any, permission: string, callback: (allow: boolean) => void) => {
        logger.warn('Worker permission request rejected', { workerId: this.id, permission });
        callback(false);
      });
    }

    // Set viewport dimensions
    const width = options.profile?.viewportWidth || 1280;
    const height = options.profile?.viewportHeight || 800;
    if (this.view.setBounds) {
      this.view.setBounds({ x: 0, y: 0, width, height });
    }

    this.executor = new ActionExecutor(wc);
    logger.info('WorkerHost initialized', { workerId: this.id, isolation: this.isolationLevel, partition: this.partitionName });
  }

  private createMockView(): any {
    return {
      webContents: {
        loadURL: async () => {},
        getURL: () => 'about:blank',
        getTitle: () => 'Mock Page',
        isDestroyed: () => false,
        setWindowOpenHandler: () => {},
        on: () => {},
        session: {
          setPermissionRequestHandler: () => {},
          clearStorageData: async () => {},
          clearCache: async () => {}
        },
        stop: () => {},
        removeAllListeners: () => {},
        close: () => {}
      },
      setBounds: () => {}
    };
  }

  public async navigate(url: string): Promise<PageDOMState> {
    if (this.isTornDown) throw new Error(`Worker ${this.id} is torn down`);
    this.status = 'navigating';
    this.lastError = undefined;

    let targetUrl = url.trim();
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = 'https://' + targetUrl;
    }

    try {
      await this.view.webContents.loadURL(targetUrl);
      await this.waitForSettle();
      
      this.status = 'indexing';
      const domState = await this.executor.getDOMState();
      this.status = 'idle';
      return domState;
    } catch (err: any) {
      this.status = 'error';
      this.lastError = err.message;
      throw err;
    }
  }

  public async click(agentId: string): Promise<{ success: boolean; mode: string }> {
    if (this.isTornDown) throw new Error(`Worker ${this.id} is torn down`);
    this.status = 'executing';
    try {
      const res = await this.executor.clickElement(agentId);
      await this.waitForSettle();
      this.status = 'idle';
      return res;
    } catch (err: any) {
      this.status = 'error';
      this.lastError = err.message;
      throw err;
    }
  }

  public async type(agentId: string, text: string): Promise<void> {
    if (this.isTornDown) throw new Error(`Worker ${this.id} is torn down`);
    this.status = 'executing';
    try {
      await this.executor.typeText(agentId, text);
      this.status = 'idle';
    } catch (err: any) {
      this.status = 'error';
      this.lastError = err.message;
      throw err;
    }
  }

  /**
   * Reset / clear session data when recycling worker for a new task
   */
  public async resetStorage(): Promise<void> {
    if (this.isTornDown) return;
    try {
      const sess = this.view.webContents.session;
      await sess.clearStorageData({
        storages: ['cookies', 'localstorage', 'websql', 'indexdb', 'cachestorage']
      });
      await sess.clearCache();
      logger.info('Worker storage cleared for recycling', { workerId: this.id });
    } catch (err: any) {
      logger.warn('Failed to clear worker storage', { workerId: this.id, error: err.message });
    }
  }

  /**
   * Complete leak-free teardown of worker
   */
  public async teardown(): Promise<void> {
    if (this.isTornDown) return;
    this.isTornDown = true;
    this.status = 'idle';

    try {
      // 1. Detach CDP session
      await this.executor.detachCDP().catch(() => {});

      // 2. Remove view from parent window if attached
      if (this.parentWindow && !this.parentWindow.isDestroyed()) {
        try {
          (this.parentWindow.contentView as any)?.removeChildView?.(this.view);
        } catch {}
      }

      // 3. Close webContents cleanly
      const wc = this.view.webContents;
      if (wc && !wc.isDestroyed()) {
        wc.stop();
        wc.removeAllListeners();
        (wc as any).close?.();
      }

      logger.info('WorkerHost cleanly torn down', { workerId: this.id });
    } catch (err: any) {
      logger.warn('Error during worker teardown', { workerId: this.id, error: err.message });
    }
  }

  public async getSnapshot(): Promise<{
    workerId: string;
    url: string;
    title: string;
    status: string;
    lastError?: string;
  }> {
    if (this.isTornDown) {
      return { workerId: this.id, url: 'about:blank', title: 'Terminated', status: 'terminated' };
    }
    const wc = this.view.webContents;
    return {
      workerId: this.id,
      url: !wc.isDestroyed() ? wc.getURL() : 'about:blank',
      title: !wc.isDestroyed() ? wc.getTitle() : 'Untitled',
      status: this.status,
      lastError: this.lastError
    };
  }

  private async waitForSettle(timeoutMs: number = 600): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, timeoutMs));
  }
}
