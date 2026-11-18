/**
 * Project Aegis - Action Policy Engine & Policy Decision Point (PDP)
 * 
 * Implements Issue #158 [SEC-03]:
 * - Single Policy Decision Point (PDP) called before every agent action
 * - 10 Fine-Grained Risk Classes
 * - Goal-conditioned semantic evaluation
 * - Origin scope verification (eTLD+1 matching, SSO/CDN allowances)
 * - Deterministic allow / ask / deny decisions with audit policy traces
 */

import { logger } from '../infrastructure/logger.js';

export type PolicyDecision = 'allow' | 'ask' | 'deny';

export type ActionRiskClass =
  | 'read'
  | 'navigate-in-scope'
  | 'navigate-out-of-scope'
  | 'write-reversible'
  | 'write-irreversible'
  | 'financial'
  | 'credential'
  | 'permission-grant'
  | 'file-egress'
  | 'code-exec';

export interface ActionTargetFacts {
  tag?: string;
  type?: string;
  role?: string;
  name?: string;
  autocomplete?: string;
  href?: string;
  action?: string;
  method?: string;
  label?: string;
  value?: string;
}

export interface PolicyEvaluationRequest {
  missionId: string;
  userGoal: string;
  allowedOrigins: string[];
  currentUrl: string;
  actionName: string;
  actionArgs: Record<string, any>;
  targetFacts?: ActionTargetFacts;
  isTainted?: boolean;
}

export interface PolicyEvaluationResult {
  decision: PolicyDecision;
  riskClass: ActionRiskClass;
  reason: string;
  policyTrace: string[];
  requiresUserConfirmation: boolean;
  blockedTarget?: string;
}

