import { WebContentsView } from 'electron';
import { SwarmWorker, WorkerState } from './swarm_worker.js';

export interface SwarmOptions {
  maxWorkers?: number;
}

/**
 * SwarmManager
 * Dynamically scales and manages pools of parallel autonomous agent workers.
 * Each worker operates in an isolated, background WebContentsView without screen hijacking.
 */
export class SwarmManager {
  private workers: Map<string, SwarmWorker> = new Map();
  private maxWorkers: number;
  private workerCounter: number = 1;

  constructor(options: SwarmOptions = {}) {
    this.maxWorkers = options.maxWorkers || 10;
  }

  public async spawnWorker(rolePrefix: string = 'worker'): Promise<SwarmWorker> {
    if (this.workers.size >= this.maxWorkers) {
      throw new Error(`Worker pool limit reached (${this.maxWorkers}). Scale down before adding more.`);
    }

    const workerId = `${rolePrefix}_${this.workerCounter++}`;
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true
      }
    });

    const worker = new SwarmWorker(workerId, view.webContents);
    this.workers.set(workerId, worker);
    return worker;
  }

  public async spawnSwarm(count: number, rolePrefix: string = 'agent'): Promise<SwarmWorker[]> {
    const spawned: SwarmWorker[] = [];
    for (let i = 0; i < count; i++) {
      const w = await this.spawnWorker(`${rolePrefix}_${i + 1}`);
      spawned.push(w);
    }
    return spawned;
  }

  public async retireWorker(workerId: string): Promise<void> {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    await worker.executor.detachCDP();
    (worker.webContents as any).destroy?.();
    this.workers.delete(workerId);
  }

  public async scaleTo(targetCount: number, rolePrefix: string = 'worker'): Promise<void> {
    const currentCount = this.workers.size;
    if (targetCount > currentCount) {
      await this.spawnSwarm(targetCount - currentCount, rolePrefix);
    } else if (targetCount < currentCount) {
      const toRemove = Array.from(this.workers.keys()).slice(0, currentCount - targetCount);
      for (const id of toRemove) {
        await this.retireWorker(id);
      }
    }
  }

  public getWorker(workerId: string): SwarmWorker | undefined {
    return this.workers.get(workerId);
  }

  public listWorkers(): SwarmWorker[] {
    return Array.from(this.workers.values());
  }

  public async getSwarmStatus(): Promise<WorkerState[]> {
    return await Promise.all(this.listWorkers().map(w => w.getSnapshot()));
  }

  public async shutdown(): Promise<void> {
    const ids = Array.from(this.workers.keys());
    for (const id of ids) {
      await this.retireWorker(id);
    }
    this.workers.clear();
  }
}
