import { WebContents } from 'electron';
import { DOM_INDEXER_SCRIPT, PageDOMState, IndexedElement } from './dom_indexer.js';

export interface ClickOptions {
  button?: 'left' | 'right' | 'middle';
  clickCount?: 1 | 2 | 3;
  doubleClick?: boolean;
}

/**
 * Dual-Mode Execution Engine
 * Combines authentic physical hardware pointer simulation via CDP with synthetic DOM fallback.
 * Directly mirrors Strawberry's AgentDOMService.clickElement & simulateMouseClick.
 */
export class ActionExecutor {
  private webContents: WebContents;
  private isAttached: boolean = false;

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
   * 1. Physical Mode: Computes bounding box center and dispatches Input.dispatchMouseEvent.
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
    const clickX = Math.round(x + w / 2);
    const clickY = Math.round(y + h / 2);
    const button = options.button || 'left';
    const clickCount = options.doubleClick ? 2 : (options.clickCount || 1);

    // If contenteditable or custom shadow component, use synthetic click with focus
    if (element.isContentEditable) {
      await this.syntheticClick(agentId);
      return { success: true, mode: 'synthetic-focus' };
    }

    try {
      // Physical CDP Event Simulation
      await this.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: clickX,
        y: clickY
      });
      await this.sleep(40);

      await this.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: clickX,
        y: clickY,
        button: button,
        clickCount: clickCount
      });
      await this.sleep(40);

      await this.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: clickX,
        y: clickY,
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

  public async typeText(agentId: string, text: string): Promise<void> {
    await this.attachCDP();
    // Focus the target first
    await this.clickElement(agentId);
    await this.sleep(50);

    for (const char of text) {
      await this.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: char
      });
      await this.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        text: char
      });
      await this.sleep(15); // Human typing jitter
    }
  }

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
