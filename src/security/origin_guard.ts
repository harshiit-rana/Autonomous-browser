/**
 * Re-export ActionPolicyEngine as OriginGuard for backward compatibility
 */
import { ActionPolicyEngine, PolicyEvaluationRequest } from './action_policy.js';

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

export class OriginGuard {
  private engine = new ActionPolicyEngine();
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

  public evaluateAction(action: ProposedAction): GateResult {
    const evalResult = this.engine.evaluateAction({
      missionId: 'legacy',
      userGoal: this.userGoal,
      allowedOrigins: Array.from(this.allowedOrigins),
      currentUrl: action.targetUrl || '',
      actionName: action.actionType,
      actionArgs: { url: action.targetUrl, text: action.payload?.text },
      targetFacts: {
        label: action.payload?.label,
        type: action.payload?.type
      }
    });

    return {
      isPermitted: evalResult.decision === 'allow',
      requiresHumanConfirmation: evalResult.requiresUserConfirmation,
      reason: evalResult.reason
    };
  }
}
