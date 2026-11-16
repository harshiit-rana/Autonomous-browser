/**
 * Project Aegis - Worker Tab Memory & Resource Throttler
 * 
 * Implements:
 * - Issue #31: SWARM-01 Worker Tab Memory & Resource Throttler
 */

import { EventEmitter } from 'node:events';

export interface ThrottlerConfig {
  maxMemoryMb: number; // e.g. 2048 MB
  checkIntervalMs: number; // e.g. 2000 ms
  throttleThresholdPercent: number; // e.g. 0.85 (85%)
  releaseThresholdPercent: number; // e.g. 0.70 (70%)
}

export interface ResourceMetrics {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  isThrottled: boolean;
}

export class SwarmResourceThrottler extends EventEmitter {
  private config: ThrottlerConfig;
  private timer: NodeJS.Timeout | null = null;
  private isThrottled = false;

  constructor(config: Partial<ThrottlerConfig> = {}) {
    super();
    this.config = {
      maxMemoryMb: config.maxMemoryMb ?? 2048,
      checkIntervalMs: config.checkIntervalMs ?? 2000,
      throttleThresholdPercent: config.throttleThresholdPercent ?? 0.85,
      releaseThresholdPercent: config.releaseThresholdPercent ?? 0.70
    };
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkResources(), this.config.checkIntervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public getMetrics(): ResourceMetrics {
    const mem = process.memoryUsage();
    const rssMb = Math.round(mem.rss / (1024 * 1024));
    const heapUsedMb = Math.round(mem.heapUsed / (1024 * 1024));
    const heapTotalMb = Math.round(mem.heapTotal / (1024 * 1024));
    const externalMb = Math.round(mem.external / (1024 * 1024));

    return {
      rssMb,
      heapUsedMb,
      heapTotalMb,
      externalMb,
      isThrottled: this.isThrottled
    };
  }

  private checkResources(): void {
    const metrics = this.getMetrics();
    const memoryRatio = metrics.rssMb / this.config.maxMemoryMb;

    if (!this.isThrottled && memoryRatio >= this.config.throttleThresholdPercent) {
      this.isThrottled = true;
      this.emit('throttle', {
        reason: 'high_memory',
        metrics,
        memoryRatio
      });
    } else if (this.isThrottled && memoryRatio <= this.config.releaseThresholdPercent) {
      this.isThrottled = false;
      this.emit('release', {
        metrics,
        memoryRatio
      });
    }
  }
}
