import { WebContents } from 'electron';
import { DOM_INDEXER_SCRIPT, PageDOMState, IndexedElement } from './dom_indexer.js';
import { MouseTrajectoryGenerator, Point } from '../stealth/mouse_trajectory.js';
import { KeyboardTyper } from '../stealth/keyboard_typer.js';
import { FingerprintShield } from '../stealth/fingerprint_shield.js';
import { CURSOR_OVERLAY_SCRIPT } from '../stealth/cursor_overlay.js';

export interface ClickOptions {
  button?: 'left' | 'right' | 'middle';
  clickCount?: 1 | 2 | 3;
  doubleClick?: boolean;
  realisticTrajectory?: boolean;
}

export interface TypeOptions {
  wordsPerMinute?: number;
  typoRate?: number;
}

/**
 * Dual-Mode Execution Engine
 * Combines authentic physical hardware pointer simulation via CDP with synthetic DOM fallback,
 * featuring realistic human kinematic mouse trajectories, typing cadence, and fingerprint evasion.
 */
export class ActionExecutor {
  private webContents: WebContents;
  private isAttached: boolean = false;
  private lastMousePos: Point = { x: 100, y: 100 };

  constructor(webContents: WebContents) {
    this.webContents = webContents;
  }

  public async attachCDP(): Promise<void> {
    if (this.isAttached || this.webContents.isDestroyed()) return;
    try {
      if (!this.webContents.debugger.isAttached()) {
        this.webContents.debugger.attach('1.3');
      }
      this.isAttached = true;

      // Enable Page and Runtime domains
      await this.webContents.debugger.sendCommand('Page.enable');
      await this.webContents.debugger.sendCommand('Runtime.enable');

      // Inject anti-bot evasion script on every document load
      const stealthScript = FingerprintShield.getStealthScript();
      await this.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: stealthScript
      });
      await this.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: CURSOR_OVERLAY_SCRIPT
      });
      // Also inject into current document immediately if loaded
      this.webContents.executeJavaScript(CURSOR_OVERLAY_SCRIPT).catch(() => {});
    } catch (err) {
      console.warn('[ActionExecutor] Debugger attach warning:', err);
    }
  }

  public async detachCDP(): Promise<void> {
    if (this.isAttached && !this.webContents.isDestroyed()) {
      try {
        if (this.webContents.debugger.isAttached()) {
          this.webContents.debugger.detach();
        }
      } catch {}
      this.isAttached = false;
    }
  }

  public async getDOMState(): Promise<PageDOMState> {
    if (this.webContents.isDestroyed()) {
      throw new Error('WebContents destroyed');
    }
    const result = await this.webContents.executeJavaScript(DOM_INDEXER_SCRIPT);
    return result as PageDOMState;
  }

  /**
   * Dual-mode click execution:
   * 1. Physical Mode: Computes bounding box center, moves along a human Bezier curve, and dispatches CDP events.
   * 2. Synthetic Fallback: Dispatches in-frame element.click() if obscured or contenteditable.
   */
  public async clickElement(agentId: string, options: ClickOptions = {}): Promise<{ success: boolean; mode: string }> {
    await this.attachCDP();
    const domState = await this.getDOMState();
    const element = domState.elements.find(el => el.id === agentId);

    if (!element) {
      throw new Error(`Element with id ${agentId} not found in DOM`);
    }

    const { x, y, w, h } = element.bounds;
    const targetX = Math.round(x + w / 2);
    const targetY = Math.round(y + h / 2);
    const button = options.button || 'left';
    const clickCount = options.doubleClick ? 2 : (options.clickCount || 1);

    // If contenteditable or custom shadow component, use synthetic click with focus
    if (element.isContentEditable) {
      await this.syntheticClick(agentId);
      return { success: true, mode: 'synthetic-focus' };
    }

    try {
      // Simulate realistic human mouse curve trajectory
      if (options.realisticTrajectory !== false) {
        const trajectory = MouseTrajectoryGenerator.generateTrajectory(
          this.lastMousePos,
          { x: targetX, y: targetY },
          { targetWidth: w, targetHeight: h }
        );

        let lastTime = 0;
        for (const pt of trajectory) {
          const delta = pt.timestamp - lastTime;
          if (delta > 0) {
            await this.sleep(delta);
          }
          await this.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: pt.x,
            y: pt.y
          });
          this.webContents.executeJavaScript(`if(window.__updateAgentCursor) window.__updateAgentCursor(${Math.round(pt.x)}, ${Math.round(pt.y)});`).catch(() => {});
          lastTime = pt.timestamp;
        }
      } else {
        await this.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: targetX,
          y: targetY
        });
        this.webContents.executeJavaScript(`if(window.__updateAgentCursor) window.__updateAgentCursor(${targetX}, ${targetY});`).catch(() => {});
      }

      this.lastMousePos = { x: targetX, y: targetY };
      await this.sleep(30 + Math.random() * 20);

      // Visual Click Ripple Feedback
      this.webContents.executeJavaScript(`if(window.__triggerAgentClick) window.__triggerAgentClick(${targetX}, ${targetY});`).catch(() => {});

      // Press down
      await this.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: targetX,
        y: targetY,
        button: button,
        clickCount: clickCount
      });

      await this.sleep(40 + Math.random() * 25);

      // Release
      await this.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: targetX,
        y: targetY,
        button: button,
        clickCount: clickCount
      });

      return { success: true, mode: 'physical-cdp' };
    } catch (err) {
      // Fallback to DOM Click
      console.warn(`[ActionExecutor] Physical click failed on ${agentId}, falling back to synthetic DOM:`, err);
      await this.syntheticClick(agentId);
      return { success: true, mode: 'synthetic-fallback' };
    }
  }

  /**
   * Visually moves the agent cursor along a natural human Bezier curve
   */
  public async moveMouseTo(targetX: number, targetY: number, label?: string): Promise<void> {
    await this.attachCDP();
    const trajectory = MouseTrajectoryGenerator.generateTrajectory(
      this.lastMousePos,
      { x: targetX, y: targetY },
      { targetWidth: 20, targetHeight: 20 }
    );

    let lastTime = 0;
    for (const pt of trajectory) {
      const delta = pt.timestamp - lastTime;
      if (delta > 0) {
        await this.sleep(delta);
      }
      await this.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: pt.x,
        y: pt.y
      });
      this.webContents.executeJavaScript(`if(window.__updateAgentCursor) window.__updateAgentCursor(${Math.round(pt.x)}, ${Math.round(pt.y)}, ${label ? JSON.stringify(label) : 'undefined'});`).catch(() => {});
      lastTime = pt.timestamp;
    }
    this.lastMousePos = { x: targetX, y: targetY };
  }

  /**
   * Highlights an element with a glowing outline
   */
  public async highlightElement(selector: string): Promise<void> {
    await this.webContents.executeJavaScript(`if(window.__highlightElement) window.__highlightElement(${JSON.stringify(selector)});`).catch(() => {});
  }

  /**
   * Types text into the given element using realistic human cadence and typo simulation.
   */
  public async typeText(agentId: string, text: string, options: TypeOptions = {}): Promise<void> {
    await this.attachCDP();
    // Focus the target element first
    await this.clickElement(agentId, { realisticTrajectory: true });
    await this.sleep(80);

    const keystrokes = KeyboardTyper.planKeystrokes(text, options);

    for (const step of keystrokes) {
      if (step.delayBeforeMs > 0) {
        await this.sleep(step.delayBeforeMs);
      }

      await this.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: step.type,
        key: step.key,
        code: step.code,
        text: step.text
      });
    }
  }

  /**
   * Synthesizes smooth human scroll gesture.
   */
  public async scroll(deltaY: number): Promise<void> {
    await this.attachCDP();
    await this.webContents.debugger.sendCommand('Input.synthesizeScrollGesture', {
      x: 300,
      y: 300,
      xDistance: 0,
      yDistance: -deltaY,
      speed: 800
    });
  }

  private async syntheticClick(agentId: string): Promise<void> {
    const script = `
      (() => {
        const el = document.querySelector('[data-agent-id="${agentId}"]');
        if (!el) return false;
        el.click();
        if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
          el.focus();
        }
        return true;
      })()
    `;
    await this.webContents.executeJavaScript(script);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
