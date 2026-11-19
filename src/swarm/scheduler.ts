/**
 * Project Aegis - Central Swarm Scheduler & Work Distribution Engine
 * 
 * Implements Issue #149 [SWM-03]:
 * - DAG dependency resolution & task status lifecycles
 * - Priority and deadline-based queue dispatch
 * - Hazard-safe work-stealing (only independent read tasks)
 * - Per-task retries with error classification
 * - Fairness and politeness pacing integration with URLFrontier
 */

import { URLFrontier } from './url_frontier.js';
import { logger } from '../infrastructure/logger.js';

export type TaskEffectClass = 'read' | 'write-idempotent' | 'write-non-idempotent' | 'financial';
export type TaskRole = 'researcher' | 'extractor' | 'actor' | 'verifier' | 'summariser';
export type TaskStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ScheduledTask {
  id: string;
  missionId: string;
  name: string;
  role: TaskRole;
  url?: string;
  instruction: string;
  priority: number; // Higher number = executed first
  deadline?: number;
  dependencies: string[];
  effectClass: TaskEffectClass;
  maxRetries: number;
  retryCount: number;
  status: TaskStatus;
  assignedWorkerId?: string;
  result?: any;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export class SwarmScheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private workerDeques: Map<string, string[]> = new Map(); // workerId -> taskIds
  private frontier: URLFrontier;

  constructor(frontierOrWorkers?: URLFrontier | number) {
    this.frontier = (frontierOrWorkers && typeof frontierOrWorkers === 'object') ? frontierOrWorkers : new URLFrontier();
  }

  public registerWorker(workerId: string): void {
    if (!this.workerDeques.has(workerId)) {
      this.workerDeques.set(workerId, []);
    }
  }

  public unregisterWorker(workerId: string): void {
    const assignedTaskIds = this.workerDeques.get(workerId) || [];
    this.workerDeques.delete(workerId);

    // Re-queue assigned running or ready tasks
    for (const taskId of assignedTaskIds) {
      const task = this.tasks.get(taskId);
      if (task && (task.status === 'ready' || task.status === 'running')) {
        task.status = 'ready';
        task.assignedWorkerId = undefined;
        logger.info('Re-queued task from unregistered worker', { taskId, workerId });
      }
    }
  }

  public addTask(taskInput: Omit<ScheduledTask, 'status' | 'retryCount' | 'createdAt'>): ScheduledTask {
    const task: ScheduledTask = {
      ...taskInput,
      status: 'pending',
      retryCount: 0,
      createdAt: Date.now()
    };

    this.tasks.set(task.id, task);
    this.refreshTaskReadiness(task);
    return task;
  }

  public pushTask(taskInput: any, workerId?: string): ScheduledTask {
    const task = this.addTask({
      id: taskInput.id || `task_${Date.now()}`,
      missionId: taskInput.missionId || 'default_mission',
      name: taskInput.name || taskInput.id,
      instruction: taskInput.instruction || taskInput.actionType || 'execute',
      role: taskInput.role || 'researcher',
      effectClass: taskInput.effectClass || (taskInput.actionType === 'scrape' ? 'read' : 'read'),
      dependencies: taskInput.dependencies || [],
      priority: taskInput.priority || 5,
      maxRetries: taskInput.maxRetries ?? 3,
      url: taskInput.url
    });

    if (workerId) {
      this.registerWorker(workerId);
      this.workerDeques.get(workerId)!.push(task.id);
    }

    return task;
  }

  /**
   * Refreshes whether a task's dependencies are satisfied
   */
  private refreshTaskReadiness(task: ScheduledTask): void {
    if (task.status !== 'pending') return;

    if (task.dependencies.length === 0) {
      task.status = 'ready';
      return;
    }

    const allDepsCompleted = task.dependencies.every(depId => {
      const dep = this.tasks.get(depId);
      return dep && dep.status === 'completed';
    });

    const anyDepFailedOrCancelled = task.dependencies.some(depId => {
      const dep = this.tasks.get(depId);
      return dep && (dep.status === 'failed' || dep.status === 'cancelled');
    });

    if (anyDepFailedOrCancelled) {
      task.status = 'cancelled';
      task.error = 'Dependency failed or cancelled';
      logger.info('Task cancelled due to dependency failure', { taskId: task.id });
    } else if (allDepsCompleted) {
      task.status = 'ready';
    }
  }

  /**
   * Assigns and dispatches the next ready task for a worker:
   * 1. Check worker's designated queue.
   * 2. Scan global ready tasks ordered by priority & deadline.
   * 3. Work-stealing: safely steal oldest independent read task from busiest peer.
   */
  public getNextTask(workerId: string): ScheduledTask | null {
    this.registerWorker(workerId);

    // Update readiness of all pending tasks
    for (const task of this.tasks.values()) {
      if (task.status === 'pending') {
        this.refreshTaskReadiness(task);
      }
    }

    // 1. Check local deque
    const localTaskIds = this.workerDeques.get(workerId)!;
    while (localTaskIds.length > 0) {
      const candidateId = localTaskIds.shift()!;
      const candidate = this.tasks.get(candidateId);
      if (candidate && candidate.status === 'ready') {
        if (this.isPolitenessAllowed(candidate)) {
          return this.dispatchTask(candidate, workerId);
        }
        // If throttled, re-queue to back
        localTaskIds.push(candidateId);
        break;
      }
    }

    // 2. Scan global pool of ready tasks
    const readyCandidates = Array.from(this.tasks.values())
      .filter(t => t.status === 'ready' && !t.assignedWorkerId)
      .sort((a, b) => {
        // Priority descending
        if (b.priority !== a.priority) return b.priority - a.priority;
        // Deadline ascending (earliest first)
        if (a.deadline && b.deadline) return a.deadline - b.deadline;
        if (a.deadline) return -1;
        if (b.deadline) return 1;
        return a.createdAt - b.createdAt;
      });

    for (const candidate of readyCandidates) {
      if (this.isPolitenessAllowed(candidate)) {
        return this.dispatchTask(candidate, workerId);
      }
    }

    // 3. Work-Stealing: Safe work-stealing from peer worker
    let busiestWorkerId: string | null = null;
    let maxStealable = 0;

    for (const [peerId, deque] of this.workerDeques.entries()) {
      if (peerId !== workerId && deque.length > maxStealable) {
        maxStealable = deque.length;
        busiestWorkerId = peerId;
      }
    }

    if (busiestWorkerId && maxStealable > 0) {
      const peerDeque = this.workerDeques.get(busiestWorkerId)!;
      for (let i = 0; i < peerDeque.length; i++) {
        const stealCandidate = this.tasks.get(peerDeque[i]);
        // Work-stealing constraint: only independent read-only tasks
        if (stealCandidate && stealCandidate.effectClass === 'read' && stealCandidate.status === 'ready') {
          peerDeque.splice(i, 1);
          if (this.isPolitenessAllowed(stealCandidate)) {
            logger.info('Work-stealing executed', { thief: workerId, victim: busiestWorkerId, taskId: stealCandidate.id });
            return this.dispatchTask(stealCandidate, workerId);
          }
          peerDeque.push(stealCandidate.id);
          break;
        }
      }
    }

    return null;
  }

  private isPolitenessAllowed(task: ScheduledTask): boolean {
    if (!task.url) return true;
    const check = this.frontier.canFetch(task.url);
    return check.allowed;
  }

  private dispatchTask(task: ScheduledTask, workerId: string): ScheduledTask {
    task.status = 'running';
    task.assignedWorkerId = workerId;
    task.startedAt = Date.now();

    if (task.url) {
      this.frontier.markInFlight(task.url);
    }

    logger.info('Dispatched task to worker', { taskId: task.id, workerId, role: task.role });
    return task;
  }

  public completeTask(taskIdOrDomain: string, result?: any): void {
    let task = this.tasks.get(taskIdOrDomain);
    if (!task) {
      task = Array.from(this.tasks.values()).find(t => t.url?.includes(taskIdOrDomain));
    }
    if (!task) return;
    const taskId = task.id;

    task.status = 'completed';
    task.result = result;
    task.completedAt = Date.now();

    if (task.url) {
      this.frontier.complete(task.url, true);
    }

    logger.info('Task completed', { taskId });

    // Trigger readiness updates for dependent tasks
    for (const t of this.tasks.values()) {
      if (t.status === 'pending' && t.dependencies.includes(taskId)) {
        this.refreshTaskReadiness(t);
      }
    }
  }

  public failTask(taskId: string, error: string, httpStatus?: number): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    if (task.url) {
      this.frontier.complete(task.url, false, httpStatus);
    }

    if (task.retryCount < task.maxRetries) {
      task.retryCount++;
      task.status = 'ready';
      task.assignedWorkerId = undefined;
      logger.info('Task scheduled for retry', { taskId, attempt: task.retryCount, max: task.maxRetries });
    } else {
      task.status = 'failed';
      task.error = error;
      task.completedAt = Date.now();
      logger.warn('Task failed permanently', { taskId, error });

      // Cancel dependent downstream tasks
      for (const t of this.tasks.values()) {
        if (t.status === 'pending' && t.dependencies.includes(taskId)) {
          this.refreshTaskReadiness(t);
        }
      }
    }
  }

  public getTask(taskId: string): ScheduledTask | undefined {
    return this.tasks.get(taskId);
  }

  public getAllTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values());
  }

  public getQueueLength(): number {
    return Array.from(this.tasks.values()).filter(t => t.status === 'ready' || t.status === 'pending').length;
  }

  public clear(): void {
    this.tasks.clear();
    this.workerDeques.clear();
    this.frontier.reset();
  }
}

// Backward compatibility aliases
export { SwarmScheduler as WorkStealingQueue };
export type { ScheduledTask as SwarmTask };
