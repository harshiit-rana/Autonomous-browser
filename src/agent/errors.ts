/**
 * Project Aegis - Agent Error Taxonomy and Recovery Policies
 * Implements: Issue #125 [AGT-11]
 */

export type ErrorClassification =
  | 'STALE_REF'
  | 'NAV_FAILURE'
  | 'AUTH_WALL'
  | 'CAPTCHA'
  | 'RENDERER_CRASH'
  | 'NOOP_ACTION'
  | 'MODEL_ERROR'
  | 'TIMEOUT'
  | 'UNKNOWN';

export interface ActionErrorInfo {
  code: ErrorClassification;
  message: string;
  retryable: boolean;
  suggestedRecovery: string;
  requiresHumanHandoff?: boolean;
}

export class ActionTaxonomy {
  public static classify(error: any): ActionErrorInfo {
    const msg = String(error?.message || error || '').toLowerCase();

    if (msg.includes('stale_ref') || msg.includes('not found in current snapshot')) {
      return {
        code: 'STALE_REF',
        message: 'Element reference is stale or no longer present in DOM.',
        retryable: true,
        suggestedRecovery: 'Re-examine the latest page snapshot for updated element refs.'
      };
    }

    if (msg.includes('net::err') || msg.includes('failed to load') || msg.includes('navigation error')) {
      return {
        code: 'NAV_FAILURE',
        message: 'Network navigation failure.',
        retryable: true,
        suggestedRecovery: 'Check the URL format or verify site connectivity.'
      };
    }

    if (msg.includes('captcha') || msg.includes('cloudflare') || msg.includes('bot detection') || msg.includes('verify you are human')) {
      return {
        code: 'CAPTCHA',
        message: 'Encountered bot detection or CAPTCHA challenge.',
        retryable: false,
        requiresHumanHandoff: true,
        suggestedRecovery: 'Human intervention required. Please solve the challenge and click Hand Back.'
      };
    }

    if (msg.includes('login') || msg.includes('sign in') || msg.includes('auth wall') || msg.includes('unauthorized')) {
      return {
        code: 'AUTH_WALL',
        message: 'Encountered authentication wall.',
        retryable: false,
        requiresHumanHandoff: true,
        suggestedRecovery: 'Please sign in to the site in the active tab and click Hand Back.'
      };
    }

    if (msg.includes('crashed') || msg.includes('render process gone')) {
      return {
        code: 'RENDERER_CRASH',
        message: 'Chromium renderer process crashed.',
        retryable: true,
        suggestedRecovery: 'Reload the tab or restore state from the latest mission checkpoint.'
      };
    }

    if (msg.includes('rate limit') || msg.includes('429') || msg.includes('quota')) {
      return {
        code: 'MODEL_ERROR',
        message: 'Model provider quota exceeded or rate limited.',
        retryable: true,
        suggestedRecovery: 'Retry after exponential backoff or switch to an alternate model.'
      };
    }

    return {
      code: 'UNKNOWN',
      message: error?.message || String(error),
      retryable: false,
      suggestedRecovery: 'Review agent diagnostics and timeline logs.'
    };
  }

  public static detectPageRoadblocks(title: string, url: string, contentSnippet: string = ''): ActionErrorInfo | null {
    const combined = `${title} ${url} ${contentSnippet}`.toLowerCase();

    if (/captcha|are you a human|verify you are human|turnstile|cf-challenge/i.test(combined)) {
      return {
        code: 'CAPTCHA',
        message: `Detected CAPTCHA challenge on "${title}" (${url})`,
        retryable: false,
        requiresHumanHandoff: true,
        suggestedRecovery: 'Please complete the verification in the browser tab and click Hand Back.'
      };
    }

    if (/sign in to continue|login required|enter your password|two-factor authentication/i.test(combined)) {
      return {
        code: 'AUTH_WALL',
        message: `Authentication wall encountered on "${title}"`,
        retryable: false,
        requiresHumanHandoff: true,
        suggestedRecovery: 'Please complete login manually and click Hand Back.'
      };
    }

    return null;
  }
}
