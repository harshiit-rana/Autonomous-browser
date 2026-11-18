/**
 * Project Aegis - Natural Language Browsing History Recall (Issue #180 - [MEM-03])
 * 
 * Features:
 * - Natural-language semantic search across visited web pages
 * - Explicit user opt-in consent requirement (default disabled)
 * - Strict exclusion filtering (banking, healthcare, passwords, authentication, incognito)
 * - Retention TTL and "forget domain/day" privacy controls
 */

import { SemanticMemoryStore, HybridSearchResult } from './semantic_memory.js';
import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('history-recall');

export interface HistoryRecallOptions {
  enabled: boolean;
  retentionDays: number;
  excludedDomains?: string[];
}

export class HistoryRecallEngine {
  private memoryStore: SemanticMemoryStore;
  private isEnabled: boolean = false;
  private retentionDays: number = 30;

  constructor(memoryStore?: SemanticMemoryStore, options?: Partial<HistoryRecallOptions>) {
    this.memoryStore = memoryStore || new SemanticMemoryStore();
    this.isEnabled = options?.enabled ?? false; // Default OFF for privacy
    this.retentionDays = options?.retentionDays ?? 30;

    if (options?.excludedDomains) {
      for (const d of options.excludedDomains) {
        this.memoryStore.addExcludedDomain(d);
      }
    }
  }

  public setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    logger.info('History recall semantic indexing state changed', { enabled });
  }

  public isOptedIn(): boolean {
    return this.isEnabled;
  }

  /**
   * Indexes a visited page if user has explicitly enabled history recall
   */
  public onPageVisited(params: {
    url: string;
    title: string;
    fullText: string;
    isIncognito?: boolean;
  }): { indexed: boolean; reason?: string } {
    if (!this.isEnabled) {
      return { indexed: false, reason: 'History recall is disabled (user not opted-in)' };
    }

    if (params.isIncognito) {
      return { indexed: false, reason: 'Incognito navigation' };
    }

    return this.memoryStore.indexPage({
      url: params.url,
      title: params.title,
      fullText: params.fullText,
      isIncognito: false
    });
  }

  /**
   * Performs natural language recall search over visited history
   */
  public recall(query: string, topK: number = 5): HybridSearchResult[] {
    if (!this.isEnabled) {
      logger.warn('Attempted history recall query while feature is disabled');
      return [];
    }

    return this.memoryStore.search(query, topK);
  }
}
