/**
 * Project Aegis - Worker Telemetry, Heartbeats, and Auto-Recovery Daemon
 * 
 * Implements:
 * - Issue #35: SWARM-05 Worker Telemetry, Heartbeats, and Auto-Recovery Daemon
 */

import { EventEmitter } from 'node:events';

export interface WorkerTelemetry {
  workerId: string;
  status: 'idle' | 'running' | 'stalled' | 'terminated';
  currentTaskId?: string;
  lastHeartbeat: number;
  tasksCompleted: number;
  tasksFailed: number;
  startedAt: number;
}

export class SwarmHealthDaemon extends EventEmitter {
  private workers: Map<string, WorkerTelemetry> = new Map();
  private timer: NodeJS.Timeout | null = null;
  private heartbeatTimeoutMs: number;
  private checkIntervalMs: number;
  private recoveryHandler?: (workerId: string, currentTaskId?: string) => Promise<void>;

  constructor(heartbeatTimeoutMs = 10000, checkIntervalMs = 2000) {
    super();
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.checkIntervalMs = checkIntervalMs;
  }

  public registerWorker(workerId: string): void {
    this.workers.set(workerId, {
      workerId,
      status: 'idle',
      lastHeartbeat: Date.now(),
      tasksCompleted: 0,
      tasksFailed: 0,
      startedAt: Date.now()
    });
  }

  public unregisterWorker(workerId: string): void {
    this.workers.delete(workerId);
  }

  public setRecoveryHandler(handler: (workerId: string, currentTaskId?: string) => Promise<void>): void {
    this.recoveryHandler = handler;
  }

  /**
   * Records a heartbeat ping from an active worker tab.
   */
  public heartbeat(workerId: string, currentTaskId?: string): void {
    const w = this.workers.get(workerId);
    if (w) {
      w.lastHeartbeat = Date.now();
      w.status = currentTaskId ? 'running' : 'idle';
      w.currentTaskId = currentTaskId;
    }
  }

  public recordTaskComplete(workerId: string): void {
    const w = this.workers.get(workerId);
    if (w) {
      w.tasksCompleted++;
      w.currentTaskId = undefined;
      w.status = 'idle';
    }
  }

  public recordTaskFailed(workerId: string): void {
    const w = this.workers.get(workerId);
    if (w) {
      w.tasksFailed++;
      w.currentTaskId = undefined;
      w.status = 'idle';
    }
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.scanHeartbeats(), this.checkIntervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public getTelemetry(): WorkerTelemetry[] {
    return Array.from(this.workers.values());
  }

  private async scanHeartbeats(): Promise<void> {
    const now = Date.now();
    for (const [workerId, telemetry] of this.workers.entries()) {
      if (telemetry.status === 'terminated') continue;

      const elapsed = now - telemetry.lastHeartbeat;
      if (elapsed > this.heartbeatTimeoutMs && telemetry.status !== 'stalled') {
        telemetry.status = 'stalled';
        this.emit('worker_stalled', {
          workerId,
          lastHeartbeat: telemetry.lastHeartbeat,
          elapsedMs: elapsed,
          currentTaskId: telemetry.currentTaskId
        });

        if (this.recoveryHandler) {
          try {
            await this.recoveryHandler(workerId, telemetry.currentTaskId);
            telemetry.lastHeartbeat = Date.now();
            telemetry.status = 'idle';
            this.emit('worker_recovered', { workerId });
          } catch (err) {
            telemetry.status = 'terminated';
            this.emit('worker_recovery_failed', { workerId, error: err });
          }
        }
      }
    }
  }
}
