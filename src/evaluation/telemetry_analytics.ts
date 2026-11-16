/**
 * Project Aegis - User Intervention Analytics & Self-Improvement Telemetry
 * 
 * Implements:
 * - Issue #96: EVAL-02 User Intervention Analytics & Self-Improvement Telemetry
 */

export interface InterventionEvent {
  id: string;
  taskId: string;
  url: string;
  reason: 'bot_challenge' | 'login_2fa' | 'wrong_action' | 'stalled' | 'user_voluntary';
  timestamp: number;
  durationMs: number;
  actionsPerformedByUser: number;
}

export interface AnalyticsSummary {
  totalTasks: number;
  autonomousCompleted: number;
  autonomousCompletionRate: number; // e.g. 0.92 = 92%
  totalInterventions: number;
  topInterventionReasons: Record<string, number>;
  problematicDomains: Record<string, number>;
}

export class InterventionAnalytics {
  private interventions: InterventionEvent[] = [];
  private completedTaskCount = 0;
  private fullyAutonomousCount = 0;

  public recordIntervention(event: InterventionEvent): void {
    this.interventions.push(event);
  }

  public recordTaskCompletion(wasFullyAutonomous: boolean): void {
    this.completedTaskCount++;
    if (wasFullyAutonomous) {
      this.fullyAutonomousCount++;
    }
  }

  public getSummary(): AnalyticsSummary {
    const reasons: Record<string, number> = {};
    const domains: Record<string, number> = {};

    for (const ev of this.interventions) {
      reasons[ev.reason] = (reasons[ev.reason] || 0) + 1;
      try {
        const host = new URL(ev.url).hostname;
        domains[host] = (domains[host] || 0) + 1;
      } catch {}
    }

    return {
      totalTasks: this.completedTaskCount,
      autonomousCompleted: this.fullyAutonomousCount,
      autonomousCompletionRate: this.completedTaskCount > 0 ? this.fullyAutonomousCount / this.completedTaskCount : 1.0,
      totalInterventions: this.interventions.length,
      topInterventionReasons: reasons,
      problematicDomains: domains
    };
  }
}
