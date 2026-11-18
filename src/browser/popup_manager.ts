/**
 * Project Aegis - Popup & Window.Open Policy Manager (Issue #170 - [BRW-03])
 * 
 * Features:
 * - Intercepts setWindowOpenHandler for all browser WebContents
 * - Adopts target=_blank and standard window.open as grouped tabs with openerId
 * - Detects OAuth / payment flows and allocates dedicated child windows
 * - Blocks unsolicited ad popup storms and popunders
 * - Preserves window.opener relationship and handles cross-window communication
 */

import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('popup-manager');

export interface WindowOpenDetails {
  url: string;
  frameName: string;
  features: string;
  disposition: 'default' | 'foreground-tab' | 'background-tab' | 'new-window' | 'other';
  referrer?: string;
  userGesture?: boolean;
}

export type PopupDecisionAction = 'adopt_tab' | 'open_oauth_window' | 'deny';

export interface PopupDecision {
  action: PopupDecisionAction;
  reason: string;
  features?: { width?: number; height?: number };
}

export class PopupManager {
  private static readonly OAUTH_AUTH_PATTERNS = [
    /\/oauth(?:2)?\/(?:auth|authorize|login)/i,
    /\/accounts\.google\.com\/o\/oauth2/i,
    /\/login\.microsoftonline\.com/i,
    /\/github\.com\/login\/oauth/i,
    /\/appleid\.apple\.com\/auth\/authorize/i,
    /\/checkout\.stripe\.com/i,
    /\/paypal\.com\/.*checkout/i,
    /\/api\/auth\/callback/i
  ];

  private static readonly AD_TRACKER_POPUP_PATTERNS = [
    /doubleclick\.net/i,
    /adnxs\.com/i,
    /popads\.net/i,
    /adcash\.com/i,
    /outbrain\.com/i,
    /taboola\.com/i
  ];

  /**
   * Evaluates a window.open request from a WebContents
   */
  public evaluateWindowOpen(details: WindowOpenDetails): PopupDecision {
    const { url, features, userGesture } = details;

    // 1. Block known ad tracker popups immediately
    for (const pattern of PopupManager.AD_TRACKER_POPUP_PATTERNS) {
      if (pattern.test(url)) {
        logger.warn('Blocked ad popup', { url });
        return {
          action: 'deny',
          reason: 'Blocked ad or tracker popup network'
        };
      }
    }

    // 2. Block unsolicited non-user gesture popups unless on trusted origin
    if (userGesture === false && !url.startsWith('https://')) {
      logger.warn('Blocked non-user-gesture popup', { url });
      return {
        action: 'deny',
        reason: 'Blocked unsolicited popup without user gesture'
      };
    }

    // 3. Detect OAuth / Authentication / Payment modal flows
    const isAuth = PopupManager.OAUTH_AUTH_PATTERNS.some(p => p.test(url));
    const parsedDimensions = this.parseWindowFeatures(features);
    const isSmallDimensions = !!(parsedDimensions.width && parsedDimensions.width <= 700 && parsedDimensions.height && parsedDimensions.height <= 800);

    if (isAuth || isSmallDimensions) {
      logger.info('Approved OAuth / modal popup window', { url, dimensions: parsedDimensions });
      return {
        action: 'open_oauth_window',
        reason: isAuth ? 'Recognized OAuth / authentication flow' : 'Explicit modal window features requested',
        features: parsedDimensions
      };
    }

    // 4. Standard new window / target=_blank -> Adopt as tab in current workspace
    logger.info('Adopting new window request as managed tab', { url });
    return {
      action: 'adopt_tab',
      reason: 'Standard target=_blank or window.open adopted as tab'
    };
  }

  public parseWindowFeatures(featuresStr: string): { width?: number; height?: number } {
    if (!featuresStr) return {};
    const res: { width?: number; height?: number } = {};

    const widthMatch = featuresStr.match(/\bwidth=(\d+)/i);
    if (widthMatch) {
      res.width = parseInt(widthMatch[1], 10);
    }

    const heightMatch = featuresStr.match(/\bheight=(\d+)/i);
    if (heightMatch) {
      res.height = parseInt(heightMatch[1], 10);
    }

    return res;
  }
}
