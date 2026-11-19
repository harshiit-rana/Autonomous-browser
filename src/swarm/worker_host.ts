/**
 * Project Aegis - Worker Host & Isolated Browser Tab Context
 *
 * Issues #148 [SWM-02] and #229 [SWX-03]:
 * - A WorkerHost owns exactly one real WebContentsView with its own session partition, executor and lifecycle.
 *   There is no stand-in view: when Electron cannot create the view the constructor throws. Tests that need a
 *   worker without Electron use `FakeWorkerHost` (tests/helpers), never a hidden fallback in product code.
 * - Isolation levels: ephemeral (in-memory partition `agent-<missionId>-<workerId>`, never persisted),
 *   agent-profile (persist:, shared on purpose by workers of the same account profile, #252) and
 *   user-profile (the user's default session).
 * - Same hardening as user tabs (agent_tab_guards.ts): permissions denied, http(s)-only navigation, popups and
 *   downloads refused.
 * - Settling is real (page_settle.ts): load finished + network idle + DOM stable, under a hard deadline.
 * - Teardown: detach CDP, remove our listeners, remove the view from the window, clear ephemeral storage,
 *   `webContents.close()`, and wait until Electron reports the contents destroyed.
 */

import { EventEmitter } from 'node:events';
import { WebContentsView, BrowserWindow, session } from 'electron';
import type { Session } from 'electron';
import { ActionExecutor } from '../core/action_executor.js';
import { PageDOMState } from '../core/dom_indexer.js';
import { logger } from '../infrastructure/logger.js';
import { applyAgentTabGuards, normaliseAgentNavigationTarget } from './agent_tab_guards.js';
import { NetworkActivityTracker, settlePage, SettleResult } from './page_settle.js';
import { WorkerIdentity, workerIdentityFor } from './worker_identity.js';

export type IsolationLevel = 'ephemeral' | 'agent-profile' | 'user-profile';
export type WorkerStatus = 'idle' | 'navigating' | 'indexing' | 'executing' | 'error' | 'crashed';

export interface WorkerProfile {
  userAgent?: string;
  locale?: string;
  timezone?: string;
  viewportWidth?: number;
  viewportHeight?: number;
}

/** Everything a worker emits that the mission timeline / presence layer may want, always tagged with identity. */
export interface WorkerEvent {
  type: 'popup-denied' | 'navigation-blocked' | 'download-cancelled' | 'permission-denied' | 'render-process-gone' | 'recovered';
  workerId: string;
  identity: WorkerIdentity;
  detail?: Record<string, unknown>;
}

/** The surface SwarmManager and SwarmCoordinator rely on; WorkerHost and tests' FakeWorkerHost both implement it. */
export interface IWorkerHost {
  readonly id: string;
  readonly identity: WorkerIdentity;
  readonly isolationLevel: IsolationLevel;
  readonly partitionName: string;
  status: WorkerStatus;
  lastError?: string;
  navigate(url: string): Promise<PageDOMState>;
  click(agentId: string): Promise<{ success: boolean; mode: string }>;
  type(agentId: string, text: string): Promise<void>;
  resetStorage(): Promise<void>;
  teardown(): Promise<void>;
  recover(): Promise<boolean>;
  getSnapshot(): Promise<WorkerSnapshot>;
  on(event: 'event', listener: (e: WorkerEvent) => void): unknown;
  off(event: 'event', listener: (e: WorkerEvent) => void): unknown;
}

export interface WorkerSnapshot {
  workerId: string;
  url: string;
  title: string;
  status: string;
  lastError?: string;
  identity: WorkerIdentity;
  partition: string;
}

export interface WorkerHostOptions {
  id: string;
  /** Mission this worker belongs to; part of the partition name so missions never share storage. */
  missionId?: string;
  /** 1-based spawn ordinal inside the mission; drives name/colour/glyph. Defaults to a stable hash of `id`. */
  ordinal?: number;
  isolationLevel?: IsolationLevel;
  profileId?: string;
  profile?: WorkerProfile;
  parentWindow?: BrowserWindow | null;
  /** Add the view to `parentWindow` (default false: workers are hidden until a grid/stage shows them). */
  attachToWindow?: boolean;
  runtime?: WorkerRuntime;
}

