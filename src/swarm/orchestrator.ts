/**
 * Model-driven mission orchestrator (#228, SWX-02).
 *
 * Replaces regex routing and hardcoded templates with a single orchestrator model call using the `submit_plan` tool.
 * Validates schema, maxWorkers bounds, DAG acyclicity, valid roles, URLs, and approval markers on mutating tasks.
 * Failed/prose outputs get at most one repair turn with the validation error before failing explicitly.
 */

import type { CanonicalMessage, IModelProvider, ToolDefinition } from '../models/types.js';
import type { MissionBrief } from '../agent/agent_loop.js';
import { PromptRegistry } from '../agent/steering_and_reversibility.js';
import { estimateStepCost } from '../models/pricing.js';
import type { MissionDecompositionPlan } from './coordinator.js';
import type { TaskEffectClass, TaskRole } from './scheduler.js';
import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('orchestrator');

export const VALID_TASK_ROLES: ReadonlySet<TaskRole> = new Set([
  'researcher',
  'extractor',
  'actor',
  'verifier',
  'summariser'
]);

export const VALID_EFFECT_CLASSES: ReadonlySet<TaskEffectClass> = new Set([
  'read',
  'write-idempotent',
  'write-non-idempotent',
  'financial'
]);

const ASSUMED_STEPS_PER_TASK: Record<TaskRole, number> = {
  researcher: 4,
  extractor: 4,
  actor: 6,
  verifier: 1,
  summariser: 1
};

const EST_SEC_PER_TASK: Record<TaskRole, number> = {
  researcher: 10,
  extractor: 10,
  actor: 14,
  verifier: 4,
  summariser: 3
};

export interface OrchestratorTaskInput {
  id: string;
  name: string;
  role: TaskRole;
  goal: string;
  startUrl?: string;
  dependsOn: string[];
  effectClass: TaskEffectClass;
  requiresApproval?: boolean;
}

export interface OrchestratorStageInput {
  name: string;
  parallelism: number;
  tasks: OrchestratorTaskInput[];
}

export interface SubmitPlanArgs {
  mode: 'single' | 'swarm';
  justification: string;
  stages: OrchestratorStageInput[];
}

export interface OrchestratorPlanResult {
  mode: 'single' | 'swarm';
  justification: string;
  plan: MissionDecompositionPlan;
  estimatedCostUSD: number | null;
  estimatedDurationSec: number;
  warnings: string[];
  raw: SubmitPlanArgs;
}

export class PlanValidationError extends Error {
  public readonly errors: string[];
  constructor(errors: string | string[]) {
    const list = Array.isArray(errors) ? errors : [errors];
    super(list.join('; '));
    this.name = 'PlanValidationError';
    this.errors = list;
  }
}

export const SUBMIT_PLAN_TOOL: ToolDefinition = {
  name: 'submit_plan',
  description: 'Submit the validated execution plan deciding single-agent vs multi-worker swarm mode and task stages.',
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['single', 'swarm'],
        description: 'Execution mode: "single" (default linear agent) or "swarm" (parallel multi-worker coordinator).'
      },
      justification: {
        type: 'string',
        description: 'Brief justification explaining why single mode or parallel swarm mode fits the user goal.'
      },
      stages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            parallelism: { type: 'number' },
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  role: { type: 'string', enum: ['researcher', 'extractor', 'actor', 'verifier', 'summariser'] },
                  goal: { type: 'string' },
                  startUrl: { type: 'string' },
                  dependsOn: { type: 'array', items: { type: 'string' } },
                  effectClass: { type: 'string', enum: ['read', 'write-idempotent', 'write-non-idempotent', 'financial'] },
                  requiresApproval: { type: 'boolean' }
                },
                required: ['id', 'name', 'role', 'goal', 'dependsOn', 'effectClass']
              }
            }
          },
          required: ['name', 'parallelism', 'tasks']
        }
      }
    },
    required: ['mode', 'justification', 'stages']
  }
};

function isValidHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function detectDependencyCycle(nodes: Map<string, string[]>): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const dfs = (id: string): string[] | null => {
    visiting.add(id);
    stack.push(id);
    for (const dep of nodes.get(id) ?? []) {
      if (visiting.has(dep)) {
        const idx = stack.indexOf(dep);
        return [...stack.slice(idx), dep];
      }
      if (!visited.has(dep)) {
        const cycle = dfs(dep);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };

  for (const id of nodes.keys()) {
    if (!visited.has(id)) {
      const cycle = dfs(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

/**
 * Computes projected USD cost and duration for a plan using the real pricing table (`models/pricing.ts`).
 * Returns `costUSD: null` when the model has no pricing entry rather than guessing.
 */
export function estimatePlanMetrics(plan: Pick<MissionDecompositionPlan, 'stages'>, modelName: string): {
  estimatedCostUSD: number | null;
  estimatedDurationSec: number;
} {
  const stepEst = estimateStepCost(modelName);
  let totalSteps = 1; // orchestrator planning call itself
  let totalDurationSec = 3;

  for (const stage of plan.stages) {
    const p = Math.max(1, stage.parallelism);
    const taskDurations = stage.tasks.map(t => EST_SEC_PER_TASK[t.role] ?? 10);
    const taskSteps = stage.tasks.reduce((sum, t) => sum + (ASSUMED_STEPS_PER_TASK[t.role] ?? 4), 0);
    totalSteps += taskSteps;
    const sumSec = taskDurations.reduce((a, b) => a + b, 0);
    const maxSec = taskDurations.length ? Math.max(...taskDurations) : 0;
    totalDurationSec += Math.max(maxSec, Math.ceil(sumSec / p));
  }

  return {
    estimatedCostUSD: stepEst.costUSD === null ? null : Number((stepEst.costUSD * totalSteps).toFixed(4)),
    estimatedDurationSec: totalDurationSec
  };
}

/**
 * Validates raw `submit_plan` tool arguments against schema, maxWorkers limit, DAG acyclicity, and approval guards.
 */
export function validateOrchestratorPlan(
  rawArgs: unknown,
  opts: { maxWorkers: number; missionId: string; goal: string; model?: string; forceSwarm?: boolean }
): { ok: true; value: OrchestratorPlanResult } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return { ok: false, errors: ['Plan must be a JSON object matching submit_plan schema.'] };
  }

  const obj = rawArgs as Record<string, any>;
  let mode: 'single' | 'swarm';
  if (obj.mode === 'single' || obj.mode === 'swarm') {
    mode = obj.mode;
  } else {
    errors.push(`Invalid mode "${String(obj.mode)}"; expected "single" or "swarm".`);
    mode = 'single';
  }

  const justification = typeof obj.justification === 'string' ? obj.justification.trim() : '';
  if (justification.length < 4) {
    errors.push('justification must be a non-empty explanation (at least 4 characters).');
  }

  if (!Array.isArray(obj.stages) || obj.stages.length === 0) {
    errors.push('stages must be a non-empty array with at least one stage.');
    return { ok: false, errors };
  }

  const maxWorkers = Math.max(1, opts.maxWorkers);
  const seenIds = new Set<string>();
  const depsByTask = new Map<string, string[]>();
  const stageIndexByTask = new Map<string, number>();
  const rawStages: OrchestratorStageInput[] = [];
  const normalizedStages: MissionDecompositionPlan['stages'] = [];
  let totalTasks = 0;

  for (let sIdx = 0; sIdx < obj.stages.length; sIdx++) {
    const s = obj.stages[sIdx];
    if (!s || typeof s !== 'object') {
      errors.push(`Stage ${sIdx + 1} must be an object.`);
      continue;
    }
    const stageName = typeof s.name === 'string' && s.name.trim() ? s.name.trim() : '';
    if (!stageName) errors.push(`Stage ${sIdx + 1} is missing a non-empty name.`);

    const p = s.parallelism;
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 1) {
      errors.push(`Stage "${stageName || sIdx + 1}" parallelism must be an integer >= 1 (got ${String(p)}).`);
    } else if (p > maxWorkers) {
      errors.push(`Stage "${stageName || sIdx + 1}" parallelism (${p}) exceeds settings.maxWorkers (${maxWorkers}).`);
    } else if (mode === 'single' && p > 1 && !opts.forceSwarm) {
      errors.push(`Stage "${stageName || sIdx + 1}" has parallelism ${p} > 1 while mode is "single".`);
    }

    if (!Array.isArray(s.tasks) || s.tasks.length === 0) {
      errors.push(`Stage "${stageName || sIdx + 1}" must contain at least one task (got 0 tasks).`);
      continue;
    }

    const maxTasksInStage = Math.max(maxWorkers * 2, 12);
    if (s.tasks.length > maxTasksInStage) {
      errors.push(`Stage "${stageName || sIdx + 1}" has ${s.tasks.length} tasks (exceeds max fan-out budget of ${maxTasksInStage}). Split or narrow the scope.`);
    }

    const stageTasksRaw: OrchestratorTaskInput[] = [];
    const stageTasksPlan: MissionDecompositionPlan['stages'][number]['tasks'] = [];

    for (let tIdx = 0; tIdx < s.tasks.length; tIdx++) {
      const t = s.tasks[tIdx];
      totalTasks++;
      if (!t || typeof t !== 'object') {
        errors.push(`Stage "${stageName || sIdx + 1}" task ${tIdx + 1} must be an object.`);
        continue;
      }

      const id = typeof t.id === 'string' ? t.id.trim() : '';
      if (!id) errors.push(`Stage "${stageName || sIdx + 1}" task ${tIdx + 1} has empty id.`);
      else if (seenIds.has(id)) errors.push(`Duplicate task id "${id}".`);
      else seenIds.add(id);

      const name = typeof t.name === 'string' ? t.name.trim() : '';
      if (!name) errors.push(`Task "${id || tIdx + 1}" has empty name.`);

      const role = t.role as TaskRole;
      if (!VALID_TASK_ROLES.has(role)) {
        errors.push(`Task "${id || tIdx + 1}" has invalid role "${String(t.role)}"; expected one of ${[...VALID_TASK_ROLES].join(', ')}.`);
      }

      const taskGoal = typeof t.goal === 'string' ? t.goal.trim() : '';
      if (!taskGoal) errors.push(`Task "${id || tIdx + 1}" has empty goal.`);

      let startUrl: string | undefined;
      if (t.startUrl !== undefined && t.startUrl !== null && String(t.startUrl).trim() !== '') {
        const candidate = String(t.startUrl).trim();
        if (!isValidHttpUrl(candidate)) {
          errors.push(`Task "${id || tIdx + 1}" has invalid startUrl "${candidate}" (only http:// or https:// URLs permitted).`);
        } else {
          startUrl = candidate;
        }
      }

      const effectClass = t.effectClass as TaskEffectClass;
      if (!VALID_EFFECT_CLASSES.has(effectClass)) {
        errors.push(`Task "${id || tIdx + 1}" has invalid effectClass "${String(t.effectClass)}".`);
      } else if (effectClass !== 'read' && t.requiresApproval !== true) {
        errors.push(`Task "${id || tIdx + 1}" has effectClass "${effectClass}" without requiresApproval: true.`);
      }

      if (!Array.isArray(t.dependsOn)) {
        errors.push(`Task "${id || tIdx + 1}" dependsOn must be an array of task IDs.`);
      }
      const dependsOn = Array.isArray(t.dependsOn) ? t.dependsOn.map((d: unknown) => String(d).trim()).filter(Boolean) : [];
      if (id) {
        depsByTask.set(id, dependsOn);
        stageIndexByTask.set(id, sIdx);
      }

      const approvalMarker = t.requiresApproval === true;
      stageTasksRaw.push({
        id,
        name,
        role,
        goal: taskGoal,
        startUrl,
        dependsOn,
        effectClass,
        requiresApproval: approvalMarker
      });
      stageTasksPlan.push({
        id,
        name,
        role,
        url: startUrl,
        instruction: taskGoal,
        effectClass,
        dependencies: dependsOn,
        requiresApproval: approvalMarker
      });
    }

    rawStages.push({
      name: stageName,
      parallelism: Number.isInteger(p) ? p : 1,
      tasks: stageTasksRaw
    });
    normalizedStages.push({
      stageName,
      parallelism: Number.isInteger(p) ? p : 1,
      tasks: stageTasksPlan
    });
  }

  if (totalTasks === 0) {
    errors.push('Plan must contain at least 1 task across all stages.');
  }

  // Dependency reference checks and ordering across stages
  for (const [id, deps] of depsByTask.entries()) {
    const myStage = stageIndexByTask.get(id)!;
    for (const dep of deps) {
      if (dep === id) {
        errors.push(`Task "${id}" cannot depend on itself.`);
      } else if (!seenIds.has(dep)) {
        errors.push(`Task "${id}" depends on unknown task "${dep}".`);
      } else {
        const depStage = stageIndexByTask.get(dep)!;
        if (depStage > myStage) {
          errors.push(`Task "${id}" (stage ${myStage + 1}) cannot depend on later-stage task "${dep}" (stage ${depStage + 1}).`);
        }
      }
    }
  }

  const cycle = detectDependencyCycle(depsByTask);
  if (cycle) {
    errors.push(`Dependency cycle detected: ${cycle.join(' -> ')}.`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  if (opts.forceSwarm && mode === 'single') {
    mode = 'swarm';
    warnings.push('User passed /swarm override; upgraded execution mode to swarm.');
  }

  const plan: MissionDecompositionPlan = {
    missionId: opts.missionId,
    goal: opts.goal,
    justification: opts.forceSwarm && !justification.includes('/swarm')
      ? `${justification} (Forced swarm mode via explicit /swarm command.)`
      : justification,
    stages: normalizedStages
  };

  const metrics = estimatePlanMetrics(plan, opts.model || '');

  return {
    ok: true,
    value: {
      mode,
      justification: plan.justification,
      plan,
      estimatedCostUSD: metrics.estimatedCostUSD,
      estimatedDurationSec: metrics.estimatedDurationSec,
      warnings,
      raw: { mode, justification: plan.justification, stages: rawStages }
    }
  };
}

export interface OrchestratorPlanDeps {
  provider: IModelProvider;
  missionId: string;
  goal: string;
  model: string;
  maxWorkers: number;
  brief?: MissionBrief;
  forceSwarm?: boolean;
  failureSummary?: string;
  signal?: AbortSignal;
}

/**
 * Calls the orchestrator model (`role: 'orchestrator'`) once with ONLY the user brief and mission bounds
 * (never untrusted raw page content). If the model emits prose or an invalid plan, sends one repair request
 * with the exact validation error; if that fails too, throws `PlanValidationError`.
 */
export async function planWithOrchestrator(deps: OrchestratorPlanDeps): Promise<OrchestratorPlanResult> {
  const cleanGoal = deps.goal.replace(/^\/swarm\b\s*/i, '').trim() || deps.goal.trim();
  const effectivePrompt = PromptRegistry.getInstance().getEffectivePrompt('orchestrator').systemPrompt;

  const userLines: string[] = [
    `User Mission Goal: ${cleanGoal}`,
    `Settings Limit: maxWorkers = ${Math.max(1, deps.maxWorkers)}`,
    deps.forceSwarm
      ? 'Override: User explicitly requested /swarm execution mode. Set mode="swarm" and decompose parallel stages if appropriate.'
      : 'Rule: Default to mode="single" unless parallel multi-source execution is clearly needed and justified.'
  ];
  if (deps.brief?.successCriteria?.length) {
    userLines.push(`Success Criteria:\n${deps.brief.successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`);
  }
  if (deps.failureSummary) {
    userLines.push(`Re-planning Context (previous stage failure / conflict):\n${deps.failureSummary}`);
  }
  userLines.push('Call submit_plan exactly once now.');

  const messages: CanonicalMessage[] = [{ role: 'user', content: userLines.join('\n\n') }];

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await deps.provider.generate({
      systemPrompt: effectivePrompt,
      messages,
      tools: [SUBMIT_PLAN_TOOL],
      abortSignal: deps.signal,
      temperature: 0
    });

    const call = (response.toolCalls ?? []).find(tc => tc.name === 'submit_plan');
    let candidateArgs: unknown = call?.arguments;
    let failureMsg = '';

    if (!call) {
      // Check if model wrote JSON inline without calling tool -> still require tool call (repair once)
      failureMsg = `You responded without calling the required submit_plan tool (got text: "${(response.text || '').slice(0, 140)}"). Call submit_plan exactly once with valid JSON arguments.`;
    } else {
      const checked = validateOrchestratorPlan(candidateArgs, {
        maxWorkers: deps.maxWorkers,
        missionId: deps.missionId,
        goal: cleanGoal,
        model: deps.model,
        forceSwarm: deps.forceSwarm
      });
      if (checked.ok) {
        logger.info('Orchestrator produced validated plan', {
          missionId: deps.missionId,
          mode: checked.value.mode,
          stages: checked.value.plan.stages.length,
          attempt: attempt + 1
        });
        return checked.value;
      }
      failureMsg = `Invalid plan submitted: ${checked.errors.join(' | ')}`;
    }

    if (attempt === 1) {
      logger.error('Orchestrator failed after repair attempt', undefined, { missionId: deps.missionId, error: failureMsg });
      throw new PlanValidationError(failureMsg);
    }

    logger.warn('Orchestrator plan rejected; requesting one repair', { missionId: deps.missionId, error: failureMsg });
    if (call) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments }]
      });
      messages.push({
        role: 'tool',
        content: [{ type: 'tool_result', toolCallId: call.id, output: `Plan validation failed: ${failureMsg}. Fix every error and call submit_plan again.`, isError: true }]
      });
    } else {
      if (response.text) messages.push({ role: 'assistant', content: response.text });
      messages.push({ role: 'user', content: failureMsg });
    }
  }

  throw new PlanValidationError('Orchestrator did not produce a valid plan.');
}

/** Human-readable diff summary between an earlier plan and a revised plan (shown in timeline on replan). */
export function diffPlans(prev: MissionDecompositionPlan, next: MissionDecompositionPlan): string[] {
  const prevTasks = new Map(prev.stages.flatMap(s => s.tasks.map(t => [t.id, t])));
  const nextTasks = new Map(next.stages.flatMap(s => s.tasks.map(t => [t.id, t])));
  const lines: string[] = [];

  for (const [id, t] of nextTasks) {
    const old = prevTasks.get(id);
    if (!old) lines.push(`+ Added task ${id} (${t.role}): ${t.name}`);
    else if (old.instruction !== t.instruction || old.url !== t.url) lines.push(`~ Updated task ${id}: ${t.name}`);
  }
  for (const [id, t] of prevTasks) {
    if (!nextTasks.has(id)) lines.push(`- Removed task ${id}: ${t.name}`);
  }
  if (lines.length === 0) lines.push('~ Revised stage parallelism / justification');
  return lines;
}
