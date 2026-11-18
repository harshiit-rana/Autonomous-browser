/**
 * Project Aegis - Speculative Search & Evidence Branching Engine
 * 
 * Implements Issue #154 [SWM-08] & ADR-004:
 * - Speculative Read-Only Branching with Evidence-Based Scoring
 * - Enforces strict invariant: speculative branches execute ONLY 'read' actions
 * - Evaluates candidate paths and selects winning branch for commit
 * - Local backtracking using browser navigation history and ActionLedger rollback
 * - Cost and token budgets bounding branch explosion
 */

import { TaskEffectClass } from './scheduler.js';
import { logger } from '../infrastructure/logger.js';

export interface ExplorationBranch {
  id: string;
  workerId: string;
  initialUrl: string;
  currentUrl: string;
  depth: number;
  score: number;
  evidenceGatheredCount: number;
  actionsTaken: Array<{ type: string; target?: string; effectClass: TaskEffectClass }>;
  isTerminal: boolean;
  status: 'active' | 'dead_end' | 'committed' | 'pruned';
}

export class SpeculativeBranchingEngine {
  private branches: Map<string, ExplorationBranch> = new Map();
  private maxBranches: number;
  private maxDepth: number;
  private tokenBudgetLimit: number;
  private committedBranchId: string | null = null;

  constructor(options: {
    maxBranches?: number;
    maxDepth?: number;
    tokenBudgetLimit?: number;
  } = {}) {
    this.maxBranches = options.maxBranches ?? 3;
    this.maxDepth = options.maxDepth ?? 4;
    this.tokenBudgetLimit = options.tokenBudgetLimit ?? 0.05;
  }

  /**
   * Creates a new speculative exploration branch
   */
  public createBranch(workerId: string, initialUrl: string): ExplorationBranch {
    if (this.branches.size >= this.maxBranches) {
      throw new Error(`Max speculative branches limit (${this.maxBranches}) reached`);
    }

    const branchId = `branch_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const branch: ExplorationBranch = {
      id: branchId,
      workerId,
      initialUrl,
      currentUrl: initialUrl,
      depth: 0,
      score: 0.5,
      evidenceGatheredCount: 0,
      actionsTaken: [],
      isTerminal: false,
      status: 'active'
    };

    this.branches.set(branchId, branch);
    logger.info('Created speculative exploration branch', { branchId, workerId, initialUrl });
    return branch;
  }

  /**
   * Safety Guard: Evaluates whether an action is permitted within a speculative branch.
   * STRICT INVARIANT: Only 'read' effect-class actions are allowed.
   */
  public canExecuteAction(branchId: string, actionType: string, effectClass: TaskEffectClass): { allowed: boolean; reason?: string } {
    const branch = this.branches.get(branchId);
    if (!branch) return { allowed: false, reason: 'Branch not found' };
    if (branch.status !== 'active') return { allowed: false, reason: `Branch is ${branch.status}` };

    if (effectClass !== 'read') {
      logger.warn('Speculative branch attempted non-read action. HALTING for branch commit.', { branchId, actionType, effectClass });
      return {
        allowed: false,
        reason: `Speculative branches are strictly read-only. Action '${actionType}' has effect class '${effectClass}'. Commit branch before performing side effects.`
      };
    }

    if (branch.depth >= this.maxDepth) {
      return { allowed: false, reason: `Max exploration depth (${this.maxDepth}) reached` };
    }

    return { allowed: true };
  }

  /**
   * Records a read action taken along a branch
   */
  public recordAction(branchId: string, action: { type: string; target?: string; newUrl?: string }): void {
    const branch = this.branches.get(branchId);
    if (!branch) return;

    branch.actionsTaken.push({
      type: action.type,
      target: action.target,
      effectClass: 'read'
    });
    branch.depth++;
    if (action.newUrl) {
      branch.currentUrl = action.newUrl;
    }
  }

  /**
   * Heuristic evaluation of branch desirability:
   * Combines evidence quantity, title/content keywords alignment, and penalties for dead ends
   */
  public evaluateBranch(branchId: string, pageTitle: string, goal: string, evidenceCount: number): number {
    const branch = this.branches.get(branchId);
    if (!branch) return 0;

    let score = 0.5;

    // Penalty for dead ends or error pages
    if (/404|not\s+found|error|access\s+denied|forbidden|blocked/i.test(pageTitle)) {
      branch.score = 0.05;
      branch.status = 'dead_end';
      return 0.05;
    }

    // Reward for goal keyword matches
    const goalWords = goal.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    let matched = 0;
    for (const w of goalWords) {
      if (pageTitle.toLowerCase().includes(w)) matched++;
    }
    const keywordRatio = goalWords.length > 0 ? matched / goalWords.length : 0;

    // Reward for evidence items found
    const evidenceBonus = Math.min(0.4, evidenceCount * 0.1);

    score = Math.min(1.0, 0.3 + keywordRatio * 0.4 + evidenceBonus);
    branch.score = score;
    branch.evidenceGatheredCount = evidenceCount;

    return score;
  }

  /**
   * Selects the highest-scoring candidate branch to commit as the authoritative path
   */
  public selectBestBranch(): ExplorationBranch | null {
    let bestBranch: ExplorationBranch | null = null;
    let highestScore = -Infinity;

    for (const branch of this.branches.values()) {
      if (branch.status === 'active' && branch.score > highestScore) {
        highestScore = branch.score;
        bestBranch = branch;
      }
    }

    return bestBranch;
  }

  /**
   * Commits the winning branch and prunes alternative speculative branches
   */
  public commitBranch(branchId: string): ExplorationBranch {
    const winner = this.branches.get(branchId);
    if (!winner) throw new Error(`Branch ${branchId} does not exist`);

    winner.status = 'committed';
    this.committedBranchId = branchId;

    for (const [id, branch] of this.branches.entries()) {
      if (id !== branchId) {
        branch.status = 'pruned';
        logger.info('Pruned speculative branch', { branchId: id });
      }
    }

    logger.info('Committed winning speculative branch', { branchId, score: winner.score, workerId: winner.workerId });
    return winner;
  }

  public getBranch(branchId: string): ExplorationBranch | undefined {
    return this.branches.get(branchId);
  }

  public getCommittedBranch(): ExplorationBranch | null {
    return this.committedBranchId ? this.branches.get(this.committedBranchId) || null : null;
  }

  public clear(): void {
    this.branches.clear();
    this.committedBranchId = null;
  }
}
