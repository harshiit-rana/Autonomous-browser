/**
 * Project Aegis - Batch Job Parallelization & Parameter Expansion
 * 
 * Implements:
 * - Issue #88: AUTO-04 Batch Job Parallelization & CSV Parameter Expansion
 */

import { EventEmitter } from 'node:events';

export interface BatchItem {
  id: string;
  parameters: Record<string, string>;
  expandedPrompt: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: any;
  error?: string;
}

export interface BatchSummary {
  total: number;
  completed: number;
  failed: number;
  durationMs: number;
  results: BatchItem[];
}

export class BatchJobRunner extends EventEmitter {
  private concurrency: number;

  constructor(concurrency = 3) {
    super();
    this.concurrency = concurrency;
  }

  /**
   * Expands a template string using a list of parameter rows.
   */
  public static expandTemplate(template: string, rows: Record<string, string>[]): BatchItem[] {
    return rows.map((row, idx) => {
      let prompt = template;
      for (const [k, v] of Object.entries(row)) {
        prompt = prompt.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
      }
      return {
        id: `batch_${idx + 1}`,
        parameters: row,
        expandedPrompt: prompt,
        status: 'pending'
      };
    });
  }

  /**
   * Executes a batch of items with concurrency management.
   */
  public async executeBatch(
    items: BatchItem[],
    workerFn: (item: BatchItem) => Promise<any>
  ): Promise<BatchSummary> {
    const start = Date.now();
    let inFlight = 0;
    let nextIdx = 0;
    let completedCount = 0;
    let failedCount = 0;

    return new Promise((resolve) => {
      const runNext = () => {
        if (nextIdx >= items.length && inFlight === 0) {
          resolve({
            total: items.length,
            completed: completedCount,
            failed: failedCount,
            durationMs: Date.now() - start,
            results: items
          });
          return;
        }

        while (inFlight < this.concurrency && nextIdx < items.length) {
          const item = items[nextIdx++];
          inFlight++;
          item.status = 'running';
          this.emit('item_started', item);

          workerFn(item)
            .then(res => {
              item.status = 'completed';
              item.result = res;
              completedCount++;
              this.emit('item_completed', item);
            })
            .catch(err => {
              item.status = 'failed';
              item.error = err?.message || String(err);
              failedCount++;
              this.emit('item_failed', item);
            })
            .finally(() => {
              inFlight--;
              runNext();
            });
        }
      };

      runNext();
    });
  }
}
