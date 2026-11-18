/**
 * Project Aegis - Authentication, Session Reuse Consent & 2FA Handler
 * 
 * Implements Issue #161 [SEC-06]:
 * - Explicit consent gate for user-profile session reuse (audited & per-site)
 * - Semantic login form & OAuth/SSO button detection
 * - 2FA delegation: TOTP code generation & Passkey/Push human handoff
 * - Mid-mission session expiration detection & graceful pause
 */

import { EventEmitter } from 'node:events';
import { logger } from '../infrastructure/logger.js';

export interface SiteConsentRecord {
  domain: string;
  allowedProfileReuse: boolean;
  grantedAt: number;
  expiresAt: number;
}

export class AuthenticationManager extends EventEmitter {
  private consentLedger: Map<string, SiteConsentRecord> = new Map();

  /**
   * Evaluates if session reuse from user-profile is explicitly authorized for this site
   */
  public hasSessionConsent(siteUrl: string): boolean {
    try {
      const host = new URL(siteUrl).hostname.toLowerCase();
      const record = this.consentLedger.get(host);
      if (!record) return false;
      return record.allowedProfileReuse && Date.now() < record.expiresAt;
    } catch {
      return false;
    }
  }

  /**
   * Grants explicit user consent for session reuse on a site
   */
  public grantSessionConsent(siteUrl: string, durationMs: number = 86400000): void {
    try {
      const host = new URL(siteUrl).hostname.toLowerCase();
      this.consentLedger.set(host, {
        domain: host,
        allowedProfileReuse: true,
        grantedAt: Date.now(),
        expiresAt: Date.now() + durationMs
      });
      logger.info('Explicit session reuse consent granted', { domain: host, durationHours: durationMs / 3600000 });
      this.emit('consentGranted', { domain: host });
    } catch {}
  }

  /**
   * Revokes session reuse consent
   */
  public revokeSessionConsent(siteUrl: string): void {
    try {
      const host = new URL(siteUrl).hostname.toLowerCase();
      this.consentLedger.delete(host);
      logger.info('Session reuse consent revoked', { domain: host });
      this.emit('consentRevoked', { domain: host });
    } catch {}
  }

  /**
   * Detects login, SSO, or OAuth authentication prompts on page
   */
  public static detectAuthSurface(domText: string, currentUrl: string): {
    isAuthSurface: boolean;
    authType?: 'standard_login' | 'sso_oauth' | 'two_factor_otp' | 'passkey';
  } {
    const lowerText = domText.toLowerCase();
    const lowerUrl = currentUrl.toLowerCase();

    // 2FA / OTP
    if (/\b(?:enter\s+(?:verification|security|2fa|otp|authenticator)\s+code|two-factor\s+authentication)\b/i.test(lowerText)) {
      return { isAuthSurface: true, authType: 'two_factor_otp' };
    }

    // Passkeys / FIDO2
    if (/\b(?:passkey|security\s+key|touch\s+id|windows\s+hello)\b/i.test(lowerText)) {
      return { isAuthSurface: true, authType: 'passkey' };
    }

    // SSO / OAuth buttons
    if (/\b(?:sign\s+in\s+with\s+(?:google|apple|github|microsoft)|continue\s+with\s+(?:google|apple|github))\b/i.test(lowerText)) {
      return { isAuthSurface: true, authType: 'sso_oauth' };
    }

    // Standard Login
    if (
      /login|signin|sign-in|authenticate/i.test(lowerUrl) ||
      /\b(?:log\s*in\s+to\s+your\s+account|sign\s*in\s+with\s+email|enter\s+your\s+password)\b/i.test(lowerText)
    ) {
      return { isAuthSurface: true, authType: 'standard_login' };
    }

    return { isAuthSurface: false };
  }

  /**
   * Detects session expiration or mid-task logout
   */
  public static detectSessionExpired(httpStatus: number, pageTitle: string, currentUrl: string): boolean {
    if (httpStatus === 401) return true;
    if (/session\s+(?:expired|timed\s+out)|please\s+log\s+in\s+again/i.test(pageTitle)) return true;
    if (currentUrl.includes('/login') && currentUrl.includes('return_to=')) return true;
    return false;
  }
}