/** Electron entry points WorkerHost needs. The default is the real Electron; tests may pass a recording runtime. */
export interface WorkerRuntime {
  createView(partition: string | undefined): WebContentsView;
  sessionFor(partition: string): Session;
  defaultSession(): Session;
}

export class WorkerRuntimeUnavailableError extends Error {
  constructor(what: string) {
    super(`Cannot create an isolated worker: ${what}. Workers need a running Electron main process; there is no fallback view.`);
    this.name = 'WorkerRuntimeUnavailableError';
  }
}

export const electronWorkerRuntime: WorkerRuntime = {
  createView(partition) {
    if (typeof WebContentsView !== 'function') throw new WorkerRuntimeUnavailableError('Electron WebContentsView is not available');
    return new WebContentsView({
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        javascript: true
      }
    });
  },
  sessionFor(partition) {
    if (!session || typeof session.fromPartition !== 'function') throw new WorkerRuntimeUnavailableError('Electron session is not available');
    return session.fromPartition(partition);
  },
  defaultSession() {
    if (!session || !session.defaultSession) throw new WorkerRuntimeUnavailableError('Electron default session is not available');
    return session.defaultSession;
  }
};

// ---------------------------------------------------------------------------------------------------------
// Partition names. An in-memory partition lives as long as the Electron process even after its WebContents is
// gone, so a name is never handed out twice: a second claim of the same base name gets a numeric suffix.
// ---------------------------------------------------------------------------------------------------------
const everAllocated = new Set<string>();

function sanitizePart(s: string): string {
  return (s || 'x').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
}

export function allocatePartitionName(missionId: string, workerId: string): string {
  const base = `agent-${sanitizePart(missionId)}-${sanitizePart(workerId)}`;
  let name = base;
  for (let n = 2; everAllocated.has(name); n++) name = `${base}-${n}`;
  everAllocated.add(name);
  return name;
}

function ordinalFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 12) + 1;
}

const DESTROY_WAIT_MS = 3000;

export class WorkerHost extends EventEmitter implements IWorkerHost {
  public readonly id: string;
  public readonly missionId: string;
  public readonly identity: WorkerIdentity;
  public readonly isolationLevel: IsolationLevel;
  public readonly partitionName: string;
  public readonly view: WebContentsView;
  public readonly executor: ActionExecutor;
  public status: WorkerStatus = 'idle';
  public lastError?: string;
  /** Outcome of the most recent settle wait (honest: includes deadline hits). */
  public lastSettle?: SettleResult;
  /** True once Electron confirmed the WebContents is destroyed after teardown. */
  public destroyedConfirmed = false;

  private parentWindow: BrowserWindow | null;
  private attached = false;
  private isTornDown = false;
  private teardownPromise: Promise<void> | null = null;
  private lastUrl = '';
  private crashCount = 0;
  private network: NetworkActivityTracker | null = null;
  private disposeGuards: (() => void) | null = null;
  private cleanups: Array<() => void> = [];

