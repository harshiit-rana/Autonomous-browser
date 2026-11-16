/**
 * Project Aegis - Web State Snapshotting, Speculative Backtracking & Safety Rollbacks
 * 
 * Implements:
 * - Issue #8: M4.2 Web State Snapshotting, Speculative Backtracking & Safety Rollbacks
 * - Issue #39: PLAN-04 Speculative Parallel Rollouts via Headless Clone Tabs
 * - Issue #40: PLAN-05 Hierarchical High-Level Plan Space (Plan-MCTS)
 */

import { WebContents } from 'electron';

export interface FormFieldState {
  selector: string;
  id?: string;
  name?: string;
  type: string;
  value: string;
  checked?: boolean;
}

export interface WebStateSnapshot {
  id: string;
  timestamp: number;
  url: string;
  title: string;
  scrollPosition: { x: number; y: number };
  formFields: FormFieldState[];
  localStorageDump: Record<string, string>;
  sessionStorageDump: Record<string, string>;
  htmlPreview?: string;
}

export class WebStateSnapshotter {
  /**
   * Captures a comprehensive in-memory snapshot of the active page state.
   */
  public static async captureSnapshot(webContents: WebContents, captureHtml = false): Promise<WebStateSnapshot> {
    if (webContents.isDestroyed()) {
      throw new Error('WebContents is destroyed');
    }

    const script = `
      (() => {
        // 1. Capture Form Fields
        const formElements = document.querySelectorAll('input, textarea, select');
        const formFields = [];

        for (const el of formElements) {
          const type = (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase();
          const selector = el.id ? '#' + el.id : (el.name ? '[name="' + el.name + '"]' : null);
          if (!selector) continue;

          formFields.push({
            selector,
            id: el.id || undefined,
            name: el.name || undefined,
            type,
            value: el.value || '',
            checked: el.checked
          });
        }

        // 2. Storage dumps
        const localDump = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key) localDump[key] = localStorage.getItem(key) || '';
        }

        const sessionDump = {};
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (key) sessionDump[key] = sessionStorage.getItem(key) || '';
        }

        return {
          scrollPosition: { x: window.scrollX, y: window.scrollY },
          formFields,
          localStorageDump: localDump,
          sessionStorageDump: sessionDump,
          html: ${captureHtml} ? document.documentElement.outerHTML.slice(0, 100000) : undefined
        };
      })()
    `;

    const data = await webContents.executeJavaScript(script);

    return {
      id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      url: webContents.getURL(),
      title: webContents.getTitle(),
      scrollPosition: data.scrollPosition,
      formFields: data.formFields,
      localStorageDump: data.localStorageDump,
      sessionStorageDump: data.sessionStorageDump,
      htmlPreview: data.html
    };
  }

  /**
   * Restores a captured state snapshot onto the given WebContents.
   */
  public static async restoreSnapshot(webContents: WebContents, snapshot: WebStateSnapshot): Promise<boolean> {
    if (webContents.isDestroyed()) return false;

    // Navigate back to the snapshot URL if changed
    if (webContents.getURL() !== snapshot.url) {
      await webContents.loadURL(snapshot.url);
    }

    const restoreScript = `
      ((snap) => {
        // 1. Restore Storage
        for (const [k, v] of Object.entries(snap.localStorageDump || {})) {
          localStorage.setItem(k, v);
        }
        for (const [k, v] of Object.entries(snap.sessionStorageDump || {})) {
          sessionStorage.setItem(k, v);
        }

        // 2. Restore Form Fields
        for (const field of snap.formFields || []) {
          try {
            const el = document.querySelector(field.selector);
            if (!el) continue;
            if (field.checked !== undefined) {
              el.checked = field.checked;
            }
            if (field.value !== undefined) {
              el.value = field.value;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } catch (e) {}
        }

        // 3. Restore Scroll
        if (snap.scrollPosition) {
          window.scrollTo(snap.scrollPosition.x, snap.scrollPosition.y);
        }

        return true;
      })(${JSON.stringify(snapshot)})
    `;

    await webContents.executeJavaScript(restoreScript);
    return true;
  }
}
