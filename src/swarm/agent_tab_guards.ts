/**
 * Project Aegis - Navigation and permission guards for agent (worker) tabs.
 *
 * Issue #229 [SWX-03]. The same deny-by-default posture the chrome window gets in main/index.ts:
 *   - every permission request and permission check is denied (camera, microphone, geolocation, notifications, ...)
 *   - only http(s) pages (and about:blank) may be navigated to; file:, chrome:, devtools:, view-source:, data:,
 *     javascript: and every custom protocol are refused, both for programmatic loads and for page-initiated
 *     navigations, redirects and sub-frame navigations
 *   - popups are denied (the worker keeps working in its own tab; nothing opens behind the agent's back)
 *   - downloads are cancelled (routing them to the mission folder belongs to #252)
 *
 * `loadURL()` does not raise `will-navigate`, so callers must run URLs through `checkAgentUrl` themselves.
 */

import type { Session, WebContents } from 'electron';
import { logger } from '../infrastructure/logger.js';

export interface UrlCheck {
  allowed: boolean;
  /** Normalised absolute URL when allowed. */
  url?: string;
  reason?: string;
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
// Anything that looks like "<scheme>:" but is not "host:port".
const EXPLICIT_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d+(\/|$))/i;

/** Validates an absolute URL that the page or the engine wants to navigate to. */
export function checkAgentUrl(raw: string): UrlCheck {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { allowed: false, reason: `not a valid absolute URL: ${raw.slice(0, 120)}` };
  }
  if (raw === 'about:blank') return { allowed: true, url: 'about:blank' };
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { allowed: false, reason: `scheme "${parsed.protocol}" is not allowed in agent tabs` };
  }
  if (!parsed.hostname) return { allowed: false, reason: 'URL has no host' };
  return { allowed: true, url: parsed.toString() };
}

/**
 * Turns user/model text into a navigable URL. A bare host ("example.com", "localhost:8080") gets https://;
 * anything with an explicit non-http(s) scheme is refused instead of being silently rewritten.
 */
export function normaliseAgentNavigationTarget(input: string): UrlCheck {
  const trimmed = (input || '').trim();
  if (!trimmed) return { allowed: false, reason: 'empty URL' };
  if (EXPLICIT_SCHEME.test(trimmed)) return checkAgentUrl(trimmed);
  return checkAgentUrl('https://' + trimmed.replace(/^\/+/, ''));
}

export interface AgentGuardHooks {
  workerId: string;
  onPopupDenied?: (url: string) => void;
  onNavigationBlocked?: (url: string, reason: string) => void;
  onDownloadCancelled?: (fileName: string) => void;
  onPermissionDenied?: (permission: string) => void;
}

/** Per-session handlers are installed once; sessions shared by several workers (agent profiles) keep one set. */
const guardedSessions = new WeakSet<Session>();

/**
 * Installs guards on a worker's WebContents (and, when `guardSession` is true, on its Session).
 * Returns a disposer that removes every listener it added so teardown leaves nothing behind.
 * The shared default session is never touched (guardSession=false): it belongs to the user.
 */
export function applyAgentTabGuards(wc: WebContents, hooks: AgentGuardHooks, guardSession: boolean): () => void {
  const disposers: Array<() => void> = [];
  const { workerId } = hooks;

  wc.setWindowOpenHandler((details) => {
    logger.warn('Popup denied in agent tab', { workerId, url: details.url });
    hooks.onPopupDenied?.(details.url);
    return { action: 'deny' };
  });
  disposers.push(() => {
    try { wc.setWindowOpenHandler(() => ({ action: 'deny' })); } catch { /* destroyed */ }
  });

  const guardNavigation = (event: { preventDefault: () => void }, url: string) => {
    const verdict = checkAgentUrl(url);
    if (!verdict.allowed) {
      event.preventDefault();
      logger.warn('Blocked navigation in agent tab', { workerId, url: url.slice(0, 200), reason: verdict.reason });
      hooks.onNavigationBlocked?.(url, verdict.reason || 'blocked');
    }
  };
  const navEvents = ['will-navigate', 'will-redirect', 'will-frame-navigate'] as const;
  for (const name of navEvents) {
    const handler = (event: any, ...rest: any[]) => {
      // Electron 33 puts `url` on the event; older/legacy signatures pass it as the second argument.
      const url = event && typeof event.url === 'string' ? event.url : (typeof rest[0] === 'string' ? rest[0] : '');
      if (url) guardNavigation(event, url);
    };
    (wc as any).on(name, handler);
    disposers.push(() => { try { (wc as any).removeListener(name, handler); } catch { /* destroyed */ } });
  }

  if (guardSession) {
    const sess = wc.session;
    if (!guardedSessions.has(sess)) {
      guardedSessions.add(sess);
      sess.setPermissionRequestHandler((_wc, permission, callback) => {
        logger.warn('Worker permission request denied', { workerId, permission });
        hooks.onPermissionDenied?.(permission);
        callback(false);
      });
      sess.setPermissionCheckHandler(() => false);
      sess.on('will-download', (event, item) => {
        const fileName = item.getFilename();
        logger.warn('Worker download cancelled (routing to the mission folder is #252)', { workerId, fileName });
        hooks.onDownloadCancelled?.(fileName);
        event.preventDefault();
        item.cancel();
      });
    }
  }

  return () => { for (const d of disposers.reverse()) d(); };
}
