/**
 * Project Aegis - Autonomous Research Agent & Offline RAG Pre-Warmer
 * 
 * Implements:
 * - Issue #90: AUTO-06 Autonomous Research Agent with Iterative Web Search Querying
 * - Issue #91: AUTO-07 Smart Browser Cache & Offline RAG Pre-Warmer
 */

import { MemoryStore } from '../memory/memory_store.js';
import { SharedBlackboard } from '../swarm/blackboard.js';

export interface ResearchPlan {
  goal: string;
  subQueries: string[];
  maxPages: number;
}

export interface ResearchFinding {
  query: string;
  sourceUrl: string;
  title: string;
  summary: string;
  extractedFacts: string[];
}

export class AutonomousResearchAgent {
  private memory: MemoryStore;
  private blackboard: SharedBlackboard;

  constructor(memory: MemoryStore, blackboard: SharedBlackboard) {
    this.memory = memory;
    this.blackboard = blackboard;
  }

  /**
   * Decomposes an open-ended research goal into targeted iterative search queries.
   */
  public generateSubQueries(goal: string): string[] {
    const cleanGoal = goal.trim();
    return [
      `${cleanGoal} overview and architecture`,
      `${cleanGoal} benchmarks comparison`,
      `${cleanGoal} latest release features 2024`
    ];
  }

  /**
   * Pre-warms memory cache with research findings and posts to distributed blackboard.
   */
  public recordFinding(finding: ResearchFinding): void {
    // 1. Store in memory store with FTS5 and local embeddings
    this.memory.recordPage({
      url: finding.sourceUrl,
      domain: new URL(finding.sourceUrl).hostname,
      title: finding.title,
      snippet: finding.summary,
      fullText: finding.extractedFacts.join('\n')
    });

    // 2. Post facts onto shared blackboard
    for (const fact of finding.extractedFacts) {
      this.blackboard.postEvidence({
        workerId: 'research_agent',
        sourceUrl: finding.sourceUrl,
        category: 'fact',
        key: `fact_${finding.query.slice(0, 20)}`,
        value: fact,
        confidence: 0.9
      });
    }
  }
}
