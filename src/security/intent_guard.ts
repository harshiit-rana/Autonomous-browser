/**
 * Re-export ActionPolicyEngine as IntentGuard for backward compatibility
 */
import { ActionPolicyEngine } from './action_policy.js';

export interface ActionVerificationRequest {
  userObjective: string;
  proposedAction: {
    type: 'click' | 'type' | 'navigate' | 'submit' | 'download';
    targetText?: string;
    url?: string;
    textInput?: string;
  };
  pageContext: {
    url: string;
    title: string;
    surroundingText?: string;
  };
}

export interface VerificationResult {
  allowed: boolean;
  riskLevel: 'safe' | 'medium' | 'high' | 'blocked';
  reason?: string;
  requiresUserConfirmation?: boolean;
}

export class IntentGuard {
  private engine = new ActionPolicyEngine();

  public verifyAction(req: ActionVerificationRequest): VerificationResult {
    const res = this.engine.evaluateAction({
      missionId: 'verification',
      userGoal: req.userObjective,
      allowedOrigins: [],
      currentUrl: req.pageContext.url,
      actionName: req.proposedAction.type,
      actionArgs: { url: req.proposedAction.url, text: req.proposedAction.textInput },
      targetFacts: {
        label: req.proposedAction.targetText,
        value: req.proposedAction.textInput
      }
    });

    const riskMap: Record<string, 'safe' | 'medium' | 'high' | 'blocked'> = {
      allow: 'safe',
      ask: 'high',
      deny: 'blocked'
    };

    return {
      allowed: res.decision === 'allow',
      riskLevel: riskMap[res.decision] || 'medium',
      reason: res.reason,
      requiresUserConfirmation: res.requiresUserConfirmation
    };
  }
}