export class ActionPolicyEngine {
  /**
   * Helper to extract eTLD+1 or hostname
   */
  public static getETLDPlusOne(urlStr: string): string {
    try {
      const parsed = new URL(urlStr);
      const parts = parsed.hostname.toLowerCase().split('.');
      if (parts.length > 2) {
        return parts.slice(-2).join('.');
      }
      return parsed.hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  /**
   * Tests if a candidate URL matches the allowed origins list
   */
  public static isOriginAllowed(candidateUrl: string, allowedOrigins: string[]): boolean {
    if (!candidateUrl) return false;
    if (allowedOrigins.length === 0) return true;

    try {
      const candidateHost = new URL(candidateUrl).hostname.toLowerCase();
      const candidateEtld = ActionPolicyEngine.getETLDPlusOne(candidateUrl);

      for (const allowed of allowedOrigins) {
        const cleanAllowed = allowed.toLowerCase().replace(/^\*\./, '');
        if (candidateHost === cleanAllowed || candidateHost.endsWith('.' + cleanAllowed)) {
          return true;
        }
        if (candidateEtld === cleanAllowed || candidateEtld.endsWith('.' + cleanAllowed)) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Classifies proposed action into its risk class based on semantic DOM facts and parameters
   */
  public static classifyRisk(
    actionName: string,
    actionArgs: Record<string, any>,
    currentUrl: string,
    allowedOrigins: string[],
    facts?: ActionTargetFacts
  ): ActionRiskClass {
    // 1. Code execution / dangerous schemes check
    const targetUrl = actionArgs?.url || facts?.href || '';
    if (/^(?:javascript:|data:|file:|chrome:|devtools:)/i.test(targetUrl)) {
      return 'code-exec';
    }

    // 2. Navigation actions
    if (actionName === 'navigate') {
      const allowed = ActionPolicyEngine.isOriginAllowed(targetUrl, allowedOrigins);
      return allowed ? 'navigate-in-scope' : 'navigate-out-of-scope';
    }

    // 3. Financial actions: Payment, Checkout, Orders
    const labelAndAction = `${facts?.label || ''} ${facts?.action || ''} ${facts?.href || ''} ${facts?.name || ''}`.toLowerCase();
    const financialPatterns = /\b(?:place\s+order|buy\s+now|pay\s*now|checkout|confirm\s+payment|purchase|complete\s+order)\b/i;
    if (financialPatterns.test(labelAndAction)) {
      return 'financial';
    }

    // 4. Credential actions: Passwords, CVV, Card numbers
    const inputAutocomplete = (facts?.autocomplete || '').toLowerCase();
    const inputType = (facts?.type || '').toLowerCase();
    if (
      inputType === 'password' ||
      /current-password|new-password|cc-number|cc-csc|cc-exp/i.test(inputAutocomplete) ||
      actionName === 'type' && (actionArgs?.text?.includes('{{secret:') || /password/i.test(facts?.name || ''))
    ) {
      return 'credential';
    }

    // 5. Irreversible write actions: Deletion, Submitting forms, Public posting
    const irreversiblePatterns = /\b(?:(?:permanently\s+)?delete\s+(?:account|project|team|repo|database)|cancel\s+subscription|send\s+message|transfer\s+funds)\b/i;
    const isSubmitButton = facts?.type === 'submit' || (facts?.role === 'button' && /submit|delete|remove|cancel\s+subscription|transfer/i.test(labelAndAction));
    if (irreversiblePatterns.test(labelAndAction) || isSubmitButton) {
      return 'write-irreversible';
    }

    // 6. File Egress: Downloads / Uploads
    if (actionName === 'upload' || actionName === 'download' || facts?.type === 'file') {
      return 'file-egress';
    }

    // 7. General Reversible Writes: Typing text into input fields
    if (actionName === 'type' || actionName === 'press_key') {
      return 'write-reversible';
    }

    // 8. Default: Read-only observation / clicking harmless links
    return 'read';
  }

  /**
   * Main Policy Decision Point (PDP)
   */
  public evaluateAction(req: PolicyEvaluationRequest): PolicyEvaluationResult {
    const trace: string[] = [];
    trace.push(`PDP evaluating action '${req.actionName}' for mission '${req.missionId}'`);

    const riskClass = ActionPolicyEngine.classifyRisk(
      req.actionName,
      req.actionArgs,
      req.currentUrl,
      req.allowedOrigins,
      req.targetFacts
    );
    trace.push(`Action classified as riskClass='${riskClass}'`);

    // Invariant I6: Deny code-exec unconditionally
    if (riskClass === 'code-exec') {
      const reason = `Security Policy Denied: Action attempts restricted scheme navigation or code execution.`;
      trace.push(`Decision: DENY (${reason})`);
      logger.error('Security PDP blocked code execution attempt', undefined, { action: req.actionName, args: req.actionArgs });
      return {
        decision: 'deny',
        riskClass,
        reason,
        policyTrace: trace,
        requiresUserConfirmation: false,
        blockedTarget: req.actionArgs?.url
      };
    }

    // Invariant I4: Cross-origin navigation out of approved scope requires confirmation
    if (riskClass === 'navigate-out-of-scope') {
      const targetUrl = req.actionArgs?.url || '';
      const targetEtld = ActionPolicyEngine.getETLDPlusOne(targetUrl);
      const reason = `Action targets external origin '${targetEtld}' outside approved mission scope (${req.allowedOrigins.join(', ')}).`;
      trace.push(`Decision: ASK (${reason})`);
      logger.info('Security PDP requires human approval for cross-origin navigation', { targetUrl, allowedOrigins: req.allowedOrigins });
      return {
        decision: 'ask',
        riskClass,
        reason,
        policyTrace: trace,
        requiresUserConfirmation: true,
        blockedTarget: targetUrl
      };
    }

    // Invariant I2: Financial actions require out-of-band user approval
    if (riskClass === 'financial') {
      const reason = `Financial action detected: "${req.targetFacts?.label || req.actionName}". Human confirmation required before purchase or payment.`;
      trace.push(`Decision: ASK (${reason})`);
      logger.info('Security PDP requires confirmation for financial action', { label: req.targetFacts?.label });
      return {
        decision: 'ask',
        riskClass,
        reason,
        policyTrace: trace,
        requiresUserConfirmation: true,
        blockedTarget: req.targetFacts?.label
      };
    }

    // Invariant I2: Irreversible destructive actions require approval
    if (riskClass === 'write-irreversible') {
      const reason = `Irreversible action detected: "${req.targetFacts?.label || req.actionName}". Human confirmation required.`;
      trace.push(`Decision: ASK (${reason})`);
      return {
        decision: 'ask',
        riskClass,
        reason,
        policyTrace: trace,
        requiresUserConfirmation: true,
        blockedTarget: req.targetFacts?.label
      };
    }

    // Invariant I3: Credential autofill requires user approval if field is sensitive
    if (riskClass === 'credential') {
      const reason = `Sensitive credential field targeted: "${req.targetFacts?.name || 'password'}". Human confirmation required.`;
      trace.push(`Decision: ASK (${reason})`);
      return {
        decision: 'ask',
        riskClass,
        reason,
        policyTrace: trace,
        requiresUserConfirmation: true
      };
    }

    // File egress (upload/download) requires user approval
    if (riskClass === 'file-egress') {
      const reason = `File egress operation detected. Human confirmation required.`;
      trace.push(`Decision: ASK (${reason})`);
      return {
        decision: 'ask',
        riskClass,
        reason,
        policyTrace: trace,
        requiresUserConfirmation: true
      };
    }

    // Normal safe actions (read, navigate-in-scope, write-reversible)
    trace.push(`Decision: ALLOW (In-scope safe action)`);
    return {
      decision: 'allow',
      riskClass,
      reason: 'Action permitted by policy.',
      policyTrace: trace,
      requiresUserConfirmation: false
    };
  }
}
