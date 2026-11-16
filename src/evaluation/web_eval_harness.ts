/**
 * Project Aegis - End-to-End WebArena & Mind2Web Benchmark Evaluation Harness
 * 
 * Implements:
 * - Issue #58: BENCH-01 End-to-End WebArena & Mind2Web Benchmark Evaluation Suite
 * - Issue #95: EVAL-01 SWE-Bench & WebBench Autonomous Agent Evaluation Harness
 */

export interface BenchmarkTask {
  id: string;
  dataset: 'webarena' | 'mind2web' | 'webbench' | 'swebench';
  goal: string;
  startUrl: string;
  evaluator: {
    type: 'url_match' | 'element_text_match' | 'exact_string';
    targetSelector?: string;
    expectedPattern: string;
  };
}

export interface TaskEvaluationResult {
  taskId: string;
  success: boolean;
  stepsCount: number;
  durationMs: number;
  finalUrl: string;
  errorMessage?: string;
}

export interface BenchmarkReport {
  totalTasks: number;
  successfulTasks: number;
  successRate: number; // 0.0 to 1.0
  averageSteps: number;
  averageDurationMs: number;
  results: TaskEvaluationResult[];
}

export class WebEvaluationHarness {
  /**
   * Evaluates final agent execution state against task ground truth.
   */
  public static evaluateTask(task: BenchmarkTask, finalState: { url: string; elementTexts: Record<string, string>; steps: number; duration: number }): TaskEvaluationResult {
    let success = false;

    if (task.evaluator.type === 'url_match') {
      const reg = new RegExp(task.evaluator.expectedPattern, 'i');
      success = reg.test(finalState.url);
    } else if (task.evaluator.type === 'element_text_match' && task.evaluator.targetSelector) {
      const actual = finalState.elementTexts[task.evaluator.targetSelector] || '';
      const reg = new RegExp(task.evaluator.expectedPattern, 'i');
      success = reg.test(actual);
    } else if (task.evaluator.type === 'exact_string') {
      success = finalState.url.includes(task.evaluator.expectedPattern);
    }

    return {
      taskId: task.id,
      success,
      stepsCount: finalState.steps,
      durationMs: finalState.duration,
      finalUrl: finalState.url
    };
  }

  /**
   * Generates summary benchmark score.
   */
  public static generateBenchmarkReport(results: TaskEvaluationResult[]): BenchmarkReport {
    const total = results.length;
    const successful = results.filter(r => r.success).length;
    const totalSteps = results.reduce((sum, r) => sum + r.stepsCount, 0);
    const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);

    return {
      totalTasks: total,
      successfulTasks: successful,
      successRate: total > 0 ? successful / total : 0,
      averageSteps: total > 0 ? totalSteps / total : 0,
      averageDurationMs: total > 0 ? totalDuration / total : 0,
      results
    };
  }
}
