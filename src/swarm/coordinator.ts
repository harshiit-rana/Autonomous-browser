import { SwarmManager } from './swarm_manager.js';
import { PageDOMState } from '../core/dom_indexer.js';

export interface TaskSlice {
  id: string;
  url: string;
  instruction: string;
  schema?: Record<string, string>;
}

export interface TaskEvidence {
  sliceId: string;
  workerId: string;
  url: string;
  title: string;
  data: Record<string, any>;
  timestamp: number;
}

export interface SwarmTaskResult {
  taskId: string;
  completedSlices: number;
  totalSlices: number;
  evidence: TaskEvidence[];
  durationMs: number;
}

/**
 * SwarmCoordinator
 * Orchestrates multi-agent parallel workflows:
 * Decomposes high-level research tasks into discrete slices, distributes slices
 * across parallel background workers, and merges extracted evidence into a unified output.
 */
export class SwarmCoordinator {
  private swarm: SwarmManager;

  constructor(swarm: SwarmManager) {
    this.swarm = swarm;
  }

  public async executeParallelResearch(
    taskId: string,
    slices: TaskSlice[],
    concurrency: number = 3
  ): Promise<SwarmTaskResult> {
    const startTime = Date.now();
    const evidenceList: TaskEvidence[] = [];

    // Scale swarm to desired concurrency
    const activeWorkers = await this.swarm.spawnSwarm(Math.min(slices.length, concurrency), 'researcher');

    // Work queue
    const queue = [...slices];
    const workerPromises = activeWorkers.map(async (worker) => {
      while (queue.length > 0) {
        const slice = queue.shift();
        if (!slice) break;

        try {
          const domState: PageDOMState = await worker.navigate(slice.url);
          
          evidenceList.push({
            sliceId: slice.id,
            workerId: worker.workerId,
            url: slice.url,
            title: domState.title,
            data: {
              interactiveElementsCount: domState.elementCount,
              sampleElements: domState.elements.slice(0, 5)
            },
            timestamp: Date.now()
          });
        } catch (err: any) {
          evidenceList.push({
            sliceId: slice.id,
            workerId: worker.workerId,
            url: slice.url,
            title: 'Error',
            data: { error: err.message },
            timestamp: Date.now()
          });
        }
      }
    });

    await Promise.all(workerPromises);

    // Scale down workers upon completion
    for (const w of activeWorkers) {
      await this.swarm.retireWorker(w.workerId);
    }

    return {
      taskId,
      completedSlices: evidenceList.length,
      totalSlices: slices.length,
      evidence: evidenceList,
      durationMs: Date.now() - startTime
    };
  }
}
