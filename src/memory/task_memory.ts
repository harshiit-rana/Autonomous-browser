/**
 * Project Aegis - Task Memory, Skills & Preference Store (Issue #179 - [MEM-02])
 * 
 * Features:
 * - User preference facts (confirmed user preferences: sizes, addresses, budgets)
 * - Per-site navigation knowledge with self-healing role+name+context fingerprints
 * - Learned skills: parameterised multi-step plans with checkpoints and expected outcomes
 * - Provenance & Memory Poisoning Defence:
 *   - Strictly segregates user, agent, and page-derived memories
 *   - Page-derived memories are marked tainted and NEVER injected into prompts as instructions
 */

import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('task-memory');

export type MemoryProvenance = 'user' | 'agent' | 'page-derived';

export interface UserPreference {
  id: string;
  category: 'identity' | 'address' | 'shopping' | 'budget' | 'general';
  key: string;
  value: string;
  confirmedByUser: boolean;
  timestamp: number;
}

export interface SiteKnowledge {
  domain: string;
  loginPath?: string;
  searchInputFingerprint?: string;
  cookieDismissMethod?: 'click' | 'css_injection';
  paginationStyle?: 'numeric' | 'infinite_scroll' | 'next_button' | 'cursor_api';
  lastVerifiedAt: number;
  successRate: number;
}

export interface LearnedSkill {
  id: string;
  name: string;
  description: string;
  targetDomain: string;
  parameters: string[]; // e.g. ['productName', 'maxPrice']
  steps: Array<{
    stepNumber: number;
    action: string;
    targetFingerprint: string;
    expectedOutcome: string;
  }>;
  provenance: MemoryProvenance;
  isTainted: boolean;
  timesExecuted: number;
  createdAt: number;
}

export class TaskMemoryManager {
  private preferences: Map<string, UserPreference> = new Map();
  private siteKnowledge: Map<string, SiteKnowledge> = new Map();
  private learnedSkills: Map<string, LearnedSkill> = new Map();

  // --- Preferences ---
  public setPreference(key: string, value: string, category: UserPreference['category'] = 'general', confirmed: boolean = true): UserPreference {
    const id = `pref_${key.toLowerCase()}`;
    const pref: UserPreference = {
      id,
      category,
      key,
      value,
      confirmedByUser: confirmed,
      timestamp: Date.now()
    };
    this.preferences.set(id, pref);
    logger.info('User preference saved', { key, category, confirmed });
    return pref;
  }

  public getPreference(key: string): UserPreference | undefined {
    return this.preferences.get(`pref_${key.toLowerCase()}`);
  }

  public listPreferences(): UserPreference[] {
    return Array.from(this.preferences.values());
  }

  // --- Site Knowledge ---
  public recordSiteKnowledge(domain: string, patch: Partial<SiteKnowledge>): SiteKnowledge {
    const key = domain.toLowerCase();
    const existing = this.siteKnowledge.get(key) || {
      domain: key,
      lastVerifiedAt: Date.now(),
      successRate: 1.0
    };

    const updated: SiteKnowledge = {
      ...existing,
      ...patch,
      lastVerifiedAt: Date.now()
    };

    this.siteKnowledge.set(key, updated);
    logger.info('Updated site knowledge', { domain: key, patch });
    return updated;
  }

  public getSiteKnowledge(domain: string): SiteKnowledge | undefined {
    return this.siteKnowledge.get(domain.toLowerCase());
  }

  // --- Learned Skills ---
  public saveSkill(params: {
    name: string;
    description: string;
    targetDomain: string;
    parameters: string[];
    steps: LearnedSkill['steps'];
    provenance: MemoryProvenance;
  }): LearnedSkill {
    const id = `skill_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const isTainted = params.provenance === 'page-derived';

    const skill: LearnedSkill = {
      id,
      name: params.name,
      description: params.description,
      targetDomain: params.targetDomain.toLowerCase(),
      parameters: params.parameters,
      steps: params.steps,
      provenance: params.provenance,
      isTainted,
      timesExecuted: 0,
      createdAt: Date.now()
    };

    this.learnedSkills.set(id, skill);
    logger.info('Saved learned skill', { id, name: params.name, provenance: params.provenance, isTainted });
    return skill;
  }

  public getSkill(id: string): LearnedSkill | undefined {
    return this.learnedSkills.get(id);
  }

  public findSkillsForDomain(domain: string): LearnedSkill[] {
    const d = domain.toLowerCase();
    return Array.from(this.learnedSkills.values()).filter(s => s.targetDomain === d || d.endsWith(`.${s.targetDomain}`));
  }

  /**
   * Safe instruction formatter: filters out tainted page-derived skills
   * from being injected into model prompt context as system instructions.
   */
  public getSafeSkillsForPrompt(domain: string): LearnedSkill[] {
    return this.findSkillsForDomain(domain).filter(s => !s.isTainted);
  }
}
