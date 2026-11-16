/**
 * Project Aegis - Network Offline Mode & Deterministic Trajectory Replay
 * 
 * Implements:
 * - Issue #64: SESSION-04 Network Offline Mode & Deterministic Trajectory Replay
 */

import * as fs from 'node:fs';

export interface TrajectoryStep {
  stepIndex: number;
  action: 'navigate' | 'click' | 'type' | 'scroll' | 'wait';
  targetAgentId?: string;
  url?: string;
  text?: string;
  deltaY?: number;
  waitMs?: number;
  timestamp: number;
}

export interface TrajectorySession {
  id: string;
  goal: string;
  startedAt: number;
  endedAt?: number;
  steps: TrajectoryStep[];
}

export class TrajectoryRecorder {
  private currentSession: TrajectorySession | null = null;

  public startSession(id: string, goal: string): TrajectorySession {
    this.currentSession = {
      id,
      goal,
      startedAt: Date.now(),
      steps: []
    };
    return this.currentSession;
  }

  public recordStep(step: Omit<TrajectoryStep, 'stepIndex' | 'timestamp'>): void {
    if (!this.currentSession) return;

    this.currentSession.steps.push({
      ...step,
      stepIndex: this.currentSession.steps.length + 1,
      timestamp: Date.now()
    });
  }

  public endSession(savePath?: string): TrajectorySession | null {
    if (!this.currentSession) return null;
    this.currentSession.endedAt = Date.now();

    if (savePath) {
      fs.writeFileSync(savePath, JSON.stringify(this.currentSession, null, 2), 'utf8');
    }

    const completed = this.currentSession;
    this.currentSession = null;
    return completed;
  }
}

export class TrajectoryReplayer {
  /**
   * Replays recorded trajectory steps using an action callback.
   */
  public static async replay(
    session: TrajectorySession,
    actionCallback: (step: TrajectoryStep) => Promise<void>,
    delayMultiplier = 1.0
  ): Promise<number> {
    let completedSteps = 0;

    for (let i = 0; i < session.steps.length; i++) {
      const step = session.steps[i];
      if (i > 0 && delayMultiplier > 0) {
        const timeDiff = Math.min(2000, Math.max(50, step.timestamp - session.steps[i - 1].timestamp));
        await new Promise(resolve => setTimeout(resolve, timeDiff * delayMultiplier));
      }

      await actionCallback(step);
      completedSteps++;
    }

    return completedSteps;
  }
}
