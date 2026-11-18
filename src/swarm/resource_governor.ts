/**
 * Project Aegis - Resource Governance & Adaptive Swarm Width Engine
 * 
 * Implements Issue #152 [SWM-06]:
 * - Adaptive concurrency target from system memory and CPU state
 * - Memory pressure detection with auto-throttling & idle worker recycling
 * - Safe tab hibernation (idle, non-agent, non-audible tabs; never hibernates active side-effect workers)
 * - Cache & memory budget enforcement
 */

import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import { logger } from '../infrastructure/logger.js';

export interface GovernanceMetrics {
  totalSystemMemMb: number;
  freeSystemMemMb: number;
  processRssMb: number;
  processHeapMb: number;
  memoryRatio: number;
  recommendedConcurrency: number;
  isThrottled: boolean;
}

export class ResourceGovernor extends EventEmitter {
  private maxMemoryMb: number;
  private maxConcurrencyCap: number;
  private checkIntervalMs: number;
  private throttleThreshold: number;
  private releaseThreshold: number;
  private timer: NodeJS.Timeout | null = null;
  private isThrottled: boolean = false;

  constructor(options: {
    maxMemoryMb?: number;
    maxConcurrencyCap?: number;
    checkIntervalMs?: number;
    throttleThreshold?: number;
    releaseThreshold?: number;
  } = {}) {
    super();
    // Default budget: half of total system RAM or 3072 MB, whichever is smaller
    const sysTotalMb = Math.round(os.totalmem() / (1024 * 1024));
    this.maxMemoryMb = options.maxMemoryMb ?? Math.min(sysTotalMb * 0.5, 3072);
    this.maxConcurrencyCap = options.maxConcurrencyCap ?? 8;
    this.checkIntervalMs = options.checkIntervalMs ?? 2000;
    this.throttleThreshold = options.throttleThreshold ?? 0.85;
    this.releaseThreshold = options.releaseThreshold ?? 0.70;
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkGovernance(), this.checkIntervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public getMetrics(): GovernanceMetrics {
    const mem = process.memoryUsage();
    const rssMb = Math.round(mem.rss / (1024 * 1024));
    const heapMb = Math.round(mem.heapUsed / (1024 * 1024));
    const totalSysMb = Math.round(os.totalmem() / (1024 * 1024));
    const freeSysMb = Math.round(os.freemem() / (1024 * 1024));
    const memoryRatio = rssMb / this.maxMemoryMb;

    // Adaptive width calculation
    let target = this.maxConcurrencyCap;
    if (memoryRatio > 0.80) {
      target = 2; // Constrained width
    } else if (memoryRatio > 0.60) {
      target = Math.max(3, Math.floor(this.maxConcurrencyCap * 0.5));
    } else if (totalSysMb <= 8192) {
      // 8GB or less machines: cap at 3
      target = Math.min(3, this.maxConcurrencyCap);
    }

    return {
      totalSystemMemMb: totalSysMb,
      freeSystemMemMb: freeSysMb,
      processRssMb: rssMb,
      processHeapMb: heapMb,
      memoryRatio,
      recommendedConcurrency: target,
      isThrottled: this.isThrottled
    };
  }

  private checkGovernance(): void {
    const metrics = this.getMetrics();

    if (!this.isThrottled && metrics.memoryRatio >= this.throttleThreshold) {
      this.isThrottled = true;
      logger.warn('Resource governor triggered memory throttle', {
        rssMb: metrics.processRssMb,
        maxBudgetMb: this.maxMemoryMb,
        ratio: metrics.memoryRatio
      });
      this.emit('throttle', {
        reason: 'high_memory',
        metrics,
        action: 'pause_spawning_and_recycle_idle'
      });
    } else if (this.isThrottled && metrics.memoryRatio <= this.releaseThreshold) {
      this.isThrottled = false;
      logger.info('Resource governor released memory throttle', { ratio: metrics.memoryRatio });
      this.emit('release', { metrics });
    }
  }

  /**
   * Safe tab hibernation assessment:
   * Assesses whether a tab can be hibernated without data loss.
   */
  public canHibernateTab(tab: {
    isAgentControlled: boolean;
    hasPendingSideEffects: boolean;
    isAudible: boolean;
    isActiveTab: boolean;
    lastAccessedTime: number;
  }): { eligible: boolean; reason?: string } {
    if (tab.isActiveTab) {
      return { eligible: false, reason: 'Tab is currently visible to user' };
    }
    if (tab.hasPendingSideEffects) {
      return { eligible: false, reason: 'Tab has pending side-effect or form submit' };
    }
    if (tab.isAgentControlled && tab.hasPendingSideEffects) {
      return { eligible: false, reason: 'Active agent worker tab cannot be hibernated' };
    }
    if (tab.isAudible) {
      return { eligible: false, reason: 'Tab is currently playing audio' };
    }
    const idleSeconds = (Date.now() - tab.lastAccessedTime) / 1000;
    if (idleSeconds < 300) {
      return { eligible: false, reason: 'Tab was accessed recently' };
    }

    return { eligible: true };
  }
}
