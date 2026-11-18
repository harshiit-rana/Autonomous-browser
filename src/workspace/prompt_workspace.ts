/**
 * Project Aegis - Structured Prompt Workspace & Mission Drafter
 * Implements: Issue #206 [WKS-01] Structured mission inputs, constraints,
 * autonomy levels, draft persistence, and token estimation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAppPaths } from '../infrastructure/paths.js';
import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('prompt-workspace');

export interface MissionConstraints {
  budgetUSD?: number;
  deadlineMinutes?: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  neverSubmitOrBuy?: boolean;
}

export interface StructuredMissionDraft {
  id: string;
  title: string;
  goal: string;
  constraints?: MissionConstraints;
  successCriteria?: string;
  outputFormat: 'markdown' | 'table' | 'json' | 'csv';
  autonomyLevel: 'run_unattended' | 'ask_for_risky' | 'ask_always';
  lastModified: number;
}

export class PromptWorkspaceManager {
  private static instance: PromptWorkspaceManager | null = null;
  private draftsDir: string | null = null;
  private inMemoryDrafts: Map<string, StructuredMissionDraft> = new Map();

  private constructor() {
    try {
      const paths = getAppPaths();
      this.draftsDir = path.join(paths.userData, 'drafts');
      if (!fs.existsSync(this.draftsDir)) {
        fs.mkdirSync(this.draftsDir, { recursive: true });
      }
    } catch {
      this.draftsDir = null;
    }
  }

  public static getInstance(): PromptWorkspaceManager {
    if (!PromptWorkspaceManager.instance) {
      PromptWorkspaceManager.instance = new PromptWorkspaceManager();
    }
    return PromptWorkspaceManager.instance;
  }

  public static estimateTokens(text: string): number {
    if (!text) return 0;
    // Approximating ~4 chars per token for English text
    return Math.ceil(text.length / 4);
  }

  /**
   * Compiles structured draft fields into a single unambiguous goal string
   * formatted with clear system boundaries for the agent.
   */
  public compileToPrompt(draft: StructuredMissionDraft): string {
    const parts: string[] = [];

    parts.push(`GOAL: ${draft.goal}`);

    if (draft.successCriteria) {
      parts.push(`SUCCESS CRITERIA: ${draft.successCriteria}`);
    }

    if (draft.constraints) {
      const c = draft.constraints;
      const constraintList: string[] = [];
      if (c.budgetUSD) constraintList.push(`Max budget: $${c.budgetUSD}`);
      if (c.deadlineMinutes) constraintList.push(`Deadline: within ${c.deadlineMinutes} minutes`);
      if (c.allowedDomains && c.allowedDomains.length > 0) constraintList.push(`Allowed domains: ${c.allowedDomains.join(', ')}`);
      if (c.blockedDomains && c.blockedDomains.length > 0) constraintList.push(`Blocked domains: ${c.blockedDomains.join(', ')}`);
      if (c.neverSubmitOrBuy) constraintList.push('STRICT: Never click purchase, payment, or final submission buttons');

      if (constraintList.length > 0) {
        parts.push(`CONSTRAINTS:\n- ${constraintList.join('\n- ')}`);
      }
    }

    parts.push(`OUTPUT FORMAT: Output final results as structured ${draft.outputFormat}`);
    parts.push(`AUTONOMY LEVEL: ${draft.autonomyLevel}`);

    return parts.join('\n\n');
  }

  public saveDraft(draft: StructuredMissionDraft): void {
    draft.lastModified = Date.now();
    this.inMemoryDrafts.set(draft.id, draft);

    if (this.draftsDir) {
      try {
        const filePath = path.join(this.draftsDir, `${draft.id}.json`);
        fs.writeFileSync(filePath, JSON.stringify(draft, null, 2), 'utf-8');
      } catch (err: any) {
        logger.warn('Failed to persist draft to disk', { id: draft.id, error: err.message });
      }
    }
  }

  public getDraft(id: string): StructuredMissionDraft | undefined {
    if (this.inMemoryDrafts.has(id)) {
      return this.inMemoryDrafts.get(id);
    }

    if (this.draftsDir) {
      const filePath = path.join(this.draftsDir, `${id}.json`);
      if (fs.existsSync(filePath)) {
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const draft = JSON.parse(raw);
          this.inMemoryDrafts.set(id, draft);
          return draft;
        } catch {}
      }
    }

    return undefined;
  }

  public listDrafts(): StructuredMissionDraft[] {
    if (this.draftsDir && fs.existsSync(this.draftsDir)) {
      try {
        const files = fs.readdirSync(this.draftsDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
          const id = file.replace('.json', '');
          if (!this.inMemoryDrafts.has(id)) {
            const raw = fs.readFileSync(path.join(this.draftsDir, file), 'utf-8');
            this.inMemoryDrafts.set(id, JSON.parse(raw));
          }
        }
      } catch {}
    }

    return Array.from(this.inMemoryDrafts.values()).sort((a, b) => b.lastModified - a.lastModified);
  }

  public deleteDraft(id: string): boolean {
    this.inMemoryDrafts.delete(id);
    if (this.draftsDir) {
      const filePath = path.join(this.draftsDir, `${id}.json`);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
          return true;
        } catch {}
      }
    }
    return true;
  }
}
