/**
 * Project Aegis - registry of live worker views (#232).
 *
 * SwarmManager announces every active worker that owns a real WebContentsView here, and withdraws it BEFORE the
 * worker is torn down or parked in the idle pool. ViewManager listens and is the only code that attaches, places
 * and hides worker views (ADR 0012: one owner of the window's child views), and FrameHub streams their pixels
 * (ADR 0010). Keeping this a registry means the agent runtime does not need to know about the Grid.
 */

import { EventEmitter } from 'node:events';
import type { WebContents, WebContentsView } from 'electron';
import type { ActionExecutor } from '../core/action_executor.js';
import type { IWorkerHost } from './worker_host.js';

/** A worker with a real view: WorkerHost satisfies this, the tests' FakeWorkerHost does not. */
export interface LiveWorkerView extends IWorkerHost {
  readonly view: WebContentsView;
  readonly executor: ActionExecutor;
  readonly webContents: WebContents;
}

export function isLiveWorkerView(w: IWorkerHost): w is LiveWorkerView {
  const any = w as any;
  return !!any && typeof any.view === 'object' && any.view !== null && typeof any.executor === 'object' && any.executor !== null;
}

export class WorkerViewRegistry extends EventEmitter {
  private workers = new Map<string, LiveWorkerView>();

  /** Announces an active worker. Workers without a real view are ignored. Returns true if it was added. */
  public add(worker: IWorkerHost): boolean {
    if (!isLiveWorkerView(worker) || this.workers.has(worker.id)) return false;
    this.workers.set(worker.id, worker);
    this.emit('added', worker);
    return true;
  }

  /** Withdraws a worker; listeners run synchronously so the view is detached before teardown closes it. */
  public remove(workerId: string): boolean {
    const w = this.workers.get(workerId);
    if (!w) return false;
    this.workers.delete(workerId);
    this.emit('removed', w);
    return true;
  }

  public get(workerId: string): LiveWorkerView | undefined {
    return this.workers.get(workerId);
  }

  public list(): LiveWorkerView[] {
    return [...this.workers.values()];
  }
}

/** The process-wide registry used by SwarmManager (product) and ViewManager. Tests may pass their own. */
export const workerViews = new WorkerViewRegistry();