  constructor(options: WorkerHostOptions) {
    super();
    this.id = options.id;
    this.missionId = options.missionId || 'adhoc';
    this.identity = workerIdentityFor(options.ordinal ?? ordinalFromId(options.id));
    this.isolationLevel = options.isolationLevel || 'ephemeral';
    this.parentWindow = options.parentWindow || null;
    const runtime = options.runtime || electronWorkerRuntime;

    let partition: string | undefined;
    if (this.isolationLevel === 'ephemeral') {
      partition = allocatePartitionName(this.missionId, this.id); // no "persist:" prefix => in-memory
    } else if (this.isolationLevel === 'agent-profile') {
      partition = `persist:agent-profile-${sanitizePart(options.profileId || 'default')}`;
    }
    this.partitionName = partition || '';

    try {
      const sess = partition ? runtime.sessionFor(partition) : runtime.defaultSession();
      if (options.profile?.userAgent) sess.setUserAgent(options.profile.userAgent);
      if (options.profile?.locale) sess.setSpellCheckerLanguages([options.profile.locale]);

      this.view = runtime.createView(partition);
      const wc = this.view.webContents;
      const ownsSession = Boolean(partition);

      this.disposeGuards = applyAgentTabGuards(wc, {
        workerId: this.id,
        onPopupDenied: url => this.notify('popup-denied', { url }),
        onNavigationBlocked: (url, reason) => this.notify('navigation-blocked', { url, reason }),
        onDownloadCancelled: fileName => this.notify('download-cancelled', { fileName }),
        onPermissionDenied: permission => this.notify('permission-denied', { permission })
      }, ownsSession);

      if (ownsSession) this.network = NetworkActivityTracker.acquire(wc.session);

      const onGone = (_e: unknown, details: { reason: string; exitCode: number }) => {
        this.crashCount++;
        this.status = 'crashed';
        this.lastError = `renderer process gone: ${details.reason}`;
        logger.error('Worker renderer process gone', undefined, { workerId: this.id, reason: details.reason, exitCode: details.exitCode });
        this.notify('render-process-gone', { reason: details.reason, exitCode: details.exitCode, crashCount: this.crashCount });
      };
      wc.on('render-process-gone', onGone);
      this.cleanups.push(() => wc.removeListener('render-process-gone', onGone));
      const onDidNavigate = (_e: unknown, url: string) => { this.lastUrl = url; };
      wc.on('did-navigate', onDidNavigate);
      this.cleanups.push(() => wc.removeListener('did-navigate', onDidNavigate));

      const width = options.profile?.viewportWidth || 1280;
      const height = options.profile?.viewportHeight || 800;
      this.view.setBounds({ x: 0, y: 0, width, height });

      if (options.attachToWindow && this.parentWindow && !this.parentWindow.isDestroyed()) {
        this.parentWindow.contentView.addChildView(this.view);
        this.attached = true;
      }

      this.executor = new ActionExecutor(wc);
    } catch (err) {
      this.disposeGuards?.();
      this.network?.release();
      throw err;
    }
    logger.info('WorkerHost initialized', { workerId: this.id, mission: this.missionId, isolation: this.isolationLevel, partition: this.partitionName });
  }

  private notify(type: WorkerEvent['type'], detail?: Record<string, unknown>): void {
    const e: WorkerEvent = { type, workerId: this.id, identity: this.identity, detail };
    this.emit('event', e);
  }

  public get crashes(): number {
    return this.crashCount;
  }

  public get isDestroyed(): boolean {
    return this.view.webContents.isDestroyed();
  }

  private assertUsable(): void {
    if (this.isTornDown) throw new Error(`Worker ${this.id} is torn down`);
    if (this.view.webContents.isDestroyed()) throw new Error(`Worker ${this.id} view was destroyed (window closed?)`);
  }

  public async navigate(url: string): Promise<PageDOMState> {
    this.assertUsable();
    const target = normaliseAgentNavigationTarget(url);
    if (!target.allowed || !target.url) {
      const reason = target.reason || 'blocked';
      this.lastError = `Navigation blocked: ${reason}`;
      this.notify('navigation-blocked', { url, reason });
      throw new Error(this.lastError);
    }
    this.status = 'navigating';
    this.lastError = undefined;
    this.lastUrl = target.url;

    try {
      await this.view.webContents.loadURL(target.url);
      await this.waitForSettle();

      this.status = 'indexing';
      const domState = await this.executor.getDOMState();
      this.status = 'idle';
      return domState;
    } catch (err: any) {
      if (this.status !== ('crashed' as WorkerStatus)) this.status = 'error';
      this.lastError = err.message;
      throw err;
    }
  }

