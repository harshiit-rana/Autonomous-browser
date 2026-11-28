/**
 * Project Aegis - Worker Supervisor & Auto-Recovery Engine
 *
 * Implements Issues #153 [SWM-07] & #231 [SWX-05]:
 * - Real runtime event heartbeats per loop step, CDP response, model event, DOM mutation
 * - Monotonic timer (`performance.now()`) + suspend/sleep gap immunity + paused-worker immunity
 * - Configurable stall threshold (default 60 s): abort step, retry once, then mark `stalled`
 *   and quarantine poison tasks
 * - Event streaming to Mission Control UI
 */

import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { logger } from '../infrastructure/logger.js';

export const DEFAULT_STALL_THRESHOLD_MS = 60_000;

export type StallClass = 'model_stalled' | 'page_hung' | 'cdp_disconnected' | 'infinite_loop' | 'user_approval_timeout';

export interface WorkerHeartbeatMetrics {
  workerId: string;
  status: 'idle' | 'running' | 'paused' | 'stalled' | 'recovering' | 'terminated';
  currentTaskId?: string;
  lastEventTime: number;
  lastEventMonoMs: number;
  pausedAtMonoMs?: number;
  lastCDPResponseTime?: number;
  lastModelEventTime?: number;
  lastDOMMutationTime?: number;
  consecutiveStalls: number;
  startedAt: number;
}

export interface PoisonTaskRecord {
  taskId: string;
  failureCount: number;
  lastError: string;
  quarantinedAt: number;
}

export class WorkerSupervisor extends EventEmitter {
  private workers: Map<string, WorkerHeartbeatMetrics> = new Map();
  private taskFailureCounts: Map<string, number> = new Map();
  private poisonTasks: Map<string, PoisonTaskRecord> = new Map();
  private checkIntervalMs: number;
  private stallThresholdMs: number;
  private maxPoisonFailures: number;
  private timer: NodeJS.Timeout | null = null;
  private recoveryHandler?: (workerId: string) => Promise<void> | void;
  private monoNowFn: () => number;
  private wallNowFn: () => number;
  private lastScanWallMs: number;
  private lastScanMonoMs: number;

  constructor(
    optionsOrCheckInterval: {
      checkIntervalMs?: number;
      stallThresholdMs?: number;
      maxPoisonFailures?: number;
      monoNow?: () => number;
      wallNow?: () => number;
    } | number = {},
    stallThreshold?: number
  ) {
    super();
    if (typeof optionsOrCheckInterval === 'number') {
      this.checkIntervalMs = optionsOrCheckInterval;
      this.stallThresholdMs = stallThreshold ?? DEFAULT_STALL_THRESHOLD_MS;
      this.maxPoisonFailures = 2;
      this.monoNowFn = () => performance.now();
      this.wallNowFn = () => Date.now();
    } else {
      this.checkIntervalMs = optionsOrCheckInterval.checkIntervalMs ?? 3000;
      this.stallThresholdMs = optionsOrCheckInterval.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
      this.maxPoisonFailures = optionsOrCheckInterval.maxPoisonFailures ?? 2;
      this.monoNowFn = optionsOrCheckInterval.monoNow ?? (() => performance.now());
      this.wallNowFn = optionsOrCheckInterval.wallNow ?? (() => Date.now());
    }
    this.lastScanWallMs = this.wallNowFn();
    this.lastScanMonoMs = this.monoNowFn();
  }

  public setRecoveryHandler(handler: (workerId: string) => Promise<void> | void): void {
    this.recoveryHandler = handler;
  }

  public registerWorker(workerId: string, taskId?: string): void {
    const wall = this.wallNowFn();
    const mono = this.monoNowFn();
    this.workers.set(workerId, {
      workerId,
      status: 'running',
      currentTaskId: taskId,
      lastEventTime: wall,
      lastEventMonoMs: mono,
      consecutiveStalls: 0,
      startedAt: wall
    });
  }

  public unregisterWorker(workerId: string): void {
    this.workers.delete(workerId);
  }

  /** Marks a worker paused (or in takeover / waiting_user) so pause duration never counts toward stall timeouts. */
  public pauseWorker(workerId: string): void {
    const w = this.workers.get(workerId);
    if (!w || w.status === 'paused') return;
    w.status = 'paused';
    w.pausedAtMonoMs = this.monoNowFn();
  }

  /** Resumes supervision for a worker after pause/takeover, shifting its monotonic baseline by the paused duration. */
  public resumeWorker(workerId: string): void {
    const w = this.workers.get(workerId);
    if (!w) return;
    const mono = this.monoNowFn();
    const wall = this.wallNowFn();
    w.lastEventMonoMs = mono;
    w.lastEventTime = wall;
    w.pausedAtMonoMs = undefined;
    w.status = w.currentTaskId ? 'running' : 'idle';
  }

  /** Records a real runtime activity event (step progress, CDP response, model event, DOM mutation). */
  public recordEvent(
    workerId: string,
    eventType: 'cdp_response' | 'model_event' | 'dom_mutation' | 'action_dispatched' | 'step_progress',
    taskId?: string
  ): void {
    const w = this.workers.get(workerId);
    if (!w) return;

    const wall = this.wallNowFn();
    const mono = this.monoNowFn();
    w.lastEventTime = wall;
    w.lastEventMonoMs = mono;
    if (w.status !== 'paused') {
      w.status = taskId ? 'running' : 'idle';
    }
    if (taskId) w.currentTaskId = taskId;

    if (eventType === 'cdp_response') w.lastCDPResponseTime = wall;
    if (eventType === 'model_event') w.lastModelEventTime = wall;
    if (eventType === 'dom_mutation') w.lastDOMMutationTime = wall;
    w.consecutiveStalls = 0;
  }

