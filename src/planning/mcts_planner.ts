/**
 * Project Aegis - Planning & Speculative Search
 * 
 * NOTE: As documented in ADR-004, classic MCTS rollouts are unsafe on the web
 * due to non-resettable server state and runaway token costs.
 * This module re-exports the winning SpeculativeBranchingEngine and provides
 * backward compatibility for heuristic state evaluation.
 */

import { PageDOMState } from '../core/dom_indexer.js';
export { SpeculativeBranchingEngine, ExplorationBranch } from '../swarm/speculative_branching.js';

export class MCTSPlanner {
  /**
   * Evaluates state desirability based on keyword matching and error indicators
   */
  public evaluateState(domState: PageDOMState, goal: string): number {
    let score = 0.5;

    if (/404|not\s+found|error|access\s+denied|forbidden/i.test(domState.title)) {
      return 0.05;
    }

    const goalKeywords = goal.toLowerCase().split(/\s+/).filter(k => k.length > 3);
    let matchedKeywords = 0;

    for (const kw of goalKeywords) {
      if (domState.title.toLowerCase().includes(kw)) matchedKeywords++;
      for (const el of domState.elements.slice(0, 15)) {
        if (el.label?.toLowerCase().includes(kw)) {
          matchedKeywords++;
          break;
        }
      }
    }

    const keywordRatio = goalKeywords.length > 0 ? matchedKeywords / goalKeywords.length : 0;
    score = Math.min(1.0, 0.4 + keywordRatio * 0.6);

    return score;
  }
}
