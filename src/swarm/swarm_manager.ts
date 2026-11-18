/**
 * Project Aegis - Swarm Manager & Dynamic Worker Lifecycle Pool
 * 
 * Implements Issue #148 [SWM-02]:
 * - Dynamic scaling and pooling of isolated WorkerHost agents
 * - Session partition routing: ephemeral, agent-profile, user-profile
 * - Zero renderer process leaks: verified teardown and listener disposal
 * - Pre-warmed idle worker pool for sub-second task dispatch
 * - Integration with ViewManager and Mission Control
 */

import { BrowserWindow } from 'electron';
import { WorkerHost, IsolationLevel, WorkerProfile } from './worker_host.js';
import { logger } from '../infrastructure/logger.js';

export interface SwarmOptions {
  maxWorkers?: number;
  defaultIsolation?: IsolationLevel;
  parentWindow?: BrowserWindow | null;
  prewarmCount?: number;
}

export class SwarmManager {
  private workers: Map<string, WorkerHost> = new Map();
  private idlePool: WorkerHost[] = [];
  private maxWorkers: number;
  private defaultIsolation: IsolationLevel;
  private parentWindow: BrowserWindow | null;
  private workerCounter: number = 1;

  constructor(options: SwarmOptions = {}) {
    this.maxWorkers = options.maxWorkers || 8;
    this.defaultIsolation = options.defaultIsolation || 'ephemeral';
    this.parentWindow = options.parentWindow || null;

    if (options.prewarmCount && options.prewarmCount > 0) {
      this.prewarm(options.prewarmCount).catch(err => {
        logger.warn('Failed to prewarm swarm worker pool', { error: err.message });
      });
    }
  }

  public setParentWindow(window: BrowserWindow | null): void {
    this.parentWindow = window;
  }

  public async prewarm(count: number): Promise<void> {
    const toCreate = Math.min(count, this.maxWorkers - (this.workers.size + this.idlePool.length));
    for (let i = 0; i < toCreate; i++) {
      const id = `prewarm_${this.workerCounter++}`;
      const worker = new WorkerHost({
        id,
        isolationLevel: this.defaultIsolation,
        parentWindow: this.parentWindow
      });
      this.idlePool.push(worker);
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
  ): Promise<WorkerHost> {
    // 1. Check if we have an idle worker ready to be repurposed
    if (this.idlePool.length > 0 && !profile && (!isolation || isolation === this.defaultIsolation)) {
      const recycled = this.idlePool.pop()!;
      await recycled.resetStorage();
      this.workers.set(recycled.id, recycled);
      logger.info('Recycled prewarmed worker from pool', { workerId: recycled.id, role });
      return recycled;
    }

    if (this.workers.size >= this.maxWorkers) {
      throw new Error(`Worker pool limit reached (${this.maxWorkers}). Scale down or increase quota.`);
    }

    const workerId = `${role}_${this.workerCounter++}`;
    const worker = new WorkerHost({
      id: workerId,
      isolationLevel: isolation || this.defaultIsolation,
      profile,
      parentWindow: this.parentWindow
    });

    this.workers.set(workerId, worker);
    logger.info('Spawned active swarm worker', { workerId, role, activeCount: this.workers.size });
    return worker;
  }

  /**
   * Spawns a batch of workers for a parallel stage
   */
  public async spawnSwarm(count: number, role: string = 'worker'): Promise<WorkerHost[]> {
    const spawned: WorkerHost[] = [];
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

    if (recycle && this.idlePool.length < 3) {
      await worker.resetStorage();
      this.idlePool.push(worker);
      logger.info('Worker recycled into idle pool', { workerId });
    } else {
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

  public getWorker(workerId: string): WorkerHost | undefined {
    return this.workers.get(workerId);
  }

  public listWorkers(): WorkerHost[] {
    return Array.from(this.workers.values());
  }

  public getActiveCount(): number {
    return this.workers.size;
  }

  public async getSwarmStatus(): Promise<any[]> {
    const snapshots = await Promise.all(this.listWorkers().map(w => w.getSnapshot()));
    return snapshots;
  }

  public async shutdown(): Promise<void> {
    const activeIds = Array.from(this.workers.keys());
    for (const id of activeIds) {
      await this.retireWorker(id, false);
    }
    this.workers.clear();

    for (const idle of this.idlePool) {
      await idle.teardown();
    }
    this.idlePool = [];
    logger.info('SwarmManager completely shut down');
  }
}
