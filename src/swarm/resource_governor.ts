/**
 * Project Aegis - Resource Governance & Adaptive Swarm Width Engine
 *
 * Implements Issues #152 [SWM-06] & #231 [SWX-05]:
 * - Real live metrics: Electron `app.getAppMetrics()` (per-process CPU & working set),
 *   `webContents.getAllWebContents()` count, `os.freemem()` / `process.memoryUsage()`,
 *   and `perf_hooks.monitorEventLoopDelay()` event-loop lag sampled every 2 s.
 * - Monotonic timestamps (`performance.now()`) & conservative fallback if metrics fail.
 * - Adaptive concurrency width with hysteresis and human-readable limit reasons
 *   (e.g. "limited by memory", "limited by CPU") surfaced to Mission Control UI.
 * - Safe tab hibernation predicate for idle background tabs.
 */

import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { monitorEventLoopDelay, performance, type IntervalHistogram } from 'node:perf_hooks';
import { logger } from '../infrastructure/logger.js';

let cachedAvailSample: { monoMs: number; mb: number } | null = null;

/**
 * Reads truly available system memory in MB:
 * - Linux: parses `/proc/meminfo` `MemAvailable:` (includes reclaimable page cache)
 * - macOS: sums free + inactive + speculative + purgeable pages from `vm_stat` (cached 2 s)
 * - Windows / fallback: `os.freemem()`
 */
function readAvailableSystemMemMb(): number {
  const nowMono = performance.now();
  if (cachedAvailSample && nowMono - cachedAvailSample.monoMs < 2000) {
    return cachedAvailSample.mb;
  }
  let mb = Math.round(os.freemem() / (1024 * 1024));
  try {
    if (process.platform === 'linux') {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
      const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo);
      if (m) mb = Math.round(Number(m[1]) / 1024);
    } else if (process.platform === 'darwin') {
      const out = execFileSync('vm_stat', { encoding: 'utf8', timeout: 500 });
      const pageMatch = /page size of (\d+) bytes/i.exec(out);
      const pageBytes = pageMatch ? Number(pageMatch[1]) : 4096;
      const pages = (label: string) => {
        const r = new RegExp(`Pages ${label}:\\s+(\\d+)\\.`, 'i').exec(out);
        return r ? Number(r[1]) : 0;
      };
      const availPages = pages('free') + pages('inactive') + pages('speculative') + pages('purgeable');
      if (availPages > 0) mb = Math.round((availPages * pageBytes) / (1024 * 1024));
    }
  } catch {
    // Keep os.freemem() fallback
  }
  cachedAvailSample = { monoMs: nowMono, mb };
  return mb;
}

export interface ProcessMetricSample {
  type: string;
  pid: number;
  cpuPercent: number;
  workingSetMb: number;
}

export interface GovernanceMetrics {
  totalSystemMemMb: number;
  freeSystemMemMb: number;
  processRssMb: number;
  processHeapMb: number;
  appWorkingSetMb: number;
  cpuPercent: number;
  activeWebContentsCount: number;
  eventLoopLagMs: number;
  memoryRatio: number;
  recommendedConcurrency: number;
  isThrottled: boolean;
  limitReason: 'memory' | 'cpu' | 'event_loop' | null;
  limitDescription: string | null;
  processBreakdown: ProcessMetricSample[];
  metricsAvailable: boolean;
}

export interface ElectronMetricsSource {
  getAppMetrics: () => Array<{
    pid: number;
    type: string;
    cpu?: { percentCPUUsage?: number };
    memory?: { workingSetSize?: number };
  }>;
  getWebContentsCount?: () => number;
}

let globalElectronSource: ElectronMetricsSource | null = null;

/** Called once by `src/main/index.ts` at app ready to connect Electron `app.getAppMetrics()` & `webContents`. */
export function registerElectronMetricsSource(source: ElectronMetricsSource | null): void {
  globalElectronSource = source;
}

export interface RawSampleOverride {
  totalSystemMemMb?: number;
  freeSystemMemMb?: number;
  processRssMb?: number;
  processHeapMb?: number;
  cpuPercent?: number;
  appWorkingSetMb?: number;
  activeWebContentsCount?: number;
  eventLoopLagMs?: number;
  processBreakdown?: ProcessMetricSample[];
  metricsAvailable?: boolean;
}

