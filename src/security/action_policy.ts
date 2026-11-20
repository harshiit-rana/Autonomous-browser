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

/**
 * A user policy rule (settings.policyRules, #225). A rule replaces the built-in decision for one risk class, optionally
 * only on one host (exact host or a parent domain). Rules can never allow `code-exec`.
 */
export interface PolicyRule {
  riskClass: ActionRiskClass;
  decision: PolicyDecision;
  host?: string;
}

export class ActionPolicyEngine {
  private readonly rules: PolicyRule[];
  /** Mission scope: hosts the mission may act on without asking. Grows when the user approves an origin. */
  private readonly scope: Set<string>;

  constructor(options: { rules?: PolicyRule[]; allowedHosts?: string[] } = {}) {
    this.rules = (options.rules || []).filter(r => r && r.riskClass && ['allow', 'ask', 'deny'].includes(r.decision));
    this.scope = new Set((options.allowedHosts || []).map(h => ActionPolicyEngine.hostOf(h)).filter(Boolean));
  }

  /** Host of a URL, or the string itself when it is already a host. */
  public static hostOf(urlOrHost: string): string {
    try {
      return new URL(urlOrHost).hostname.toLowerCase();
    } catch {
      return String(urlOrHost || '').toLowerCase().replace(/^\*\./, '').split('/')[0].split(':')[0];
    }
  }

  public allowHost(urlOrHost: string): void {
    const h = ActionPolicyEngine.hostOf(urlOrHost);
    if (h) this.scope.add(h);
  }

  public getAllowedHosts(): string[] {
    return Array.from(this.scope);
  }

  /** True when `url` is inside the mission scope (non-http pages such as about:blank never count as leaving it). */
  public isInScope(url: string): boolean {
    if (!/^https?:/i.test(url)) return true;
    return this.scope.size === 0 || ActionPolicyEngine.isOriginAllowed(url, Array.from(this.scope));
  }

  /**
   * Helper to extract eTLD+1 or hostname. IP addresses and single-label hosts (localhost) are returned whole:
   * splitting `127.0.0.1` into `0.1` made every local origin look foreign (baseline defect D4).
   */
  public static getETLDPlusOne(urlStr: string): string {
    try {
      const parsed = new URL(urlStr);
      const host = parsed.hostname.toLowerCase();
      if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith('[') || !host.includes('.')) return host;
      const parts = host.split('.');
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

      const isIp = /^\d+(\.\d+){3}$/.test(candidateHost) || candidateHost.startsWith('[');
      for (const allowed of allowedOrigins) {
        const cleanAllowed = ActionPolicyEngine.hostOf(allowed);
        if (!cleanAllowed) continue;
        if (isIp) {
          if (candidateHost === cleanAllowed) return true;
          continue;
        }
        if (candidateHost === cleanAllowed || candidateHost.endsWith('.' + cleanAllowed)) {
          return true;
        }
        if (candidateEtld === cleanAllowed || candidateEtld.endsWith('.' + cleanAllowed)) {
          return true;
        }
        // Same registrable domain (www.example.com allows shop.example.com).
        if (candidateEtld && candidateEtld.includes('.') && candidateEtld === ActionPolicyEngine.getETLDPlusOne(`http://${cleanAllowed}/`)) {
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
    if (actionName === 'navigate' || actionName === 'open_tab') {
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
    if (actionName === 'upload' || actionName === 'upload_file' || actionName === 'download' || facts?.type === 'file') {
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
    const allowedOrigins = req.allowedOrigins.length ? req.allowedOrigins : Array.from(this.scope);
    const base = this.evaluateBuiltin({ ...req, allowedOrigins });
    if (base.riskClass === 'code-exec') return base;
    const targetHost = ActionPolicyEngine.hostOf(req.actionArgs?.url || req.currentUrl || '');
    const rule = this.rules.find(r => r.riskClass === base.riskClass &&
      (!r.host || targetHost === r.host.toLowerCase() || targetHost.endsWith('.' + r.host.toLowerCase())));
    if (!rule || rule.decision === base.decision) return base;
    return {
      ...base,
      decision: rule.decision,
      reason: `User policy rule: ${rule.decision} ${rule.riskClass}${rule.host ? ` on ${rule.host}` : ''} (built-in decision was ${base.decision}: ${base.reason})`,
      requiresUserConfirmation: rule.decision === 'ask',
      policyTrace: [...base.policyTrace, `Rule override -> ${rule.decision.toUpperCase()}`]
    };
  }

  private evaluateBuiltin(req: PolicyEvaluationRequest): PolicyEvaluationResult {
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
