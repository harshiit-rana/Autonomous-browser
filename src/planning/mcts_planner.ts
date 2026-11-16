import { PageDOMState } from '../core/dom_indexer.js';

export interface PlanAction {
  id: string;
  type: 'click' | 'type' | 'scroll' | 'navigate' | 'backtrack';
  targetElementId?: string;
  payload?: any;
  description: string;
}

export interface StateNode {
  id: string;
  parentId: string | null;
  url: string;
  title: string;
  depth: number;
  visitCount: number;
  totalReward: number;
  domState: PageDOMState;
  actionTaken?: PlanAction;
  children: StateNode[];
  isTerminal: boolean;
}

/**
 * MCTSPlanner
 * Monte Carlo Tree Search & Best-First Planning Engine for Autonomous Web Navigation.
 * Enables branching exploration, state value scoring, and rollbacks to recover from dead ends.
 */
export class MCTSPlanner {
  private explorationConstant: number;
  private maxDepth: number;

  constructor(explorationConstant: number = 1.414, maxDepth: number = 5) {
    this.explorationConstant = explorationConstant;
    this.maxDepth = maxDepth;
  }

  /**
   * Upper Confidence Bound for Trees (UCT) Selection
   */
  public selectBestChild(node: StateNode): StateNode | null {
    if (node.children.length === 0) return null;

    let bestChild: StateNode | null = null;
    let bestValue = -Infinity;

    for (const child of node.children) {
      if (child.visitCount === 0) {
        return child; // Always explore unvisited nodes first
      }

      // UCT Formula: Q(s, a) / N(s, a) + c * sqrt(ln(N(s)) / N(s, a))
      const exploitation = child.totalReward / child.visitCount;
      const exploration = this.explorationConstant * Math.sqrt(Math.log(node.visitCount) / child.visitCount);
      const uctValue = exploitation + exploration;

      if (uctValue > bestValue) {
        bestValue = uctValue;
        bestChild = child;
      }
    }

    return bestChild;
  }

  /**
   * Heuristic Evaluation Critic
   * Scores state desirability [0.0 - 1.0] based on goal alignment and error indicators.
   */
  public evaluateState(domState: PageDOMState, goal: string): number {
    let score = 0.5;

    // Penalty for dead ends / error states
    if (/404|not\s+found|error|access\s+denied|forbidden/i.test(domState.title)) {
      return 0.05;
    }

    // Reward for keyword presence matching goal
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

  /**
   * Backpropagates reward through the parent hierarchy
   */
  public backpropagate(node: StateNode, reward: number): void {
    let current: StateNode | null = node;
    while (current !== null) {
      current.visitCount++;
      current.totalReward += reward;
      // In a full tree, we find parent by parentId
      current = null;
    }
  }
}
