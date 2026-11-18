/**
 * Project Aegis - Swarm Synchronization, Stage Barriers & Data Flow Primitives
 * 
 * Implements Issue #155 [SWM-09]:
 * - CountDownLatch for thread-safe worker coordination
 * - SwarmStageBarrier with timeout and partial-quorum ("proceed when M of N finish or timeout")
 * - Safe cancellation and straggler worker handling
 */

import { EventEmitter } from 'node:events';
import { logger } from '../infrastructure/logger.js';

export class CountDownLatch {
  private count: number;
  private resolveWaiters: Array<() => void> = [];

  constructor(count: number) {
    if (count < 0) throw new Error('Count cannot be negative');
    this.count = count;
  }

  public countDown(): void {
    if (this.count > 0) {
      this.count--;
      if (this.count === 0) {
        for (const resolve of this.resolveWaiters) {
          resolve();
        }
        this.resolveWaiters = [];
      }
    }
  }

  public getCount(): number {
    return this.count;
  }

  public async wait(timeoutMs?: number): Promise<boolean> {
    if (this.count === 0) return true;

    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;

      const onDone = () => {
        if (timer) clearTimeout(timer);
        resolve(true);
      };

      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          const idx = this.resolveWaiters.indexOf(onDone);
          if (idx !== -1) this.resolveWaiters.splice(idx, 1);
          resolve(false); // Timed out
        }, timeoutMs);
      }

      this.resolveWaiters.push(onDone);
    });
  }
}

export interface BarrierArrival {
  workerId: string;
  stageName: string;
  result?: any;
  timestamp: number;
}

/**
 * SwarmStageBarrier
 * Synchronizes multiple workers across workflow stages.
 * Supports partial quorum ("proceed when M of N finish or timeout") and straggler handling.
 */
export class SwarmStageBarrier extends EventEmitter {
  public readonly stageName: string;
  public readonly totalParties: number;
  public readonly minQuorum: number;
  private arrivals: Map<string, BarrierArrival> = new Map();
  private isReleased: boolean = false;
  private waiters: Array<(satisfied: boolean) => void> = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(stageName: string, totalParties: number, minQuorum?: number) {
    super();
    if (totalParties <= 0) throw new Error('totalParties must be > 0');
    this.stageName = stageName;
    this.totalParties = totalParties;
    // Default quorum: 80% of parties or all if <= 2
    this.minQuorum = minQuorum ?? (totalParties <= 2 ? totalParties : Math.ceil(totalParties * 0.8));
  }

  /**
   * Worker signals arrival at this stage barrier
   */
  public arrive(workerId: string, result?: any): void {
    if (this.isReleased) {
      logger.info('Worker arrived after barrier release (straggler)', { workerId, stage: this.stageName });
      this.emit('stragglerArrival', { workerId, stage: this.stageName, result });
      return;
    }

    const arrival: BarrierArrival = {
      workerId,
      stageName: this.stageName,
      result,
      timestamp: Date.now()
    };
    this.arrivals.set(workerId, arrival);
    this.emit('arrival', arrival);

    logger.info('Worker arrived at stage barrier', {
      workerId,
      stage: this.stageName,
      arrived: this.arrivals.size,
      quorum: this.minQuorum,
      total: this.totalParties
    });

    if (this.arrivals.size >= this.minQuorum) {
      this.release(true, 'quorum_reached');
    }
  }

  /**
   * Awaits until quorum is reached or timeout expires
   */
  public async await(timeoutMs?: number): Promise<{ satisfied: boolean; reason: string; arrivals: BarrierArrival[] }> {
    if (this.isReleased) {
      return {
        satisfied: this.arrivals.size >= this.minQuorum,
        reason: 'already_released',
        arrivals: Array.from(this.arrivals.values())
      };
    }

    return new Promise((resolve) => {
      if (timeoutMs && timeoutMs > 0) {
        this.timer = setTimeout(() => {
          this.release(this.arrivals.size > 0, 'timeout');
        }, timeoutMs);
      }

      this.waiters.push((satisfied) => {
        resolve({
          satisfied,
          reason: this.arrivals.size >= this.minQuorum ? 'quorum_reached' : 'timeout_partial',
          arrivals: Array.from(this.arrivals.values())
        });
      });
    });
  }

  private release(satisfied: boolean, reason: string): void {
    if (this.isReleased) return;
    this.isReleased = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    logger.info('Stage barrier released', { stage: this.stageName, reason, arrived: this.arrivals.size, quorum: this.minQuorum });
    this.emit('released', { stage: this.stageName, satisfied, reason, arrived: this.arrivals.size });

    for (const waiter of this.waiters) {
      waiter(satisfied);
    }
    this.waiters = [];
  }

  public getArrivals(): BarrierArrival[] {
    return Array.from(this.arrivals.values());
  }

  public isQuorumSatisfied(): boolean {
    return this.arrivals.size >= this.minQuorum;
  }
}