  public async click(agentId: string): Promise<{ success: boolean; mode: string }> {
    this.assertUsable();
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
    this.assertUsable();
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
   * After a renderer crash, reload the last URL: Electron starts a fresh renderer process for the same
   * WebContents, so partition, identity and guards stay intact. Returns false if it could not be recovered.
   */
  public async recover(): Promise<boolean> {
    if (this.isTornDown || this.view.webContents.isDestroyed()) return false;
    try {
      const wc = this.view.webContents;
      await wc.loadURL(this.lastUrl && this.lastUrl !== '' ? this.lastUrl : 'about:blank');
      this.status = 'idle';
      this.lastError = undefined;
      this.notify('recovered', { url: this.lastUrl, crashCount: this.crashCount });
      return true;
    } catch (err: any) {
      this.status = 'error';
      this.lastError = `recovery failed: ${err.message}`;
      return false;
    }
  }

  /** Reset / clear session data when recycling a worker for a new task. */
  public async resetStorage(): Promise<void> {
    if (this.isTornDown || this.view.webContents.isDestroyed()) return;
    if (this.isolationLevel !== 'ephemeral') return; // never wipe a persistent or user profile
    try {
      const sess = this.view.webContents.session;
      await sess.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers'] });
      await sess.clearCache();
      logger.info('Worker storage cleared for recycling', { workerId: this.id });
    } catch (err: any) {
      logger.warn('Failed to clear worker storage', { workerId: this.id, error: err.message });
    }
  }

  /** Complete leak-free teardown. Idempotent and safe to call concurrently. */
  public teardown(): Promise<void> {
    if (!this.teardownPromise) {
      this.isTornDown = true;
      this.teardownPromise = this.doTeardown();
    }
    return this.teardownPromise;
  }

  private async doTeardown(): Promise<void> {
    const wc = this.view.webContents;
    this.status = 'idle';
    try {
      // 1. Stop talking to the page
      await this.executor.detachCDP().catch(() => {});
      this.disposeGuards?.();
      this.disposeGuards = null;
      for (const c of this.cleanups.splice(0)) c();

      // 2. Take the view out of the window
      if (this.attached && this.parentWindow && !this.parentWindow.isDestroyed()) {
        try { this.parentWindow.contentView.removeChildView(this.view); } catch { /* already removed */ }
      }
      this.attached = false;

      // 3. Ephemeral storage must not outlive the worker
      if (!wc.isDestroyed()) {
        wc.stop();
        if (this.isolationLevel === 'ephemeral') {
          try {
            await wc.session.clearStorageData();
            await wc.session.clearCache();
          } catch (err: any) {
            logger.warn('Could not clear ephemeral worker storage', { workerId: this.id, error: err.message });
          }
        }
      }
      this.network?.release();
      this.network = null;

      // 4. Close the WebContents and wait for Electron to confirm it is gone
      if (wc.isDestroyed()) {
        this.destroyedConfirmed = true;
      } else {
        this.destroyedConfirmed = await new Promise<boolean>(resolve => {
          const timer = setTimeout(() => resolve(false), DESTROY_WAIT_MS);
          wc.once('destroyed', () => { clearTimeout(timer); resolve(true); });
          wc.close();
        });
        if (!this.destroyedConfirmed) {
          logger.warn('Worker WebContents not confirmed destroyed after close()', { workerId: this.id, waitedMs: DESTROY_WAIT_MS });
        }
      }
      logger.info('WorkerHost torn down', { workerId: this.id, destroyed: this.destroyedConfirmed });
    } catch (err: any) {
      logger.warn('Error during worker teardown', { workerId: this.id, error: err.message });
    } finally {
      this.removeAllListeners();
    }
  }

  public async getSnapshot(): Promise<WorkerSnapshot> {
    const base = { workerId: this.id, identity: this.identity, partition: this.partitionName };
    if (this.isTornDown) {
      return { ...base, url: 'about:blank', title: 'Terminated', status: 'terminated' };
    }
    const wc = this.view.webContents;
    const gone = wc.isDestroyed();
    return {
      ...base,
      url: gone ? 'about:blank' : wc.getURL(),
      title: gone ? 'Untitled' : wc.getTitle(),
      status: this.status,
      lastError: this.lastError
    };
  }

  private async waitForSettle(): Promise<SettleResult> {
    const result = await settlePage(this.view.webContents, this.network);
    this.lastSettle = result;
    if (!result.settled) {
      logger.warn('Worker page did not settle before the deadline', { workerId: this.id, waitedMs: result.waitedMs, inFlight: result.inFlightAtEnd });
    }
    return result;
  }
}

// Backward compatibility alias
export { WorkerHost as SwarmWorker };
