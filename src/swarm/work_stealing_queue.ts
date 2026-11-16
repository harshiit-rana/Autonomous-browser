/**
 * Project Aegis - Dynamic Work-Stealing Queue for Parallel Crawling
 * 
 * Implements:
 * - Issue #33: SWARM-03 Dynamic Work-Stealing Queue for Parallel Crawling
 */

export interface SwarmTask {
  id: string;
  url: string;
  targetDomain: string;
  depth: number;
  priority: number; // Higher number = higher priority
  actionType: 'scrape' | 'paginate' | 'extract' | 'verify';
  payload?: Record<string, any>;
  createdAt: number;
}

export class WorkStealingQueue {
  private workerDeques: Map<string, SwarmTask[]> = new Map(); // workerId -> tasks deque
  private globalQueue: SwarmTask[] = []; // Unassigned tasks
  private domainInFlightCount: Map<string, number> = new Map(); // domain -> active count
  private maxConcurrentPerDomain: number;

  constructor(maxConcurrentPerDomain = 2) {
    this.maxConcurrentPerDomain = maxConcurrentPerDomain;
  }

  public registerWorker(workerId: string): void {
    if (!this.workerDeques.has(workerId)) {
      this.workerDeques.set(workerId, []);
    }
  }

  public unregisterWorker(workerId: string): SwarmTask[] {
    const remaining = this.workerDeques.get(workerId) || [];
    this.workerDeques.delete(workerId);
    // Push remaining back to global queue
    this.globalQueue.push(...remaining);
    return remaining;
  }

  /**
   * Pushes a new task to the global queue or specific worker.
   */
  public pushTask(task: SwarmTask, preferredWorkerId?: string): void {
    if (preferredWorkerId && this.workerDeques.has(preferredWorkerId)) {
      this.workerDeques.get(preferredWorkerId)!.push(task);
    } else {
      this.globalQueue.push(task);
      this.globalQueue.sort((a, b) => b.priority - a.priority);
    }
  }

  /**
   * Worker requests next available task.
   * 1. Check local deque (LIFO: pop from back).
   * 2. Check global queue.
   * 3. Steal from busiest peer worker (FIFO: shift from front).
   */
  public getNextTask(workerId: string): SwarmTask | null {
    this.registerWorker(workerId);
    const localDeque = this.workerDeques.get(workerId)!;

    // 1. Try local deque
    while (localDeque.length > 0) {
      const task = localDeque.pop()!;
      if (this.canExecuteDomain(task.targetDomain)) {
        this.trackDomainStart(task.targetDomain);
        return task;
      }
      // If domain throttled, defer to global queue
      this.globalQueue.push(task);
    }

    // 2. Try global queue
    for (let i = 0; i < this.globalQueue.length; i++) {
      const candidate = this.globalQueue[i];
      if (this.canExecuteDomain(candidate.targetDomain)) {
        this.globalQueue.splice(i, 1);
        this.trackDomainStart(candidate.targetDomain);
        return candidate;
      }
    }

    // 3. Work-Stealing: Find peer worker with the largest queue
    let busiestWorkerId: string | null = null;
    let maxTasks = 0;

    for (const [peerId, deque] of this.workerDeques.entries()) {
      if (peerId !== workerId && deque.length > maxTasks) {
        maxTasks = deque.length;
        busiestWorkerId = peerId;
      }
    }

    if (busiestWorkerId && maxTasks > 0) {
      const peerDeque = this.workerDeques.get(busiestWorkerId)!;
      // Steal from front (oldest task) to avoid interfering with peer's cache locality
      const stolenTask = peerDeque.shift();
      if (stolenTask) {
        if (this.canExecuteDomain(stolenTask.targetDomain)) {
          this.trackDomainStart(stolenTask.targetDomain);
          return stolenTask;
        } else {
          this.globalQueue.push(stolenTask);
        }
      }
    }

    return null;
  }

  /**
   * Marks task execution complete for domain concurrency tracking.
   */
  public completeTask(domain: string): void {
    const current = this.domainInFlightCount.get(domain) || 1;
    if (current <= 1) {
      this.domainInFlightCount.delete(domain);
    } else {
      this.domainInFlightCount.set(domain, current - 1);
    }
  }

  public getTotalPendingCount(): number {
    let total = this.globalQueue.length;
    for (const deque of this.workerDeques.values()) {
      total += deque.length;
    }
    return total;
  }

  private canExecuteDomain(domain: string): boolean {
    const active = this.domainInFlightCount.get(domain) || 0;
    return active < this.maxConcurrentPerDomain;
  }

  private trackDomainStart(domain: string): void {
    const current = this.domainInFlightCount.get(domain) || 0;
    this.domainInFlightCount.set(domain, current + 1);
  }
}
