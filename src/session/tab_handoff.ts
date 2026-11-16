/**
 * Project Aegis - Headless State Handoff (Background-to-Foreground Promotion)
 * 
 * Implements:
 * - Issue #62: SESSION-02 Headless State Handoff (Background-to-Foreground Promotion)
 */

import { WebContents } from 'electron';
import { WebStateSnapshotter, WebStateSnapshot } from '../planning/state_snapshotter.js';

export interface HandoffPayload {
  sourceWorkerId: string;
  targetUrl: string;
  snapshot: WebStateSnapshot;
  reason: 'user_takeover' | 'captcha_gate' | 'checkout_flow' | 'completion';
}

export class TabHandoffManager {
  /**
   * Captures background worker tab state and prepares a handoff bundle.
   */
  public static async prepareHandoff(
    workerWebContents: WebContents,
    workerId: string,
    reason: HandoffPayload['reason'] = 'user_takeover'
  ): Promise<HandoffPayload> {
    const snapshot = await WebStateSnapshotter.captureSnapshot(workerWebContents, true);

    return {
      sourceWorkerId: workerId,
      targetUrl: workerWebContents.getURL(),
      snapshot,
      reason
    };
  }

  /**
   * Promotes the background state into the foreground visible WebContents tab.
   */
  public static async executeHandoff(
    foregroundWebContents: WebContents,
    payload: HandoffPayload
  ): Promise<boolean> {
    if (foregroundWebContents.isDestroyed()) return false;

    // Load the target URL
    await foregroundWebContents.loadURL(payload.targetUrl);

    // Restore the full state snapshot
    await WebStateSnapshotter.restoreSnapshot(foregroundWebContents, payload.snapshot);

    return true;
  }
}
