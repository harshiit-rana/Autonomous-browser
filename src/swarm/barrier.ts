/**
 * Project Aegis - Swarm Synchronization & Barrier Primitives
 * 
 * Implements:
 * - Issue #34: SWARM-04 Swarm Synchronization & Barrier Primitives
 */

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

    return new Promise((resolve, reject) => {
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

export class SwarmBarrier {
  private parties: number;
  private arrivedCount = 0;
  private generation = 0;
  private waiters: Array<{ resolve: () => void; gen: number }> = [];

  constructor(parties: number) {
    if (parties <= 0) throw new Error('Parties must be > 0');
    this.parties = parties;
  }

  public async await(timeoutMs?: number): Promise<number> {
    const currentGen = this.generation;
    this.arrivedCount++;
    const arrivalIndex = this.parties - this.arrivedCount;

    if (this.arrivedCount === this.parties) {
      // Barrier broken, release all waiters
      this.generation++;
      this.arrivedCount = 0;
      const toRelease = [...this.waiters];
      this.waiters = [];
      for (const w of toRelease) {
        w.resolve();
      }
      return arrivalIndex;
    }

    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;

      const onRelease = () => {
        if (timer) clearTimeout(timer);
        resolve(arrivalIndex);
      };

      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          const idx = this.waiters.findIndex(w => w.resolve === onRelease);
          if (idx !== -1) this.waiters.splice(idx, 1);
          reject(new Error(`SwarmBarrier timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      this.waiters.push({ resolve: onRelease, gen: currentGen });
    });
  }

  public getNumberWaiting(): number {
    return this.arrivedCount;
  }

  public reset(): void {
    this.generation++;
    this.arrivedCount = 0;
    this.waiters = [];
  }
}
