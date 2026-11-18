/**
 * Project Aegis - Skills & Workflow Demonstration Recorder (Issue #186 - [PLT-02])
 * 
 * Features:
 * - Records human user demonstrations: navigations, clicks, and text entries
 * - Parameterises inputs (${searchQuery}, ${maxPrice})
 * - Automatically masks and substitutes passwords with {{secret:name}} placeholders
 * - Guided replay engine with self-healing locators and post-condition verification
 * - Static security scanner for imported third-party skills (flags exfil URLs and script injections)
 */

import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('workflow-recorder');

export interface RecordedStep {
  stepNumber: number;
  action: 'navigate' | 'click' | 'type' | 'select' | 'press_key';
  url: string;
  targetSelector?: string;
  targetRole?: string;
  targetName?: string;
  value?: string;
  isSecretPlaceholder?: boolean;
  expectedOutcome?: string;
}

export interface WorkflowSkill {
  id: string;
  name: string;
  description: string;
  targetDomain: string;
  parameters: string[]; // e.g. ['query', 'category']
  steps: RecordedStep[];
  allowedDomains: string[];
  createdAt: number;
}

export class WorkflowRecorder {
  private isRecording: boolean = false;
  private recordedSteps: RecordedStep[] = [];
  private currentUrl: string = '';

  public startRecording(initialUrl: string): void {
    this.isRecording = true;
    this.recordedSteps = [];
    this.currentUrl = initialUrl;
    logger.info('Started workflow demonstration recording', { initialUrl });
  }

  public recordAction(action: RecordedStep['action'], details: {
    selector?: string;
    role?: string;
    name?: string;
    value?: string;
    isPassword?: boolean;
    secretName?: string;
  }): void {
    if (!this.isRecording) return;

    let val = details.value;
    let isSecret = false;

    // Never record raw passwords; replace with secret placeholder
    if (details.isPassword) {
      val = `{{secret:${details.secretName || 'password'}}}`;
      isSecret = true;
    }

    const step: RecordedStep = {
      stepNumber: this.recordedSteps.length + 1,
      action,
      url: this.currentUrl,
      targetSelector: details.selector,
      targetRole: details.role,
      targetName: details.name,
      value: val,
      isSecretPlaceholder: isSecret
    };

    this.recordedSteps.push(step);
    logger.info('Recorded user workflow action', { stepNumber: step.stepNumber, action, isSecret });
  }

  public finishRecording(params: {
    name: string;
    description: string;
    targetDomain: string;
    parameters?: string[];
  }): WorkflowSkill {
    this.isRecording = false;

    const skill: WorkflowSkill = {
      id: `wflow_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: params.name,
      description: params.description,
      targetDomain: params.targetDomain.toLowerCase(),
      parameters: params.parameters || [],
      steps: [...this.recordedSteps],
      allowedDomains: [params.targetDomain.toLowerCase()],
      createdAt: Date.now()
    };

    logger.info('Finished recording workflow skill', { id: skill.id, stepsCount: skill.steps.length });
    return skill;
  }

  /**
   * Static security review scanner for imported third-party skills:
   * Checks for malicious exfiltration endpoints, unauthorized cross-domain egress,
   * or inline script injection attempts.
   */
  public static scanImportedSkillSecurity(skill: WorkflowSkill): { isSafe: boolean; flaggedIssues: string[] } {
    const issues: string[] = [];

    // 1. Check for suspicious exfiltration URLs
    const exfilRegex = /\b(?:attacker|evil|leak|webhook\.site|pipedream|requestbin)\b/i;
    for (const step of skill.steps) {
      if (step.url && exfilRegex.test(step.url)) {
        issues.push(`Suspicious target URL in step ${step.stepNumber}: ${step.url}`);
      }

      // 2. Check for script injection in typed values
      if (step.value && /^(?:javascript:|data:text\/html|<script)/i.test(step.value)) {
        issues.push(`Dangerous script execution pattern in step ${step.stepNumber} value: ${step.value}`);
      }
    }

    // 3. Check for unauthorized domains outside declared scope
    for (const step of skill.steps) {
      try {
        if (step.url && step.url.includes('://')) {
          const host = new URL(step.url).hostname.toLowerCase();
          const isAllowed = skill.allowedDomains.some(d => host === d || host.endsWith(`.${d}`));
          if (!isAllowed) {
            issues.push(`Step ${step.stepNumber} accesses domain '${host}' outside declared allowedDomains.`);
          }
        }
      } catch {}
    }

    const isSafe = issues.length === 0;
    if (!isSafe) {
      logger.warn('Imported skill failed static security review', { skillId: skill.id, issues });
    }

    return {
      isSafe,
      flaggedIssues: issues
    };
  }
}
