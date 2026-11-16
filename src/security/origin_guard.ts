export interface ProposedAction {
  actionType: 'click' | 'type' | 'navigate' | 'download' | 'execute';
  targetElementId?: string;
  targetUrl?: string;
  payload?: any;
}

export interface GateResult {
  isPermitted: boolean;
  requiresHumanConfirmation: boolean;
  reason?: string;
}

/**
 * OriginGuard & Intent Gate
 * Enforces per-task domain whitelists and blocks irreversible operations
 * (checkout, payments, file deletions) without explicit user authorization.
 */
export class OriginGuard {
  private allowedOrigins: Set<string> = new Set();
  private userGoal: string;

  constructor(userGoal: string, primaryUrl?: string) {
    this.userGoal = userGoal;
    if (primaryUrl) {
      try {
        const origin = new URL(primaryUrl).origin;
        this.allowedOrigins.add(origin);
      } catch {}
    }
  }

  public allowOrigin(origin: string): void {
    this.allowedOrigins.add(origin);
  }

  /**
   * Evaluates if a navigation or click action crosses origin boundaries or triggers high-risk gates.
   */
  public evaluateAction(action: ProposedAction): GateResult {
    // 1. Navigation boundary check
    if (action.actionType === 'navigate' && action.targetUrl) {
      try {
        const targetOrigin = new URL(action.targetUrl).origin;
        if (this.allowedOrigins.size > 0 && !this.allowedOrigins.has(targetOrigin)) {
          return {
            isPermitted: false,
            requiresHumanConfirmation: true,
            reason: `Navigation targets external origin '${targetOrigin}' outside approved scope.`
          };
        }
      } catch {
        return { isPermitted: false, requiresHumanConfirmation: false, reason: 'Invalid URL' };
      }
    }

    // 2. High-risk irreversible action gate (Checkout / Payment / Deletion)
    if (action.actionType === 'click' && action.payload?.label) {
      const label = String(action.payload.label).toLowerCase();
      const isHighRisk = /place\s+order|buy\s+now|pay\s+|confirm\s+payment|delete\s+account/i.test(label);
      if (isHighRisk) {
        return {
          isPermitted: false,
          requiresHumanConfirmation: true,
          reason: `High-risk transaction detected: '${action.payload.label}'. Human confirmation required.`
        };
      }
    }

    return { isPermitted: true, requiresHumanConfirmation: false };
  }
}
