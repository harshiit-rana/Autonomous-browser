/**
 * Project Aegis - shared control state of a swarm's workers (#227 SWX-01).
 *
 * The single-agent runtime keeps one pause resolver and one open question. With several workers that is wrong:
 * resuming would wake only the last worker that waited, and a second worker's approval would replace the first one's.
 * `PauseGate` wakes every waiter; `QuestionQueue` puts the user in front of one question at a time while the other
 * workers keep running.
 */

export class PauseGate {
  private paused = false;
  private waiters = new Set<() => void>();

  public get isPaused(): boolean {
    return this.paused;
  }

  public pause(): void {
    this.paused = true;
  }

  public resume(): void {
    this.paused = false;
    const all = [...this.waiters];
    this.waiters.clear();
    for (const w of all) w();
  }

  /** Resolves when the gate is open (or the signal aborted). Every waiting worker is released by one resume(). */
  public async wait(signal?: AbortSignal): Promise<void> {
    while (this.paused && !signal?.aborted) {
      await new Promise<void>(resolve => {
        const done = () => { signal?.removeEventListener('abort', done); this.waiters.delete(done); resolve(); };
        this.waiters.add(done);
        signal?.addEventListener('abort', done, { once: true });
      });
    }
  }
}

export class QuestionQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private waitingCount = 0;

  /** Questions queued behind the open one. */
  public get queued(): number {
    return this.waitingCount;
  }

  /**
   * Runs `present` (which shows the question and resolves with the answer) after every earlier question was answered.
   * A question whose mission was cancelled while it waited is never shown.
   */
  public ask(present: () => Promise<string>, signal?: AbortSignal): Promise<string> {
    this.waitingCount++;
    const run = this.tail.then(() => {
      this.waitingCount--;
      if (signal?.aborted) throw new Error('Mission cancelled');
      return present();
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}
