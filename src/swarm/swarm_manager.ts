/**
 * Project Aegis - Swarm Manager & Dynamic Worker Lifecycle Pool
 *
 * Issues #148 [SWM-02] and #229 [SWX-03]:
 * - Dynamic scaling and pooling of isolated WorkerHost agents (one manager per mission)
 * - Session partition routing: ephemeral (per mission+worker), agent-profile, user-profile
 * - Zero renderer process leaks: shutdown() tears down active AND pooled workers and is also triggered when
 *   the parent window closes
 * - Crashed workers (render-process-gone) are recovered a bounded number of times, then left failed
 * - Integration with ViewManager and Mission Control
 */

import { BrowserWindow } from 'electron';
import { WorkerHost, IWorkerHost, WorkerHostOptions, IsolationLevel, WorkerProfile, WorkerEvent } from './worker_host.js';
import { logger } from '../infrastructure/logger.js';

export const MAX_CRASH_RECOVERIES = 2;

export interface SwarmOptions {
  maxWorkers?: number;
  defaultIsolation?: IsolationLevel;
  parentWindow?: BrowserWindow | null;
  prewarmCount?: number;
  /** Mission the workers belong to; becomes part of every worker's partition name. */
  missionId?: string;
  /** Show worker views inside parentWindow (default false). */
  attachToWindow?: boolean;
  /** Test seam: build workers without Electron (tests/helpers/fake_worker_host.ts). Product code never sets it. */
  workerFactory?: (options: WorkerHostOptions) => IWorkerHost;
}

export class SwarmManager {
  private workers: Map<string, IWorkerHost> = new Map();
  private idlePool: IWorkerHost[] = [];
  private maxWorkers: number;
  private defaultIsolation: IsolationLevel;
  private parentWindow: BrowserWindow | null = null;
  private missionId: string;
  private attachToWindow: boolean;
  private workerCounter: number = 1;
  private workerFactory: (options: WorkerHostOptions) => IWorkerHost;
  private listeners = new Map<string, (e: WorkerEvent) => void>();
  private recoveries = new Map<string, number>();
  private onWindowClosed = () => {
    logger.warn('Parent window closed while workers were running; shutting the swarm down', { missionId: this.missionId });
    void this.shutdown();
  };
  private isShutDown = false;

  constructor(options: SwarmOptions = {}) {
    this.maxWorkers = options.maxWorkers || 8;
    this.defaultIsolation = options.defaultIsolation || 'ephemeral';
    this.missionId = options.missionId || 'adhoc';
    this.attachToWindow = options.attachToWindow === true;
    this.workerFactory = options.workerFactory || (o => new WorkerHost(o));
    this.setParentWindow(options.parentWindow || null);

    if (options.prewarmCount && options.prewarmCount > 0) {
      this.prewarm(options.prewarmCount).catch(err => {
        logger.warn('Failed to prewarm swarm worker pool', { error: err.message });
      });
    }
  }

  public setParentWindow(window: BrowserWindow | null): void {
    if (this.parentWindow && !this.parentWindow.isDestroyed()) {
      this.parentWindow.removeListener('closed', this.onWindowClosed);
    }
    this.parentWindow = window;
    if (window && !window.isDestroyed()) window.once('closed', this.onWindowClosed);
  }

  private track(worker: IWorkerHost): void {
    const l = (e: WorkerEvent) => {
      if (e.type === 'render-process-gone') void this.handleCrash(worker);
    };
    this.listeners.set(worker.id, l);
    worker.on('event', l);
  }

  private untrack(worker: IWorkerHost): void {
    const l = this.listeners.get(worker.id);
    if (l) worker.off('event', l);
    this.listeners.delete(worker.id);
    this.recoveries.delete(worker.id);
  }

  private async handleCrash(worker: IWorkerHost): Promise<void> {
    const used = this.recoveries.get(worker.id) || 0;
    if (used >= MAX_CRASH_RECOVERIES) {
      logger.error('Worker crashed too many times; leaving it failed', undefined, { workerId: worker.id, crashes: used + 1 });
      return;
    }
    this.recoveries.set(worker.id, used + 1);
    const ok = await worker.recover();
    logger.warn('Crashed worker recovery attempted', { workerId: worker.id, attempt: used + 1, recovered: ok });
  }

