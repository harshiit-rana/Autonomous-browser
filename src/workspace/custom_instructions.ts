/**
 * Project Aegis - Layered Custom Instructions & Rules Engine
 * Implements: Issue #208 [WKS-03] Layered global, profile, site-specific,
 * and mission rules with precedence and effective instruction inspection.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAppPaths } from '../infrastructure/paths.js';
import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('custom-instructions');

export interface InstructionRule {
  id: string;
  scope: 'global' | 'profile' | 'site' | 'mission';
  targetDomain?: string; // For site rules (e.g. 'github.com', 'amazon.com')
  ruleText: string;
  enabled: boolean;
  priority: number; // Higher number overrides or appends with higher precedence
}

export interface EffectiveInstructions {
  compiledInstructions: string;
  activeRules: InstructionRule[];
  rulesAppliedCount: number;
  tokenEstimate: number;
}

export class InstructionManager {
  private static instance: InstructionManager | null = null;
  private rules: Map<string, InstructionRule> = new Map();
  private storePath: string | null = null;

  private constructor() {
    try {
      const paths = getAppPaths();
      this.storePath = path.join(paths.userData, 'instructions.json');
      this.load();
    } catch {
      this.storePath = null;
      this.seedDefaults();
    }
  }

  public static getInstance(): InstructionManager {
    if (!InstructionManager.instance) {
      InstructionManager.instance = new InstructionManager();
    }
    return InstructionManager.instance;
  }

  private seedDefaults(): void {
    this.addRule({
      id: 'rule_global_default',
      scope: 'global',
      ruleText: 'Always prefer concise markdown deliverables with verified factual citations.',
      enabled: true,
      priority: 10
    });
    this.addRule({
      id: 'rule_site_hn',
      scope: 'site',
      targetDomain: 'news.ycombinator.com',
      ruleText: 'When parsing Hacker News, focus on top-level submissions and story scores.',
      enabled: true,
      priority: 20
    });
  }

  public addRule(rule: InstructionRule): void {
    this.rules.set(rule.id, rule);
    this.save();
    logger.info('Instruction rule added', { id: rule.id, scope: rule.scope, domain: rule.targetDomain });
  }

  public removeRule(id: string): boolean {
    const deleted = this.rules.delete(id);
    if (deleted) this.save();
    return deleted;
  }

  public getRules(): InstructionRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * Compiles the active layered instructions for a given context and site.
   * Precedence order: Global -> Profile -> Site -> Mission.
   */
  public compile(urlOrDomain?: string, missionSpecificRule?: string): EffectiveInstructions {
    const activeRules: InstructionRule[] = [];
    const domain = urlOrDomain ? this.extractDomain(urlOrDomain) : undefined;

    // 1. Global rules
    const globalRules = Array.from(this.rules.values())
      .filter(r => r.enabled && r.scope === 'global')
      .sort((a, b) => b.priority - a.priority);
    activeRules.push(...globalRules);

    // 2. Profile rules
    const profileRules = Array.from(this.rules.values())
      .filter(r => r.enabled && r.scope === 'profile')
      .sort((a, b) => b.priority - a.priority);
    activeRules.push(...profileRules);

    // 3. Site-specific rules
    if (domain) {
      const siteRules = Array.from(this.rules.values())
        .filter(r => r.enabled && r.scope === 'site' && r.targetDomain && (domain.includes(r.targetDomain) || r.targetDomain.includes(domain)))
        .sort((a, b) => b.priority - a.priority);
      activeRules.push(...siteRules);
    }

    // 4. Mission-specific rule
    if (missionSpecificRule && missionSpecificRule.trim()) {
      activeRules.push({
        id: `mission_rule_${Date.now()}`,
        scope: 'mission',
        ruleText: missionSpecificRule.trim(),
        enabled: true,
        priority: 100
      });
    }

    const lines = activeRules.map((r, i) => `${i + 1}. [${r.scope.toUpperCase()}${r.targetDomain ? `:${r.targetDomain}` : ''}] ${r.ruleText}`);
    const compiled = lines.join('\n');
    const tokenEstimate = Math.ceil(compiled.length / 4);

    return {
      compiledInstructions: compiled,
      activeRules,
      rulesAppliedCount: activeRules.length,
      tokenEstimate
    };
  }

  private extractDomain(url: string): string {
    try {
      if (!url.startsWith('http')) url = `https://${url}`;
      return new URL(url).hostname;
    } catch {
      return url.toLowerCase();
    }
  }

  private save(): void {
    if (!this.storePath) return;
    try {
      const data = Array.from(this.rules.values());
      fs.writeFileSync(this.storePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err: any) {
      logger.warn('Failed to save instructions to disk', { error: err.message });
    }
  }

  private load(): void {
    if (!this.storePath || !fs.existsSync(this.storePath)) {
      this.seedDefaults();
      return;
    }
    try {
      const raw = fs.readFileSync(this.storePath, 'utf-8');
      const list = JSON.parse(raw) as InstructionRule[];
      for (const r of list) {
        this.rules.set(r.id, r);
      }
    } catch {
      this.seedDefaults();
    }
  }
}
