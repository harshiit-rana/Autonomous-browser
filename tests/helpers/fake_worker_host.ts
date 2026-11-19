/**
 * TEST-ONLY stand-ins for swarm workers (Issue #229).
 *
 * Product code has no mock view: WorkerHost throws when Electron is unavailable. Tests that exercise the
 * scheduler / coordinator / SwarmManager logic without launching Electron inject these through
 * `SwarmManager({ workerFactory })`. Nothing here may be imported from src/.
 */

import { EventEmitter } from 'node:events';
import type { PageDOMState } from '../../src/core/dom_indexer.js';
import {
  IWorkerHost, IsolationLevel, WorkerEvent, WorkerHostOptions, WorkerSnapshot, WorkerStatus,
  allocatePartitionName
} from '../../src/swarm/worker_host.js';
import { workerIdentityFor, WorkerIdentity } from '../../src/swarm/worker_identity.js';

export interface FakePage {
  title: string;
  elementCount?: number;
}

export class FakeWorkerHost extends EventEmitter implements IWorkerHost {
  public readonly id: string;
  public readonly identity: WorkerIdentity;
  public readonly isolationLevel: IsolationLevel;
  public readonly partitionName: string;
  public status: WorkerStatus = 'idle';
  public lastError?: string;

  public tornDown = false;
  public storageResets = 0;
  public recoveries = 0;
  public readonly visited: string[] = [];

  constructor(options: WorkerHostOptions, private readonly pages: Record<string, FakePage> = {}) {
    super();
    this.id = options.id;
    this.identity = workerIdentityFor(options.ordinal ?? 1);
    this.isolationLevel = options.isolationLevel || 'ephemeral';
    this.partitionName = this.isolationLevel === 'ephemeral' ? allocatePartitionName(options.missionId || 'adhoc', options.id) : '';
  }

  async navigate(url: string): Promise<PageDOMState> {
    if (this.tornDown) throw new Error(`Worker ${this.id} is torn down`);
    this.visited.push(url);
    const page = this.pages[url];
    if (!page) throw new Error(`FakeWorkerHost has no page registered for ${url}`);
    return { title: page.title, url, elementCount: page.elementCount ?? 0, elements: [] };
  }

  async click(): Promise<{ success: boolean; mode: string }> { return { success: true, mode: 'fake' }; }
  async type(): Promise<void> { /* nothing to type into */ }
  async resetStorage(): Promise<void> { this.storageResets++; }
  async recover(): Promise<boolean> { this.recoveries++; this.status = 'idle'; return true; }

  async teardown(): Promise<void> {
    this.tornDown = true;
  }

  async getSnapshot(): Promise<WorkerSnapshot> {
    return {
      workerId: this.id,
      identity: this.identity,
      partition: this.partitionName,
      url: this.visited[this.visited.length - 1] || 'about:blank',
      title: this.tornDown ? 'Terminated' : 'Fake',
      status: this.tornDown ? 'terminated' : this.status
    };
  }

  /** Simulate a renderer crash the way WorkerHost reports it. */
  public simulateCrash(): void {
    this.status = 'crashed';
    const e: WorkerEvent = { type: 'render-process-gone', workerId: this.id, identity: this.identity, detail: { reason: 'crashed' } };
    this.emit('event', e);
  }
}

/** A `workerFactory` that records every worker it built so tests can inspect them afterwards. */
export function fakeWorkerFactory(pages: Record<string, FakePage> = {}) {
  const built: FakeWorkerHost[] = [];
  const factory = (o: WorkerHostOptions) => {
    const w = new FakeWorkerHost(o, pages);
    built.push(w);
    return w;
  };
  return { factory, built };
}
