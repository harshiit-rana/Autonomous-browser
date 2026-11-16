/**
 * Project Aegis - Real-Time DOM Mutation Observer & Visual Settle Detector
 * 
 * Implements:
 * - Issue #28: PERC-03 Real-Time DOM Mutation Observer & Visual Settle Detector
 */

import { WebContents } from 'electron';

export interface SettleOptions {
  timeoutMs?: number; // Max time to wait before proceeding anyway (default: 3000ms)
  quietWindowMs?: number; // Window with zero mutations required (default: 150ms)
  checkAnimations?: boolean; // Wait for active CSS transitions to finish (default: true)
}

export class VisualSettleDetector {
  /**
   * Script evaluated in-browser that resolves when DOM mutations and CSS animations settle.
   */
  public static getSettleScript(quietWindowMs = 150, timeoutMs = 3000, checkAnimations = true): string {
    return `
      new Promise((resolve) => {
        const timeoutAt = Date.now() + ${timeoutMs};
        let lastMutationTime = Date.now();
        let observer = null;
        let timer = null;

        function check() {
          const now = Date.now();
          if (now >= timeoutAt) {
            cleanup();
            resolve({ settled: true, reason: 'timeout_reached', waitedMs: ${timeoutMs} });
            return;
          }

          const quietTime = now - lastMutationTime;

          // Check running CSS animations
          let hasRunningAnimations = false;
          if (${checkAnimations} && document.getAnimations) {
            const anims = document.getAnimations();
            for (const a of anims) {
              if (a.playState === 'running') {
                hasRunningAnimations = true;
                break;
              }
            }
          }

          if (quietTime >= ${quietWindowMs} && !hasRunningAnimations) {
            cleanup();
            resolve({ settled: true, reason: 'quiescence_achieved', quietMs: quietTime });
            return;
          }

          timer = setTimeout(check, 30);
        }

        function onMutation() {
          lastMutationTime = Date.now();
        }

        try {
          observer = new MutationObserver(onMutation);
          observer.observe(document.documentElement || document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true
          });
        } catch (e) {
          // If observer fails, resolve immediately
          resolve({ settled: true, reason: 'observer_unsupported' });
          return;
        }

        function cleanup() {
          if (observer) observer.disconnect();
          if (timer) clearTimeout(timer);
        }

        // Start polling
        timer = setTimeout(check, 30);
      });
    `;
  }

  /**
   * Waits for the given WebContents page to achieve visual and DOM quiescence.
   */
  public static async waitForPageSettle(webContents: WebContents, options: SettleOptions = {}): Promise<boolean> {
    if (webContents.isDestroyed()) return false;
    const timeout = options.timeoutMs ?? 3000;
    const quiet = options.quietWindowMs ?? 150;
    const checkAnim = options.checkAnimations !== false;

    const script = VisualSettleDetector.getSettleScript(quiet, timeout, checkAnim);
    try {
      await webContents.executeJavaScript(script, true);
      return true;
    } catch {
      return false;
    }
  }
}
