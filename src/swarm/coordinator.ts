/**
 * Project Aegis - Swarm Coordinator & Orchestrator-Worker Architecture
 *
 * Implements Issue #147 [SWM-01] & #155 [SWM-09], and since #227 [SWX-01] the workers are real:
 * - Lead agent mission decomposition into a typed task DAG (one researcher task per source URL the user named)
 * - Parallel read branches vs serialized side-effecting steps, never wider than settings.maxWorkers
 * - Every browser task is run by the caller's `workerExecutorFn` (worker_task_runner.ts: the model-driven AgentLoop on the
 *   worker's own view). There is no built-in executor: a worker that only navigates and reports the page title is gone.
 * - Evidence aggregation via SharedBlackboard; conflicts are adjudicated by the verifier stage (a model call that reads
 *   the quotes), never by "highest confidence"
 * - Per-task failure handling: one retry, then the supervisor quarantines the task as poison
 * - Verified deliverable report synthesis from blackboard evidence only, with the quote and source of every row
 */

import { EventEmitter } from 'node:events';
import { SwarmManager } from './swarm_manager.js';
import { IWorkerHost } from './worker_host.js';
import { SharedBlackboard, EvidenceItem, ConflictRecord } from './blackboard.js';
import { VerifiedReportSynthesizer, ReportGroundingError } from '../data/verified_report.js';
import { SwarmScheduler, ScheduledTask, TaskRole, TaskEffectClass } from './scheduler.js';
import { URLFrontier } from './url_frontier.js';
import { HazardLockManager } from './hazards_and_locks.js';
import { SwarmStageBarrier } from './barrier.js';
import { ResourceGovernor } from './resource_governor.js';
import { WorkerSupervisor } from './supervisor.js';
import { clampMaxWorkers } from '../infrastructure/settings.js';
import { logger } from '../infrastructure/logger.js';

/** A finding older than this is reported as stale. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface MissionDecompositionPlan {
  missionId: string;
  goal: string;
  justification: string;
  stages: Array<{
    stageName: string;
    parallelism: number;
    tasks: Array<{
      id: string;
      name: string;
      role: TaskRole;
      url?: string;
      instruction: string;
      effectClass: TaskEffectClass;
      dependencies: string[];
      outputSchema?: Record<string, string>;
    }>;
  }>;
}

export interface SwarmMissionResult {
  missionId: string;
  goal: string;
  /** True when at least one browser task (researcher/extractor/actor) finished. */
  success: boolean;
  completedTasks: number;
  totalTasks: number;
  evidence: EvidenceItem[];
  deliverableMarkdown: string;
  durationMs: number;
  errors: string[];
  /** Tasks that stopped at a bot check or login wall and wait for a person. */
  needsHuman: Array<{ taskId: string; name: string; reason: string }>;
  unresolvedConflicts: Array<{ entity: string; attribute: string; claims: number }>;
}

export type WorkerExecutor = (worker: IWorkerHost, task: ScheduledTask) => Promise<any>;
const BROWSER_ROLES: TaskRole[] = ['researcher', 'extractor', 'actor'];
/** A ready task that politeness keeps blocked this long is failed with the frontier's reason instead of waiting forever. */
const THROTTLE_GIVE_UP_MS = 30_000;
const THROTTLE_POLL_MS = 100;

export interface ExecuteOptions {
  /** Runs verifier/summariser tasks without a browser view. When absent they run on a worker like any other task. */
  inlineExecutorFn?: (task: ScheduledTask) => Promise<any>;
  /** Mission abort (user cancel): workers stop taking tasks. */
  signal?: AbortSignal;
}

const MAX_SOURCES = 8;

export class SwarmCoordinator extends EventEmitter {
  private swarm: SwarmManager;
  private blackboard: SharedBlackboard;
  private scheduler: SwarmScheduler;
  private frontier: URLFrontier;
  private lockManager: HazardLockManager;
  private governor: ResourceGovernor;
  private supervisor: WorkerSupervisor;
  private maxWorkers: number;
  private includeUnverifiable: boolean;