  public start(): void {
    if (this.timer) return;
    this.lastScanWallMs = this.wallNowFn();
    this.lastScanMonoMs = this.monoNowFn();
    this.timer = setInterval(() => this.scanSupervision(), this.checkIntervalMs);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Scans for stalled workers using monotonic clock deltas, ignoring sleep/suspend clock jumps and paused workers.
   */
  public scanSupervision(): void {
    const wallNow = this.wallNowFn();
    const monoNow = this.monoNowFn();

    const wallDelta = wallNow - this.lastScanWallMs;
    const monoDelta = monoNow - this.lastScanMonoMs;
    this.lastScanWallMs = wallNow;
    this.lastScanMonoMs = monoNow;

    // Sleep/suspend guard: if wall clock jumped significantly further than monotonic clock (or vice versa),
    // re-baseline active worker timestamps instead of firing false stalls on wake-up.
    const skew = Math.abs(wallDelta - monoDelta);
    if (skew > Math.max(15_000, this.stallThresholdMs * 0.5)) {
      logger.info('Supervisor detected clock suspend/sleep jump; rebasing worker baselines', { skewMs: Math.round(skew) });
      for (const telemetry of this.workers.values()) {
        telemetry.lastEventMonoMs = monoNow;
        telemetry.lastEventTime = wallNow;
      }
      return;
    }

    for (const [workerId, telemetry] of this.workers.entries()) {
      if (telemetry.status === 'paused' || telemetry.status === 'idle' || telemetry.status === 'terminated' || telemetry.status === 'stalled') {
        continue;
      }
      const elapsed = monoNow - telemetry.lastEventMonoMs;
      if (elapsed <= this.stallThresholdMs) continue;

      telemetry.consecutiveStalls += 1;

      let stallClass: StallClass = 'page_hung';
      if (telemetry.lastModelEventTime && wallNow - telemetry.lastModelEventTime > this.stallThresholdMs) {
        stallClass = 'model_stalled';
      }

      logger.warn('Worker supervisor detected stall', {
        workerId,
        taskId: telemetry.currentTaskId,
        elapsedMs: Math.round(elapsed),
        stallClass,
        stalls: telemetry.consecutiveStalls
      });

      let quarantinedNow = false;
      if (telemetry.currentTaskId) {
        const currentFails = (this.taskFailureCounts.get(telemetry.currentTaskId) || 0) + 1;
        this.taskFailureCounts.set(telemetry.currentTaskId, currentFails);
        if (currentFails >= this.maxPoisonFailures && !this.poisonTasks.has(telemetry.currentTaskId)) {
          const poisonRecord: PoisonTaskRecord = {
            taskId: telemetry.currentTaskId,
            failureCount: currentFails,
            lastError: `Task repeatedly hung worker (${stallClass})`,
            quarantinedAt: wallNow
          };
          this.poisonTasks.set(telemetry.currentTaskId, poisonRecord);
          logger.error('Task quarantined as POISON TASK', undefined, { taskId: telemetry.currentTaskId });
          this.emit('poisonTask', poisonRecord);
          quarantinedNow = true;
        }
      }

      // First stall triggers abort & single retry (`recovering`); repeated stall marks worker `stalled`.
      const finalStall = telemetry.consecutiveStalls >= this.maxPoisonFailures || quarantinedNow;
      telemetry.status = finalStall ? 'stalled' : 'recovering';
      // Reset monotonic baseline so a retrying attempt gets a fresh full window unless already permanently stalled
      telemetry.lastEventMonoMs = monoNow;

      this.emit('workerStalled', {
        workerId,
        taskId: telemetry.currentTaskId,
        stallClass,
        stalls: telemetry.consecutiveStalls,
        final: finalStall,
        action: telemetry.consecutiveStalls > 1 ? 'restart_worker' : 'abort_and_retry'
      });

      if (this.recoveryHandler) {
        Promise.resolve(this.recoveryHandler(workerId)).catch(() => {});
      }
    }
  }

  /**
   * A task attempt ended in failure (budget exhausted, timeout, crash, stall). The second failure of the same task
   * quarantines it as poison so it is not restarted again (#227). Returns true when the task is now quarantined.
   */
  public recordTaskFailure(taskId: string, error: string): boolean {
    const count = (this.taskFailureCounts.get(taskId) || 0) + 1;
    this.taskFailureCounts.set(taskId, count);
    if (count < this.maxPoisonFailures) return false;
    if (!this.poisonTasks.has(taskId)) {
      const record: PoisonTaskRecord = { taskId, failureCount: count, lastError: error, quarantinedAt: this.wallNowFn() };
      this.poisonTasks.set(taskId, record);
      logger.error('Task quarantined as POISON TASK', undefined, { taskId, error });
      this.emit('poisonTask', record);
    }
    return true;
  }

  public isTaskQuarantined(taskId: string): boolean {
    return this.poisonTasks.has(taskId);
  }

  public getQuarantinedTasks(): PoisonTaskRecord[] {
    return Array.from(this.poisonTasks.values());
  }

  public getTelemetry(workerId: string): WorkerHeartbeatMetrics | undefined {
    return this.workers.get(workerId);
  }

  public listTelemetry(): WorkerHeartbeatMetrics[] {
    return Array.from(this.workers.values());
  }

  public clear(): void {
    this.workers.clear();
    this.taskFailureCounts.clear();
    this.poisonTasks.clear();
  }
}

// Backward compatibility aliases
export { WorkerSupervisor as SwarmHealthDaemon };
export type { WorkerHeartbeatMetrics as WorkerTelemetry };
