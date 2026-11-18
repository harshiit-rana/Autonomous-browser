/**
 * Project Aegis - Bot Challenge Detection & Honest Browser Identity
 * 
 * Implements Issue #162 [SEC-07]:
 * - Honest, coherent browser identity derived from real Electron environment
 * - Structured detection of Cloudflare Turnstile, reCAPTCHA, hCaptcha, Arkose, and DataDome
 * - Clean human delegation: pause worker, alert user in trusted UI, resume on challenge clearance
 * - Ethical stance: no arms-race evasion, no illegal CAPTCHA solving farms
 */

import { EventEmitter } from 'node:events';
import { logger } from '../infrastructure/logger.js';

export type ChallengeProvider =
  | 'cloudflare_turnstile'
  | 'recaptcha'
  | 'hcaptcha'
  | 'arkose'
  | 'datadome'
  | 'generic_waf';

export interface ChallengeDetectionResult {
  detected: boolean;
  provider?: ChallengeProvider;
  message?: string;
  frameUrl?: string;
}

export class BotChallengeBridge extends EventEmitter {
  /**
   * Scans DOM state, title, and iframe URLs for active anti-automation challenges
   */
  public static detectChallenge(pageTitle: string, pageText: string, iframeUrls: string[] = []): ChallengeDetectionResult {
    const lowerTitle = pageTitle.toLowerCase();
    const lowerText = pageText.toLowerCase();

    // 1. Cloudflare Turnstile / Managed Challenge
    if (
      lowerTitle.includes('just a moment...') ||
      lowerText.includes('checking your browser') ||
      lowerText.includes('verify you are human') ||
      iframeUrls.some(u => u.includes('challenges.cloudflare.com') || u.includes('cf-turnstile'))
    ) {
      return {
        detected: true,
        provider: 'cloudflare_turnstile',
        message: 'Cloudflare Turnstile challenge detected. Please solve in browser tab to continue.'
      };
    }

    // 2. Google reCAPTCHA
    if (
      lowerText.includes('recaptcha') ||
      iframeUrls.some(u => u.includes('google.com/recaptcha') || u.includes('recaptcha.net'))
    ) {
      return {
        detected: true,
        provider: 'recaptcha',
        message: 'Google reCAPTCHA challenge detected. Human verification required.'
      };
    }

    // 3. hCaptcha
    if (
      lowerText.includes('hcaptcha') ||
      iframeUrls.some(u => u.includes('hcaptcha.com'))
    ) {
      return {
        detected: true,
        provider: 'hcaptcha',
        message: 'hCaptcha challenge detected. Human verification required.'
      };
    }

    // 4. Arkose Labs / FunCaptcha
    if (
      lowerText.includes('arkose') ||
      iframeUrls.some(u => u.includes('arkoselabs.com') || u.includes('funcaptcha'))
    ) {
      return {
        detected: true,
        provider: 'arkose',
        message: 'Arkose verification challenge detected.'
      };
    }

    // 5. DataDome / PerimeterX WAF block
    if (
      lowerTitle.includes('access denied') ||
      lowerText.includes('datadome') ||
      lowerText.includes('perimeterx') ||
      lowerText.includes('unusual traffic from your computer network')
    ) {
      return {
        detected: true,
        provider: 'generic_waf',
        message: 'WAF anti-bot block page detected. Handing off to human operator.'
      };
    }

    return { detected: false };
  }

  /**
   * Handles challenge detection by pausing worker and alerting human
   */
  public handleChallenge(workerId: string, detection: ChallengeDetectionResult): void {
    logger.warn('Anti-bot challenge detected! Triggering human handoff.', {
      workerId,
      provider: detection.provider,
      message: detection.message
    });

    this.emit('challengeDetected', {
      workerId,
      provider: detection.provider,
      message: detection.message,
      actionRequired: 'human_solve'
    });
  }

  /**
   * Signals that human solved the challenge and page settled
   */
  public resolveChallenge(workerId: string): void {
    logger.info('Bot challenge cleared. Resuming worker execution.', { workerId });
    this.emit('challengeResolved', { workerId });
  }
}