  constructor(options: {
    swarm?: SwarmManager;
    blackboard?: SharedBlackboard;
    frontier?: URLFrontier;
    lockManager?: HazardLockManager;
    governor?: ResourceGovernor;
    supervisor?: WorkerSupervisor;
    /** Workers that run at once (settings.maxWorkers); clamped to 1..8. */
    maxWorkers?: number;
    /** List findings that have no verified quote in the report (default: they are counted but left out). */
    includeUnverifiable?: boolean;
  } = {}) {
    super();
    this.blackboard = options.blackboard || new SharedBlackboard({ inMemory: true });
    this.frontier = options.frontier || new URLFrontier();
    this.scheduler = new SwarmScheduler(this.frontier);
    this.lockManager = options.lockManager || new HazardLockManager();
    this.governor = options.governor || new ResourceGovernor();
    this.supervisor = options.supervisor || new WorkerSupervisor();
    this.swarm = options.swarm || new SwarmManager();
    this.maxWorkers = clampMaxWorkers(options.maxWorkers);
    this.includeUnverifiable = options.includeUnverifiable === true;
    this.supervisor.on('workerStalled', e => this.emit('workerStalled', e));
    this.supervisor.on('poisonTask', e => this.emit('poisonTask', e));
    this.governor.on('metrics', m => this.emit('governanceMetrics', m));
  }

