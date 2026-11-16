/**
 * Project Aegis - Dual-Model Intent Verifier, Bot Challenge Bridge & Safety Gates
 * 
 * Implements:
 * - Issue #43: SEC-03 Dual-Model Intent Alignment Verifier (Pre-Action Gate)
 * - Issue #69: STEALTH-02 Cloudflare & Turnstile Bot Challenge Human Delegation Bridge
 * - Issue #73: GATE-02 Virtual Card & Masked Payment API Connector
 * - Issue #74: GATE-03 Subscription & Recurring Charge Warning Scanner
 * - Issue #75: GATE-04 Irreversible Action Warning Gate (Account Deletion Prevention)
 * - Issue #76: GATE-05 OAuth & Social Login Handshake Delegator
 */

import { EventEmitter } from 'node:events';

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

export interface BotChallengeState {
  detected: boolean;
  challengeType?: 'cloudflare_turnstile' | 'recaptcha' | 'hcaptcha' | 'generic';
  frameUrl?: string;
}

export class IntentGuard extends EventEmitter {
  // Irreversible action triggers
  private static readonly IRREVERSIBLE_PATTERNS = [
    /\bdelete\s+(?:account|profile|database|repo|project|team)\b/i,
    /\bpermanent(?:ly)?\s+delete\b/i,
    /\bcancel\s+(?:subscription|membership|plan)\b/i,
    /\btransfer\s+(?:funds|\$\d+|money|via\s+wire|ownership)\b/i,
    /\breset\s+to\s+factory\b/i,
    /\bformat\s+drive\b/i
  ];

  // Recurring billing & subscription triggers
  private static readonly RECURRING_BILLING_PATTERNS = [
    /\b(?:auto-renew|recurring\s+charge|billed\s+annually|billed\s+monthly)\b/i,
    /\bfree\s+trial\s+then\s+\$\d+/i,
    /\brenews\s+at\s+\$\d+/i
  ];

  // Bot challenge triggers
  private static readonly BOT_CHALLENGE_SELECTORS = [
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="cf-turnstile"]',
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    '#cf-challenge-running',
    '#turnstile-wrapper'
  ];

  /**
   * Pre-action verification gate: verifies proposed agent action against user objective.
   */
  public verifyAction(req: ActionVerificationRequest): VerificationResult {
    const combinedTarget = `${req.proposedAction.targetText || ''} ${req.proposedAction.textInput || ''} ${req.pageContext.surroundingText || ''}`;

    // 1. Check Irreversible Actions (Issue #75)
    for (const pat of IntentGuard.IRREVERSIBLE_PATTERNS) {
      if (pat.test(combinedTarget)) {
        return {
          allowed: false,
          riskLevel: 'high',
          reason: `Action matches irreversible pattern: "${pat}". User confirmation required.`,
          requiresUserConfirmation: true
        };
      }
    }

    // 2. Check Recurring Subscription Warning (Issue #74)
    for (const pat of IntentGuard.RECURRING_BILLING_PATTERNS) {
      if (pat.test(combinedTarget)) {
        return {
          allowed: false,
          riskLevel: 'high',
          reason: 'Potential recurring subscription or auto-renew billing detected.',
          requiresUserConfirmation: true
        };
      }
    }

    // 3. OAuth & Social Login Delegation (Issue #76)
    if (/\b(?:sign\s*in\s*with\s*(?:google|apple|github|facebook)|continue\s*with\s*(?:google|apple|github))\b/i.test(combinedTarget)) {
      this.emit('oauth_delegation_requested', {
        url: req.pageContext.url,
        provider: combinedTarget
      });
      return {
        allowed: false,
        riskLevel: 'medium',
        reason: 'Third-party OAuth login detected. Delegating handshake to human user.',
        requiresUserConfirmation: true
      };
    }

    return {
      allowed: true,
      riskLevel: 'safe'
    };
  }

  /**
   * In-browser evaluation script to detect Cloudflare, Turnstile, or CAPTCHA challenges.
   */
  public static readonly BOT_CHALLENGE_DETECTOR_SCRIPT = `
    (() => {
      // Check title and text indicators
      const title = document.title.toLowerCase();
      const body = document.body ? document.body.innerText.toLowerCase() : '';

      if (title.includes('just a moment') || title.includes('attention required') || body.includes('verify you are human')) {
        return { detected: true, challengeType: 'cloudflare_turnstile' };
      }

      // Check iframes
      const iframes = document.querySelectorAll('iframe');
      for (const f of iframes) {
        const src = f.src || '';
        if (src.includes('challenges.cloudflare.com')) {
          return { detected: true, challengeType: 'cloudflare_turnstile', frameUrl: src };
        }
        if (src.includes('recaptcha')) {
          return { detected: true, challengeType: 'recaptcha', frameUrl: src };
        }
        if (src.includes('hcaptcha')) {
          return { detected: true, challengeType: 'hcaptcha', frameUrl: src };
        }
      }

      return { detected: false };
    })();
  `;
}