export interface ResourceGovernorOptions {
  maxMemoryMb?: number;
  maxConcurrencyCap?: number;
  checkIntervalMs?: number;
  throttleThreshold?: number;
  releaseThreshold?: number;
  cpuThrottlePercent?: number;
  cpuReleasePercent?: number;
  minFreeMemMb?: number;
  releaseFreeMemMb?: number;
  sampleOverride?: () => RawSampleOverride;
}

export class ResourceGovernor extends EventEmitter {
  private maxMemoryMb: number;
  private maxConcurrencyCap: number;
  private checkIntervalMs: number;
  private throttleThreshold: number;
  private releaseThreshold: number;
  private cpuThrottlePercent: number;
  private cpuReleasePercent: number;
  private minFreeMemMb: number;
  private releaseFreeMemMb: number;
  private sampleOverride?: () => RawSampleOverride;

  private timer: NodeJS.Timeout | null = null;
  private loopMonitor: IntervalHistogram | null = null;
  private isThrottled = false;
  private limitReason: GovernanceMetrics['limitReason'] = null;
  private lastRecommended: number;
  private healthyStreak = 0;

  private lastCpuUsage = process.cpuUsage();
  private lastCpuSampleMonoMs = performance.now();
  private lastSampledMetrics: GovernanceMetrics | null = null;

  constructor(options: ResourceGovernorOptions = {}) {
    super();
    const sysTotalMb = Math.round(os.totalmem() / (1024 * 1024));
    this.maxMemoryMb = options.maxMemoryMb ?? Math.min((sysTotalMb || 8192) * 0.5, 3072);
    this.maxConcurrencyCap = Math.max(1, options.maxConcurrencyCap ?? 8);
    this.checkIntervalMs = options.checkIntervalMs ?? 2000;
    this.throttleThreshold = options.throttleThreshold ?? 0.85;
    this.releaseThreshold = options.releaseThreshold ?? 0.70;
    this.cpuThrottlePercent = options.cpuThrottlePercent ?? 85;
    this.cpuReleasePercent = options.cpuReleasePercent ?? 70;
    this.minFreeMemMb = options.minFreeMemMb ?? 1024;
    this.releaseFreeMemMb = options.releaseFreeMemMb ?? 1400;
    this.sampleOverride = options.sampleOverride;
    this.lastRecommended = this.computeBaseCap(sysTotalMb);
  }

  private computeBaseCap(totalSysMb: number): number {
    if (totalSysMb > 0 && totalSysMb <= 8192) {
      return Math.min(3, this.maxConcurrencyCap);
    }
    return this.maxConcurrencyCap;
  }