  private create(id: string, isolation: IsolationLevel, profile?: WorkerProfile): IWorkerHost {
    const worker = this.workerFactory({
      id,
      missionId: this.missionId,
      ordinal: this.workerCounter - 1,
      isolationLevel: isolation,
      profile,
      parentWindow: this.parentWindow,
      attachToWindow: this.attachToWindow
    });
    this.track(worker);
    return worker;
  }

  public async prewarm(count: number): Promise<void> {
    const toCreate = Math.min(count, this.maxWorkers - (this.workers.size + this.idlePool.length));
    for (let i = 0; i < toCreate; i++) {
      const id = `prewarm_${this.workerCounter++}`;
      this.idlePool.push(this.create(id, this.defaultIsolation));
    }
    logger.info('Prewarmed swarm workers in idle pool', { count: this.idlePool.length });
  }

  /**
   * Spawns or borrows an active worker for a given role
   */
  public async spawnWorker(
    role: string = 'researcher',
    isolation?: IsolationLevel,
    profile?: WorkerProfile
  ): Promise<IWorkerHost> {
    if (this.isShutDown) throw new Error('Swarm is shut down');

    // 1. Check if we have an idle worker ready to be repurposed
    if (this.idlePool.length > 0 && !profile && (!isolation || isolation === this.defaultIsolation)) {
      const recycled = this.idlePool.pop()!;
      await recycled.resetStorage();
      this.workers.set(recycled.id, recycled);
      logger.info('Recycled pooled worker', { workerId: recycled.id, role });
      return recycled;
    }

    if (this.workers.size >= this.maxWorkers) {
      throw new Error(`Worker pool limit reached (${this.maxWorkers}). Scale down or increase quota.`);
    }

    const workerId = `${role}_${this.workerCounter++}`;
    const worker = this.create(workerId, isolation || this.defaultIsolation, profile);
    this.workers.set(workerId, worker);
    logger.info('Spawned active swarm worker', { workerId, role, activeCount: this.workers.size });
    return worker;
  }

  /**
   * Spawns a batch of workers for a parallel stage
   */
  public async spawnSwarm(count: number, role: string = 'worker'): Promise<IWorkerHost[]> {
    const spawned: IWorkerHost[] = [];
    for (let i = 0; i < count; i++) {
      const w = await this.spawnWorker(role);
      spawned.push(w);
    }
    return spawned;
  }

  /**
   * Retires a worker cleanly, either recycling into idle pool or tearing down
   */
  public async retireWorker(workerId: string, recycle: boolean = false): Promise<void> {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    this.workers.delete(workerId);

    if (recycle && !this.isShutDown && this.idlePool.length < 3) {
      await worker.resetStorage();
      this.idlePool.push(worker);
      logger.info('Worker recycled into idle pool', { workerId });
    } else {
      this.untrack(worker);
      await worker.teardown();
      logger.info('Worker retired and destroyed', { workerId });
    }
  }

  public async scaleTo(targetCount: number, role: string = 'worker'): Promise<void> {
    const currentCount = this.workers.size;
    if (targetCount > currentCount) {
      await this.spawnSwarm(targetCount - currentCount, role);
    } else if (targetCount < currentCount) {
      const toRemove = Array.from(this.workers.keys()).slice(0, currentCount - targetCount);
      for (const id of toRemove) {
        await this.retireWorker(id);
      }
    }
  }

  public getWorker(workerId: string): IWorkerHost | undefined {
    return this.workers.get(workerId);
  }

  public listWorkers(): IWorkerHost[] {
    return Array.from(this.workers.values());
  }

  public getActiveCount(): number {
    return this.workers.size;
  }

  public getIdleCount(): number {
    return this.idlePool.length;
  }

  public async getSwarmStatus(): Promise<any[]> {
    const snapshots = await Promise.all(this.listWorkers().map(w => w.getSnapshot()));
    return snapshots;
  }

  /** Tears down every active and pooled worker. Safe to call more than once. */
  public async shutdown(): Promise<void> {
    this.isShutDown = true;
    if (this.parentWindow && !this.parentWindow.isDestroyed()) {
      this.parentWindow.removeListener('closed', this.onWindowClosed);
    }
    const everyone = [...this.workers.values(), ...this.idlePool];
    this.workers.clear();
    this.idlePool = [];
    for (const w of everyone) this.untrack(w);
    await Promise.all(everyone.map(w => w.teardown()));
    logger.info('SwarmManager completely shut down', { missionId: this.missionId, workers: everyone.length });
  }
}
