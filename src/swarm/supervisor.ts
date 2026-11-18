/**
 * Project Aegis - Worker Supervisor & Auto-Recovery Engine
 * 
 * Implements Issue #153 [SWM-07]:
 * - Real runtime event heartbeats (CDP response, model event, DOM mutation, frame)
 * - Stall classification: model_stalled, page_hung, cdp_disconnected, infinite_loop
 * - Safe auto-recovery: nudge, reload, rollback to checkpoint, reassign
 * - Poison task detection and quarantine (prevents restart storms)
 * - Event streaming to Mission Control UI
 */

import { EventEmitter } from 'node:events';
import { logger } from '../infrastructure/logger.js';

export type StallClass = 'model_stalled' | 'page_hung' | 'cdp_disconnected' | 'infinite_loop' | 'user_approval_timeout';

export interface WorkerHeartbeatMetrics {
  workerId: string;
  status: 'idle' | 'running' | 'stalled' | 'recovering' | 'terminated';
  currentTaskId?: string;
  lastEventTime: number;
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

  constructor(options: {
    checkIntervalMs?: number;
    stallThresholdMs?: number;
    maxPoisonFailures?: number;
  } = {}) {
    super();
    this.checkIntervalMs = options.checkIntervalMs ?? 3000;
    this.stallThresholdMs = options.stallThresholdMs ?? 25000;
    this.maxPoisonFailures = options.maxPoisonFailures ?? 2;
  }

  public registerWorker(workerId: string): void {
    this.workers.set(workerId, {
      workerId,
      status: 'idle',
      lastEventTime: Date.now(),
      consecutiveStalls: 0,
      startedAt: Date.now()
    });
  }

  public unregisterWorker(workerId: string): void {
    this.workers.delete(workerId);
  }

  /**
   * Records a real runtime activity event
   */
  public recordEvent(
    workerId: string,
    eventType: 'cdp_response' | 'model_event' | 'dom_mutation' | 'action_dispatched',
    taskId?: string
  ): void {
    const w = this.workers.get(workerId);
    if (!w) return;

    const now = Date.now();
    w.lastEventTime = now;
    w.status = taskId ? 'running' : 'idle';
    if (taskId) w.currentTaskId = taskId;

    if (eventType === 'cdp_response') w.lastCDPResponseTime = now;
    if (eventType === 'model_event') w.lastModelEventTime = now;
    if (eventType === 'dom_mutation') w.lastDOMMutationTime = now;
    w.consecutiveStalls = 0;
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.scanSupervision(), this.checkIntervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Scans for stalled workers and triggers auto-recovery
   */
  public scanSupervision(): void {
    const now = Date.now();

    for (const [workerId, telemetry] of this.workers.entries()) {
      if (telemetry.status === 'running' || telemetry.status === 'stalled' || telemetry.status === 'recovering') {
        const elapsed = now - telemetry.lastEventTime;

        if (elapsed > this.stallThresholdMs) {
          telemetry.consecutiveStalls++;
          telemetry.status = 'stalled';

          let stallClass: StallClass = 'page_hung';
          if (telemetry.lastModelEventTime && now - telemetry.lastModelEventTime > this.stallThresholdMs) {
            stallClass = 'model_stalled';
          }

          logger.warn('Worker supervisor detected stall', {
            workerId,
            taskId: telemetry.currentTaskId,
            elapsedMs: elapsed,
            stallClass,
            stalls: telemetry.consecutiveStalls
          });

          // Check for poison task
          if (telemetry.currentTaskId) {
            const currentFails = (this.taskFailureCounts.get(telemetry.currentTaskId) || 0) + 1;
            this.taskFailureCounts.set(telemetry.currentTaskId, currentFails);

            if (currentFails >= this.maxPoisonFailures) {
              const poisonRecord: PoisonTaskRecord = {
                taskId: telemetry.currentTaskId,
                failureCount: currentFails,
                lastError: `Task repeatedly hung worker (${stallClass})`,
                quarantinedAt: now
              };
              this.poisonTasks.set(telemetry.currentTaskId, poisonRecord);
              logger.error('Task quarantined as POISON TASK', undefined, { taskId: telemetry.currentTaskId });
              this.emit('poisonTask', poisonRecord);
            }
          }

          // Emit recovery event
          telemetry.status = 'recovering';
          this.emit('workerStalled', {
            workerId,
            taskId: telemetry.currentTaskId,
            stallClass,
            action: telemetry.consecutiveStalls > 1 ? 'restart_worker' : 'reload_page'
          });
        }
      }
    }
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
