import { WebContents } from 'electron';
import { DOM_INDEXER_SCRIPT, PageDOMState, IndexedElement } from './dom_indexer.js';
import { MouseTrajectoryGenerator, Point } from '../stealth/mouse_trajectory.js';
import { KeyboardTyper } from '../stealth/keyboard_typer.js';
import { FingerprintShield } from '../stealth/fingerprint_shield.js';
import { isSecretField, maskTextPreview } from '../main/presence_geometry.js';
import type { PresenceEvent } from '../ipc/contract.js';
import { RESOLVE_LOCATOR_JS } from '../agent/perception.js';

export interface ClickOptions {
  button?: 'left' | 'right' | 'middle';
  clickCount?: 1 | 2 | 3;
  doubleClick?: boolean;
  realisticTrajectory?: boolean;
}

/**
 * What the executor reports about the action it just dispatched, in top-level-frame CSS px (PRE-zoom). The owner (ViewManager)
 * adds the worker id, sequence number, live zoom factor and identity before the presence layer draws it. The executor draws nothing.
 */
export type ExecutorPresence = Pick<PresenceEvent, 'kind' | 'x' | 'y'> & Partial<Pick<PresenceEvent, 'path' | 'quadRect' | 'label' | 'textPreview'>>;
export type PresenceSink = (event: ExecutorPresence) => void;

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

  private presenceSink: PresenceSink | null = null;

  constructor(webContents: WebContents) {
    this.webContents = webContents;
  }

  /** Where this executor reports what it does (#233). Never throws into an action. */
  public setPresenceSink(sink: PresenceSink | null): void {
    this.presenceSink = sink;
  }

  private emitPresence(e: ExecutorPresence): void {
    try { this.presenceSink?.(e); } catch { /* presence must never break an action */ }
  }

  /** Read-only look at the focused field (never writes to the page): is it a secret field whose text must not be shown? */
  private async focusedFieldIsSecret(): Promise<boolean> {
    try {
      const f = await this.webContents.executeJavaScript(`(() => {
        let e = document.activeElement;
        while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement;
        if (!e) return null;
        return { tag: e.tagName, type: e.type || '', autocomplete: e.getAttribute ? (e.getAttribute('autocomplete') || '') : '' };
      })()`);
      return isSecretField(f);
    } catch {
      return true;
    }
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
    } catch (err) {
      console.warn('[ActionExecutor] Debugger attach warning:', err);
    }
  }

  /**
   * The one CDP session of this page, attached by this executor (a second `debugger.attach` throws, and a detach by
   * any consumer ends everyone's session, ADR 0010). Other consumers such as FrameHub borrow it through here and
   * must never attach or detach themselves. Returns null when the page is gone or the attach failed.
   */
  public async borrowDebugger(): Promise<Electron.Debugger | null> {
    if (this.webContents.isDestroyed()) return null;
    // A crash or an external detach ends the session without telling us; re-attach in that case.
    if (this.isAttached && !this.webContents.debugger.isAttached()) this.isAttached = false;
    await this.attachCDP();
    return this.webContents.debugger.isAttached() ? this.webContents.debugger : null;
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
        const dispatched: Array<{ x: number; y: number; t: number }> = [];
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
          dispatched.push({ x: pt.x, y: pt.y, t: pt.timestamp });
          lastTime = pt.timestamp;
        }
        this.emitPresence({ kind: 'move', x: targetX, y: targetY, path: dispatched });
      } else {
        await this.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: targetX,
          y: targetY
        });
        this.emitPresence({ kind: 'move', x: targetX, y: targetY });
      }

      this.lastMousePos = { x: targetX, y: targetY };
      await this.sleep(30 + Math.random() * 20);

      this.emitPresence({ kind: 'click', x: targetX, y: targetY });

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
    const dispatched: Array<{ x: number; y: number; t: number }> = [];
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
      dispatched.push({ x: pt.x, y: pt.y, t: pt.timestamp });
      lastTime = pt.timestamp;
    }
    this.emitPresence({ kind: 'move', x: targetX, y: targetY, path: dispatched, label });
    this.lastMousePos = { x: targetX, y: targetY };
  }

  /**
   * Highlights an element in the presence overlay (read-only look at its box; nothing is added to the page).
   */
  public async highlightElement(selector: string): Promise<void> {
    const r = await this.webContents.executeJavaScript(`(() => { let el = null; try { el = document.querySelector(${JSON.stringify(selector)}); } catch (e) {} if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })()`).catch(() => null);
    if (r && r.w > 0 && r.h > 0) this.emitPresence({ kind: 'target', x: r.x + r.w / 2, y: r.y + r.h / 2, quadRect: r });
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
    this.announceScroll(deltaY > 0 ? 'down' : 'up');
    await this.webContents.debugger.sendCommand('Input.synthesizeScrollGesture', {
      x: 300,
      y: 300,
      xDistance: 0,
      yDistance: -deltaY,
      speed: 800
    });
  }

  // ------------------------------------------------------------------ agent tool primitives (#225)
  // Elements are addressed by a locator from `agent/perception.ts` (works through open shadow roots and same-origin
  // frames). Input goes through CDP at absolute viewport coordinates, so the page sees trusted events.

  /** JS dialogs (alert/confirm/prompt/beforeunload) that opened since the last drain, and how they were answered. */
  private dialogs: Array<{ type: string; message: string; accepted: boolean }> = [];
  private dialogListener: ((event: any, method: string, params: any) => void) | null = null;
  private dragIntercepted: any = null;

  private ensureCdpListener(): void {
    if (this.dialogListener || this.webContents.isDestroyed()) return;
    this.dialogListener = (_e: any, method: string, params: any) => {
      if (method === 'Page.javascriptDialogOpening') {
        // Never block the page: alerts and beforeunload are accepted, confirm/prompt are DISMISSED (the safe answer).
        const accept = params.type === 'alert' || params.type === 'beforeunload';
        this.dialogs.push({ type: params.type, message: String(params.message || ''), accepted: accept });
        this.webContents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept }).catch(() => {});
      } else if (method === 'Input.dragIntercepted') {
        this.dragIntercepted = params.data;
      }
    };
    this.webContents.debugger.on('message', this.dialogListener as any);
  }

  /** Attaches CDP (once) and the dialog/drag listener. */
  public async ensureReady(): Promise<void> {
    await this.attachCDP();
    this.ensureCdpListener();
  }

  public drainDialogs(): Array<{ type: string; message: string; accepted: boolean }> {
    const d = this.dialogs;
    this.dialogs = [];
    return d;
  }

  private async cdp(method: string, params: Record<string, any> = {}): Promise<any> {
    const call = this.webContents.debugger.sendCommand(method, params);
    if (!method.startsWith('Input.')) return call;
    // Input events are acknowledged only once the renderer produces a frame; a page that stops painting (hidden or
    // occluded window) must fail the action instead of hanging the agent loop.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${method} was not acknowledged within 10s (page not rendering?)`)), 10_000); });
    try { return await Promise.race([call, timeout]); } finally { clearTimeout(timer); }
  }

  /**
   * Resolves a locator in the page, scrolls it into view and returns its absolute centre, or null when the element is
   * gone (stale ref). `expectTag` guards against a path that now points at a different element.
   */
  public async locate(locator: unknown, expectTag?: string): Promise<{ x: number; y: number; width: number; height: number; tag: string } | null> {
    const r = await this.webContents.executeJavaScript(`(() => {
      ${RESOLVE_LOCATOR_JS}
      const el = __aegisResolve(${JSON.stringify(locator)});
      if (!el || !el.isConnected) return null;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = __aegisAbsRect(el);
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height, tag: el.tagName.toLowerCase() };
    })()`);
    if (!r) return null;
    if (expectTag && r.tag !== expectTag) return null;
    this.emitPresence({ kind: 'target', x: r.x, y: r.y, quadRect: { x: r.x - r.width / 2, y: r.y - r.height / 2, w: r.width, h: r.height } });
    return r;
  }

  /** A scroll the agent performed (done by tools.ts through the page); drawn as arrows next to the cursor. */
  public announceScroll(direction: 'up' | 'down'): void {
    this.emitPresence({ kind: 'scroll', x: this.lastMousePos.x, y: this.lastMousePos.y, label: direction });
  }

  /** The real mouse path of one dispatched move: from where the pointer was to where it went, with the time the dispatch took. */
  private movePath(from: Point, to: Point, startedAt: number): Array<{ x: number; y: number; t: number }> {
    return [{ x: from.x, y: from.y, t: 0 }, { x: to.x, y: to.y, t: Math.max(1, Date.now() - startedAt) }];
  }

  public async mouseMove(x: number, y: number): Promise<void> {
    await this.ensureReady();
    const from = this.lastMousePos; const t0 = Date.now();
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    this.lastMousePos = { x, y };
    this.emitPresence({ kind: 'move', x, y, path: this.movePath(from, { x, y }, t0) });
  }

  public async clickAt(x: number, y: number, button: 'left' | 'right' = 'left'): Promise<void> {
    await this.ensureReady();
    const from = this.lastMousePos; const t0 = Date.now();
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    this.emitPresence({ kind: 'move', x, y, path: this.movePath(from, { x, y }, t0) });
    await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
    this.emitPresence({ kind: 'click', x, y, label: button });
    await this.sleep(40);
    // A dialog opened by mousedown/click blocks the release until it is handled; never await it forever.
    await Promise.race([this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 }), this.sleep(3000)]);
    this.lastMousePos = { x, y };
  }

  public async insertText(text: string): Promise<void> {
    await this.ensureReady();
    const secret = await this.focusedFieldIsSecret();
    let typed = '';
    for (const ch of text) {
      await this.cdp('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch });
      await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      typed += ch;
      this.emitPresence({ kind: 'type', x: this.lastMousePos.x, y: this.lastMousePos.y, textPreview: maskTextPreview(typed, secret) });
    }
  }

  public async pressKey(key: string, modifiers = 0): Promise<void> {
    await this.ensureReady();
    const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
      Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Tab: { code: 'Tab', keyCode: 9 }, Escape: { code: 'Escape', keyCode: 27 },
      Backspace: { code: 'Backspace', keyCode: 8 }, Delete: { code: 'Delete', keyCode: 46 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 },
      ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowLeft: { code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { code: 'ArrowRight', keyCode: 39 },
      PageDown: { code: 'PageDown', keyCode: 34 }, PageUp: { code: 'PageUp', keyCode: 33 }, Home: { code: 'Home', keyCode: 36 }, End: { code: 'End', keyCode: 35 },
      Space: { code: 'Space', keyCode: 32, text: ' ' }
    };
    const k = KEYS[key] || { code: key.length === 1 ? `Key${key.toUpperCase()}` : key, keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, text: key.length === 1 ? key : undefined };
    const keyName = key === 'Space' ? ' ' : key;
    await this.cdp('Input.dispatchKeyEvent', { type: k.text && !modifiers ? 'keyDown' : 'rawKeyDown', key: keyName, code: k.code, windowsVirtualKeyCode: k.keyCode, text: modifiers ? undefined : k.text, modifiers });
    await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers });
  }

  /**
   * Drag from one point to another. HTML5 drag-and-drop (draggable=true) is driven through CDP drag interception
   * (the OS drag loop never starts for synthetic input); pointer-based drags get the plain move sequence.
   */
  public async dragBetween(from: { x: number; y: number }, to: { x: number; y: number }): Promise<'html5' | 'pointer'> {
    await this.ensureReady();
    this.dragIntercepted = null;
    await this.cdp('Input.setInterceptDrags', { enabled: true });
    try {
      await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
      await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        const x = from.x + ((to.x - from.x) * i) / steps;
        const y = from.y + ((to.y - from.y) * i) / steps;
        await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
        this.emitPresence({ kind: 'move', x, y });
        await this.sleep(15);
        if (this.dragIntercepted) break;
      }
      if (this.dragIntercepted) {
        const data = this.dragIntercepted;
        await this.cdp('Input.dispatchDragEvent', { type: 'dragEnter', x: to.x, y: to.y, data });
        await this.cdp('Input.dispatchDragEvent', { type: 'dragOver', x: to.x, y: to.y, data });
        await this.cdp('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data });
        await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
        return 'html5';
      }
      await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
      return 'pointer';
    } finally {
      this.dragIntercepted = null;
      await this.cdp('Input.setInterceptDrags', { enabled: false }).catch(() => {});
      this.lastMousePos = { x: to.x, y: to.y };
    }
  }

  /** Sets the files of an `<input type=file>` addressed by locator (paths must already be validated by the caller). */
  public async setInputFiles(locator: unknown, files: string[]): Promise<boolean> {
    await this.ensureReady();
    const { result } = await this.cdp('Runtime.evaluate', {
      expression: `(() => { ${RESOLVE_LOCATOR_JS} return __aegisResolve(${JSON.stringify(locator)}); })()`,
      returnByValue: false
    });
    if (!result || result.subtype === 'null' || !result.objectId) return false;
    await this.cdp('DOM.setFileInputFiles', { files, objectId: result.objectId });
    await this.cdp('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
    return true;
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