  /** Source URLs the user named in the prompt, canonical-deduplicated, in the order given. */
  public static extractSourceUrls(prompt: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of prompt.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)) {
      const raw = m[0].replace(/[.,;:!?]+$/, '');
      let key: string;
      try { key = URLFrontier.normalize(raw); } catch { continue; }
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(raw);
    }
    return out.slice(0, MAX_SOURCES);
  }

  /**
   * Decomposes a high-level mission into an executable task DAG:
   * Identifies if parallelism is justified (e.g. multi-site comparison or research).
   * If single linear task, width = 1. A prompt that names source URLs gets one researcher task per URL.
   */
  public planMission(missionId: string, prompt: string): MissionDecompositionPlan {
    const trimmed = prompt.trim();
    const isComparison = /compare|vs|across|multiple|shops?|stores?|prices/i.test(trimmed);
    const isMultiSiteResearch = /research|find\s+(several|top|different|3|5)/i.test(trimmed);
    const urls = SwarmCoordinator.extractSourceUrls(trimmed);
    // The URLs are each worker's own start page; the mission text each worker sees does not repeat all of them.
    const missionText = urls.length ? trimmed.replace(/https?:\/\/[^\s"'<>)\]]+/gi, '').replace(/\s+/g, ' ').trim() : trimmed;

    // 1. Parallel Research & Comparison Plan
    if (isComparison || isMultiSiteResearch) {
      const sources: Array<{ name: string; url?: string; instruction: string }> = urls.length >= 2
        ? urls.map((url, i) => ({
            name: `Read source ${i + 1} (${new URL(url).host})`,
            url,
            instruction: `Mission: "${missionText}". Your sub-goal: read ONLY ${url} and report, with exact quotes, every fact the mission asks for.`
          }))
        : ['A', 'B', 'C'].map((letter, i) => ({
            name: `Query ${['Primary', 'Alternative', 'Benchmark'][i]} Source ${letter}`,
            instruction: `Mission: "${trimmed}". Your sub-goal: find ONE independent source (${['first', 'second', 'third'][i]} choice; other workers cover the others, do not reuse a site another worker already took) and report, with exact quotes from its page, every fact the mission asks for. Name the site in each entity.`
          }));
      const t = (i: number) => `${missionId}_t${i + 1}`;
      return {
        missionId,
        goal: trimmed,
        justification: 'Parallel multi-origin search and extraction justified to compare sources simultaneously without serial latency.',
        stages: [
          {
            stageName: 'Discovery & Extraction',
            parallelism: Math.min(sources.length, this.maxWorkers),
            tasks: sources.map((s, i) => ({
              id: t(i),
              name: s.name,
              role: 'researcher' as TaskRole,
              url: s.url,
              instruction: s.instruction,
              effectClass: 'read' as TaskEffectClass,
              dependencies: []
            }))
          },
          {
            stageName: 'Verification & Adjudication',
            parallelism: 1,
            tasks: [
              {
                id: `${missionId}_t_verify`,
                name: 'Cross-Check Conflicts & Validate Claims',
                role: 'verifier',
                instruction: 'Inspect evidence blackboard, resolve conflicting claims by comparing their quotes',
                effectClass: 'read',
                // Stages already run in order. No task dependency here: a source that failed must not cancel the verifier and the
                // report of the sources that worked.
                dependencies: []
              }
            ]
          },
          {
            stageName: 'Synthesis & Reporting',
            parallelism: 1,
            tasks: [
              {
                id: `${missionId}_t_summary`,
                name: 'Synthesize Verified Deliverable Table',
                role: 'summariser',
                instruction: 'Compile structured markdown comparison table with citations',
                effectClass: 'read',
                dependencies: []
              }
            ]
          }
        ]
      };
    }

    // 2. Linear Single-Worker Plan (Default for specific URL or single action)
    return {
      missionId,
      goal: trimmed,
      justification: 'Single linear objective does not warrant swarm fan-out; executed with one scoped worker.',
      stages: [
        {
          stageName: 'Target Execution',
          parallelism: 1,
          tasks: [
            {
              id: `${missionId}_t1`,
              name: 'Execute Target Goal',
              role: 'researcher',
              url: urls[0],
              instruction: trimmed,
              effectClass: /buy|purchase|submit|sign\s*up|login/i.test(trimmed) ? 'write-non-idempotent' : 'read',
              dependencies: []
            }
          ]
        }
      ]
    };
  }

  /**
   * Executes a multi-stage swarm mission. `workerExecutorFn` runs one browser task on one worker
   * (worker_task_runner.ts `runWorkerTask` in the app).
   */
  public async executeMission(
    missionId: string,
    prompt: string,
    workerExecutorFn: WorkerExecutor,
    options: ExecuteOptions = {}
  ): Promise<SwarmMissionResult> {
    const startTime = Date.now();
    const plan = this.planMission(missionId, prompt);
    const errors: string[] = [];
    const needsHuman: SwarmMissionResult['needsHuman'] = [];
    let completedTasks = 0;
    let browserTasksCompleted = 0;
    let totalTasks = 0;
    const aborted = () => options.signal?.aborted === true;

    logger.info('Starting swarm mission execution', { missionId, stages: plan.stages.length, justification: plan.justification });
    this.emit('missionStarted', { missionId, plan });
    this.supervisor.start();
    this.governor.start();

    try {
      for (const stage of plan.stages) {
        if (aborted()) break;
        totalTasks += stage.tasks.length;
        logger.info('Starting swarm stage', { stageName: stage.stageName, taskCount: stage.tasks.length });
        this.emit('stageStarted', { stageName: stage.stageName, taskCount: stage.tasks.length });

        for (const t of stage.tasks) {
          this.scheduler.addTask({
            id: t.id,
            missionId,
            name: t.name,
            role: t.role,
            url: t.url,
            instruction: t.instruction,
            priority: 10,
            dependencies: t.dependencies,
            effectClass: t.effectClass,
            maxRetries: 1
          });
        }
        const stageIds = new Set(stage.tasks.map(t => t.id));
        const stageBarrier = new SwarmStageBarrier(stage.stageName, stage.tasks.length, stage.tasks.length);

        // One finished (or failed, or parked) task = one arrival, so the barrier never waits on work that will not come.
        const finishTask = async (workerId: string, identity: any, task: ScheduledTask, run: () => Promise<any>) => {
          this.emit('taskStarted', { workerId, identity, taskId: task.id, role: task.role, name: task.name });
          try {
            if (task.effectClass !== 'read') {
              const lock = this.lockManager.acquireLock(HazardLockManager.makeKey('form', task.url || 'default', task.id), workerId);
              if (!lock.acquired) throw new Error(`Cannot execute task: ${lock.reason}`);
            }
            const taskResult = await run();
            if (taskResult && taskResult.status === 'needs_human') {
              this.scheduler.markNeedsHuman(task.id, taskResult.reason || 'needs a person', taskResult);
              needsHuman.push({ taskId: task.id, name: task.name, reason: String(taskResult.reason || taskResult.summary || '') });
              this.emit('taskNeedsHuman', { workerId, identity, taskId: task.id, reason: taskResult.reason });
            } else {
              this.scheduler.completeTask(task.id, taskResult);
              completedTasks++;
              if (BROWSER_ROLES.includes(task.role)) browserTasksCompleted++;
              this.emit('taskCompleted', { workerId, identity, taskId: task.id, result: taskResult });
            }
          } catch (err: any) {
            const reason = String(err?.message ?? err);
            const userStopped = reason === 'Worker stopped by user';
            if (aborted() || userStopped) {
              this.scheduler.failTask(task.id, reason, undefined, false);
              if (userStopped) errors.push(`Task ${task.id} (${task.name}) stopped by user`);
              this.emit('taskFailed', { workerId, identity, taskId: task.id, error: reason, cancelled: true, stoppedByUser: userStopped });
            } else {
              // First failure: one retry (with what the earlier attempt already reported). Second: poison, no more restarts.
              const poison = this.supervisor.recordTaskFailure(task.id, reason);
              this.scheduler.failTask(task.id, reason, undefined, !poison);
              const permanent = this.scheduler.getTask(task.id)?.status === 'failed';
              if (permanent) errors.push(`Task ${task.id} (${task.name}) failed${poison ? ' and was quarantined' : ''}: ${reason}`);
              this.emit(permanent ? 'taskFailed' : 'taskRetry', { workerId, identity, taskId: task.id, error: reason, poison });
            }
          } finally {
            if (task.effectClass !== 'read') {
              this.lockManager.releaseLock(HazardLockManager.makeKey('form', task.url || 'default', task.id), workerId);
            }
            stageBarrier.arrive(`${task.id}#${task.retryCount}`, { status: this.scheduler.getTask(task.id)?.status });
          }
        };

        const browserStage = stage.tasks.some(t => BROWSER_ROLES.includes(t.role));
        if (!browserStage && options.inlineExecutorFn) {
          // Verifier / summariser: no browser view, so no extra tab appears for them.
          for (const t of stage.tasks) {
            const task = this.scheduler.getNextTask('coordinator');
            if (!task || aborted()) break;
            await finishTask('coordinator', { name: 'Coordinator', color: '#888888', glyph: 'C' }, task, () => options.inlineExecutorFn!(task));
          }
        } else {
          // Width: the stage's parallelism, what the machine recommends right now, and settings.maxWorkers.
          const metrics = this.governor.getMetrics();
          const width = Math.max(1, Math.min(stage.parallelism, metrics.recommendedConcurrency, this.maxWorkers));
          const activeWorkers = await this.swarm.spawnSwarm(width, 'swarm_worker');

          const workerPromises = activeWorkers.map(async worker => {
            this.supervisor.registerWorker(worker.id);
            let blockedSince = 0;
            while (!aborted()) {
              const task = this.scheduler.getNextTask(worker.id);
              if (!task) {
                // Nothing handed out. If tasks of this stage are only held back by politeness (or a retry is pending), wait for them.
                const ready = this.scheduler.getAllTasks().filter(t => stageIds.has(t.id) && t.status === 'ready' && !t.assignedWorkerId);
                if (ready.length === 0) break;
                blockedSince = blockedSince || Date.now();
                if (Date.now() - blockedSince > THROTTLE_GIVE_UP_MS) {
                  for (const r of ready) {
                    const why = this.scheduler.getBlockReason(r.id) || 'not scheduled';
                    this.scheduler.failTask(r.id, `Never started: ${why}`, undefined, false);
                    errors.push(`Task ${r.id} (${r.name}) never started: ${why}`);
                    stageBarrier.arrive(`${r.id}#blocked`, { status: 'failed' });
                  }
                  break;
                }
                await new Promise(r => setTimeout(r, THROTTLE_POLL_MS));
                continue;
              }
              blockedSince = 0;
              await finishTask(worker.id, worker.identity, task, () => workerExecutorFn(worker, task));
            }
          });

          await Promise.all(workerPromises);
          await stageBarrier.await(2000).catch(() => undefined); // every task of the stage has arrived by now
          for (const w of activeWorkers) {
            this.supervisor.unregisterWorker(w.id);
            await this.swarm.retireWorker(w.id, true);
          }
        }

        this.emit('stageCompleted', { stageName: stage.stageName });
      }
    } finally {
      this.supervisor.stop();
      this.governor.stop();
    }

    // Conflicts nobody could settle stay open and are reported as such: no confidence-based guess is made here.
    const unresolved = this.blackboard.getUnresolvedConflicts();
    const allEvidence = this.blackboard.getAllEvidence();
    let deliverableMarkdown: string;
    let reportRefused = false;
    try {
      deliverableMarkdown = this.synthesizeReport(prompt, allEvidence, errors, { unresolved, needsHuman, conflicts: this.blackboard.getConflicts() });
    } catch (err) {
      if (!(err instanceof ReportGroundingError)) throw err;
      reportRefused = true;
      errors.push(err.message);
      deliverableMarkdown = `# Swarm Mission Report: ${prompt}\n\n**Status:** Report refused\n\nThe report cites pages that no worker visited, so it was not produced:\n${err.problems.map(p => `- ${p}`).join('\n')}`;
    }

    const result: SwarmMissionResult = {
      missionId,
      goal: prompt,
      success: browserTasksCompleted > 0 && !reportRefused,
      completedTasks,
      totalTasks,
      evidence: allEvidence,
      deliverableMarkdown,
      durationMs: Date.now() - startTime,
      errors,
      needsHuman,
      unresolvedConflicts: unresolved.map(c => ({ entity: c.entity, attribute: c.attribute, claims: c.items.length }))
    };

    logger.info('Swarm mission finished', { missionId, success: result.success, evidenceCount: allEvidence.length });
    this.emit('missionCompleted', result);
    return result;
  }

  /**
   * Synthesizes a structured deliverable report from blackboard evidence only: every row carries its evidence id, the quote
   * that was re-verified against the stored page snapshot, the page it came from and a computed strength. Throws
   * ReportGroundingError when a row cites a URL that is not in the mission's visited-URL log (no report is produced then).
   */
  public synthesizeReport(
    goal: string,
    evidence: EvidenceItem[],
    errors: string[],
    extra: { unresolved?: ConflictRecord[]; conflicts?: ConflictRecord[]; needsHuman?: SwarmMissionResult['needsHuman'] } = {}
  ): string {
    const verify = (item: EvidenceItem) => this.blackboard.verifyEvidence(item, { maxAgeMs: STALE_AFTER_MS });
    const table = VerifiedReportSynthesizer.renderFindings(evidence, { verify, includeUnverifiable: this.includeUnverifiable });
    VerifiedReportSynthesizer.assertGrounded(table.listed, this.blackboard.getVisitedUrls());
    const notes = errors.length + (extra.needsHuman?.length ?? 0) + (extra.unresolved?.length ?? 0) + table.excluded.length;
    const lines: string[] = [];
    lines.push(`# Swarm Mission Report: ${goal}`);
    lines.push(`\n**Status:** ${notes === 0 ? 'Verified Complete' : 'Completed with Notes'}`);
    lines.push(`**Evidence Items Gathered:** ${table.listed.length}${table.excluded.length ? ` (${table.excluded.length} more left out: no verified quote)` : ''}`);
    lines.push(`**Timestamp:** ${new Date().toISOString()}`);

    const cell = (v: unknown, max: number) => String(v ?? '').replace(/[|\n\r]/g, ' ').slice(0, max);
    if (table.listed.length > 0) {
      lines.push('\n## Verified Findings & Evidence Table');
      lines.push(...table.lines);
    } else {
      lines.push('\nNo verified evidence items recorded.');
    }
    if (table.excluded.length) {
      lines.push(`\n## Left out: no verified quote (${table.excluded.length})`);
      for (const e of table.excluded) lines.push(`- ${cell(e.entity, 80)} / ${cell(e.attribute, 40)}: ${cell(e.value, 40)} (${e.id}): ${cell(this.blackboard.verifyEvidence(e).reason, 120)}`);
    }

    const conflictLine = (c: ConflictRecord) => c.items.filter(i => !i.source.url.startsWith('consensus://')).map(i => `${cell(i.value, 40)} (${i.source.domain}, ${i.id}, strength ${i.confidence.toFixed(2)})`).join(' vs ');
    const settled = (extra.conflicts ?? []).filter(c => c.resolved);
    if (settled.length) {
      lines.push('\n## Conflicting Findings (settled)');
      for (const c of settled) {
        const how = c.resolutionMethod === 'both_valid' ? 'both are valid' : c.resolutionMethod === 'majority' ? `${cell(c.resolvedValue, 40)} (stated by the most independent sites)` : `${cell(c.resolvedValue, 40)} (${c.resolutionMethod})`;
        lines.push(`- ${cell(c.entity, 80)} / ${cell(c.attribute, 40)}: ${conflictLine(c)}. Verdict: ${how}${c.verdictReason ? ` - ${cell(c.verdictReason, 200)}` : ''}`);
      }
    }
    if (extra.unresolved?.length) {
      lines.push('\n## Conflicting Findings (not settled)');
      for (const c of extra.unresolved) {
        lines.push(`- ${cell(c.entity, 80)} / ${cell(c.attribute, 40)}: ${conflictLine(c)}${c.verdict === 'needs_human' ? ` - needs your decision: ${cell(c.verdictReason, 200)}` : ''}`);
      }
    }
    if (extra.needsHuman?.length) {
      lines.push('\n## Waiting for you');
      for (const n of extra.needsHuman) lines.push(`- ${cell(n.name, 80)}: ${cell(n.reason, 200)}`);
    }
    if (errors.length > 0) {
      lines.push('\n## Execution Notes & Roadblocks');
      for (const err of errors) lines.push(`- ${err.replace(/[\n\r]/g, ' ')}`);
    }

    return lines.join('\n');
  }

  public getBlackboard(): SharedBlackboard {
    return this.blackboard;
  }

  public getScheduler(): SwarmScheduler {
    return this.scheduler;
  }

  public getFrontier(): URLFrontier {
    return this.frontier;
  }

  public getSupervisor(): WorkerSupervisor {
    return this.supervisor;
  }
}