  public start(): void {
    if (this.timer) return;
    try {
      if (!this.loopMonitor) {
        this.loopMonitor = monitorEventLoopDelay({ resolution: 20 });
        this.loopMonitor.enable();
      }
    } catch {
      this.loopMonitor = null;
    }
    this.checkGovernance();
    this.timer = setInterval(() => this.checkGovernance(), this.checkIntervalMs);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.loopMonitor) {
      try {
        this.loopMonitor.disable();
      } catch {
        // already disabled
      }
      this.loopMonitor = null;
    }
  }

  public getMetrics(): GovernanceMetrics {
    if (this.lastSampledMetrics && !this.sampleOverride) {
      // Always compute fresh on direct callers unless cached within the same 250ms window
    }
    return this.sampleNow();
  }

  private sampleNow(): GovernanceMetrics {
    let metricsAvailable = true;
    let totalSysMb = 0;
    let freeSysMb = 0;
    let rssMb = 0;
    let heapMb = 0;
    let cpuPercent = 0;
    let appWorkingSetMb = 0;
    let activeWebContentsCount = 0;
    let eventLoopLagMs = 0;
    let processBreakdown: ProcessMetricSample[] = [];

    try {
      const ov = this.sampleOverride?.();
      const mem = process.memoryUsage();
      rssMb = ov?.processRssMb ?? Math.round(mem.rss / (1024 * 1024));
      heapMb = ov?.processHeapMb ?? Math.round(mem.heapUsed / (1024 * 1024));
      totalSysMb = ov?.totalSystemMemMb ?? Math.round(os.totalmem() / (1024 * 1024));
      freeSysMb = ov?.freeSystemMemMb ?? readAvailableSystemMemMb();

      if (ov?.metricsAvailable === false || !Number.isFinite(totalSysMb) || !Number.isFinite(freeSysMb) || totalSysMb <= 0) {
        metricsAvailable = false;
      }

      if (ov?.processBreakdown) {
        processBreakdown = ov.processBreakdown;
      } else if (globalElectronSource) {
        try {
          const rawMetrics = globalElectronSource.getAppMetrics();
          processBreakdown = rawMetrics.map(m => ({
            type: m.type || 'Unknown',
            pid: m.pid,
            cpuPercent: Number((m.cpu?.percentCPUUsage ?? 0).toFixed(1)),
            workingSetMb: Math.round((m.memory?.workingSetSize ?? 0) / 1024)
          }));
          activeWebContentsCount = ov?.activeWebContentsCount ?? (globalElectronSource.getWebContentsCount?.() ?? 0);
        } catch {
          processBreakdown = [];
        }
      }

      if (ov?.activeWebContentsCount !== undefined) {
        activeWebContentsCount = ov.activeWebContentsCount;
      }

      if (ov?.cpuPercent !== undefined) {
        cpuPercent = ov.cpuPercent;
      } else if (processBreakdown.length > 0) {
        // Normalize Chromium aggregate CPU by logical core count so 1 full core on an 8-core box doesn't read 100% host saturation
        const cores = Math.max(1, os.cpus().length || 1);
        const rawSum = processBreakdown.reduce((s, p) => s + p.cpuPercent, 0);
        cpuPercent = Number(Math.min(100, rawSum / cores).toFixed(1));
      } else {
        const nowMono = performance.now();
        const elapsedMs = Math.max(1, nowMono - this.lastCpuSampleMonoMs);
        const delta = process.cpuUsage(this.lastCpuUsage);
        this.lastCpuUsage = process.cpuUsage();
        this.lastCpuSampleMonoMs = nowMono;
        const usedMs = (delta.user + delta.system) / 1000;
        const cores = Math.max(1, os.cpus().length || 1);
        cpuPercent = Number(Math.min(100, Math.max(0, (usedMs / (elapsedMs * cores)) * 100)).toFixed(1));
      }

      if (ov?.appWorkingSetMb !== undefined) {
        appWorkingSetMb = ov.appWorkingSetMb;
      } else if (processBreakdown.length > 0) {
        appWorkingSetMb = processBreakdown.reduce((s, p) => s + p.workingSetMb, 0);
      } else {
        appWorkingSetMb = rssMb;
      }

      if (ov?.eventLoopLagMs !== undefined) {
        eventLoopLagMs = ov.eventLoopLagMs;
      } else if (this.loopMonitor) {
        const meanNs = this.loopMonitor.mean;
        eventLoopLagMs = Number.isFinite(meanNs) && meanNs > 0 ? Number((meanNs / 1e6).toFixed(2)) : 0;
        this.loopMonitor.reset();
      }
    } catch {
      metricsAvailable = false;
    }

    const effectiveMemMb = Math.max(rssMb, appWorkingSetMb);
    const memoryRatio = this.maxMemoryMb > 0 ? Number((effectiveMemMb / this.maxMemoryMb).toFixed(3)) : 0;
    const baseCap = this.computeBaseCap(totalSysMb);

    if (!metricsAvailable) {
      // Conservative fallback when OS metrics cannot be read
      const fallbackWidth = Math.max(1, Math.min(2, baseCap));
      const res: GovernanceMetrics = {
        totalSystemMemMb: totalSysMb,
        freeSystemMemMb: freeSysMb,
        processRssMb: rssMb,
        processHeapMb: heapMb,
        appWorkingSetMb,
        cpuPercent,
        activeWebContentsCount,
        eventLoopLagMs,
        memoryRatio,
        recommendedConcurrency: fallbackWidth,
        isThrottled: false,
        limitReason: null,
        limitDescription: null,
        processBreakdown,
        metricsAvailable: false
      };
      this.lastSampledMetrics = res;
      return res;
    }

    // Determine pressure / throttling reasons
    const memLow = totalSysMb > 0 && freeSysMb < this.minFreeMemMb;
    const memRatioHigh = memoryRatio >= this.throttleThreshold;
    const cpuHigh = cpuPercent > this.cpuThrottlePercent;
    const lagHigh = eventLoopLagMs > 250;

    let candidateTarget = baseCap;
    let activeReason: GovernanceMetrics['limitReason'] = null;

    if (memLow || memRatioHigh) {
      activeReason = 'memory';
      candidateTarget = freeSysMb < 512 || memoryRatio > 0.92 ? 1 : Math.min(2, baseCap);
    } else if (cpuHigh) {
      activeReason = 'cpu';
      candidateTarget = cpuPercent > 95 ? 1 : Math.min(2, baseCap);
    } else if (lagHigh) {
      activeReason = 'event_loop';
      candidateTarget = Math.min(2, baseCap);
    } else if (memoryRatio > 0.60) {
      candidateTarget = Math.max(2, Math.floor(baseCap * 0.5));
    }

    // Hysteresis: immediate drop on pressure, gradual / debounced recovery once below release thresholds
    let recommended = Math.max(1, Math.min(baseCap, candidateTarget));
    const healthyForRelease =
      memoryRatio <= this.releaseThreshold &&
      cpuPercent <= this.cpuReleasePercent &&
      (totalSysMb <= 0 || freeSysMb >= this.releaseFreeMemMb) &&
      eventLoopLagMs <= 120;

    if (recommended < this.lastRecommended) {
      this.healthyStreak = 0;
      this.lastRecommended = recommended;
    } else if (recommended > this.lastRecommended) {
      if (!this.isThrottled) {
        this.lastRecommended = recommended;
        this.healthyStreak = 0;
      } else if (healthyForRelease) {
        this.healthyStreak += 1;
        // Require 2 clean recovery readings while throttled before scaling back up +1 at a time to avoid oscillation
        if (this.healthyStreak >= 2) {
          this.lastRecommended = Math.min(recommended, this.lastRecommended + 1);
          this.healthyStreak = 0;
        }
      }
      recommended = this.lastRecommended;
    }

    if (activeReason) {
      this.limitReason = activeReason;
    } else if (healthyForRelease || recommended >= baseCap) {
      this.limitReason = null;
    }

    const limitDescription =
      this.limitReason === 'memory'
        ? 'limited by memory'
        : this.limitReason === 'cpu'
        ? 'limited by CPU'
        : this.limitReason === 'event_loop'
        ? 'limited by event loop'
        : null;

    const metrics: GovernanceMetrics = {
      totalSystemMemMb: totalSysMb,
      freeSystemMemMb: freeSysMb,
      processRssMb: rssMb,
      processHeapMb: heapMb,
      appWorkingSetMb,
      cpuPercent,
      activeWebContentsCount,
      eventLoopLagMs,
      memoryRatio,
      recommendedConcurrency: recommended,
      isThrottled: this.isThrottled,
      limitReason: this.limitReason,
      limitDescription,
      processBreakdown,
      metricsAvailable: true
    };
    this.lastSampledMetrics = metrics;
    return metrics;
  }

  private checkGovernance(): void {
    const metrics = this.sampleNow();
    const shouldThrottle =
      metrics.metricsAvailable &&
      (metrics.memoryRatio >= this.throttleThreshold ||
        metrics.cpuPercent > this.cpuThrottlePercent ||
        (metrics.totalSystemMemMb > 0 && metrics.freeSystemMemMb < this.minFreeMemMb) ||
        metrics.eventLoopLagMs > 250);

    const canRelease =
      metrics.memoryRatio <= this.releaseThreshold &&
      metrics.cpuPercent <= this.cpuReleasePercent &&
      (metrics.totalSystemMemMb <= 0 || metrics.freeSystemMemMb >= this.releaseFreeMemMb) &&
      metrics.eventLoopLagMs <= 120;

    if (!this.isThrottled && shouldThrottle) {
      this.isThrottled = true;
      metrics.isThrottled = true;
      logger.warn('Resource governor triggered pressure throttle', {
        rssMb: metrics.processRssMb,
        workingSetMb: metrics.appWorkingSetMb,
        freeSystemMemMb: metrics.freeSystemMemMb,
        cpuPercent: metrics.cpuPercent,
        eventLoopLagMs: metrics.eventLoopLagMs,
        reason: metrics.limitReason
      });
      this.emit('throttle', {
        reason: metrics.limitReason || 'high_memory',
        metrics,
        action: 'pause_spawning_and_recycle_idle'
      });
    } else if (this.isThrottled && canRelease) {
      this.isThrottled = false;
      this.limitReason = null;
      metrics.isThrottled = false;
      metrics.limitReason = null;
      metrics.limitDescription = null;
      logger.info('Resource governor released throttle', {
        ratio: metrics.memoryRatio,
        cpuPercent: metrics.cpuPercent,
        freeSystemMemMb: metrics.freeSystemMemMb
      });
      this.emit('release', { metrics });
    }

    this.emit('metrics', metrics);
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
    if (tab.isAgentControlled) {
      return { eligible: false, reason: 'Agent worker tab cannot be hibernated' };
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

// Backward compatibility aliases
export { ResourceGovernor as SwarmResourceThrottler };
export type { GovernanceMetrics as ResourceMetrics };
