/**
 * Agent presence layer (#233, ADR 0011): owns ONE transparent, click-through child window over the content area that
 * draws every worker's cursor, ripple, caret bubble and target highlight above the native page views.
 *
 * This module has no Electron import: the window and the display events are injected (`presence_window.ts` builds the
 * real ones), so the tracking rules below are tested with fakes in plain node. It is not part of ADR 0012's
 * WindowStack: it is a separate window, which is why re-adding a page view can never bury it.
 */
import type { LayoutRect, PresenceEvent, PresenceMessage } from '../ipc/contract.js';
import { PresenceCoalescer, overlayBounds, sameRect } from './presence_geometry.js';

export interface OverlayWindowLike {
  setBounds(bounds: LayoutRect): void;
  showInactive(): void;
  hide(): void;
  isVisible(): boolean;
  isDestroyed(): boolean;
  send(message: PresenceMessage): void;
  /** Calls back once the overlay page has loaded (messages sent earlier are queued by the layer). */
  onReady(cb: () => void): void;
  close(): void;
}

export interface ParentWindowLike {
  getContentBounds(): LayoutRect;
  isMinimized(): boolean;
  isVisible(): boolean;
  isDestroyed(): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface DisplayEventsLike { on(event: string, listener: (...args: any[]) => void): unknown }

export interface PresenceLayerOptions {
  /** null when the platform has no usable click-through window (Linux): the layer then draws nothing, honestly. */
  createOverlay: (() => OverlayWindowLike) | null;
  displays?: DisplayEventsLike | null;
  flushMs?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/** Parent events after which the overlay must be re-fitted to the content area. */
export const TRACKED_PARENT_EVENTS = [
  'move', 'resize', 'moved', 'resized', 'maximize', 'unmaximize', 'restore', 'minimize', 'show', 'hide',
  'enter-full-screen', 'leave-full-screen', 'enter-html-full-screen', 'leave-html-full-screen'
] as const;
export const TRACKED_DISPLAY_EVENTS = ['display-metrics-changed', 'display-added', 'display-removed'] as const;

const MAX_QUEUE = 500;

export class PresenceLayer {
  private overlay: OverlayWindowLike | null = null;
  private ready = false;
  private queue: PresenceMessage[] = [];
  private rects = new Map<string, LayoutRect>();
  private coalescer = new PresenceCoalescer();
  private flushHandle: unknown = null;
  private lastBounds: LayoutRect | null = null;
  private disposed = false;
  private readonly flushMs: number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (h: unknown) => void;
  public readonly stats = { received: 0, sent: 0, dropped: 0, flushes: 0, boundsSyncs: 0 };

  constructor(private readonly parent: ParentWindowLike, private readonly opts: PresenceLayerOptions) {
    this.flushMs = opts.flushMs ?? 16;
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    // Registered before anything changes: Electron fires move/resize synchronously inside setBounds (ADR 0011).
    for (const ev of TRACKED_PARENT_EVENTS) parent.on(ev, () => this.sync());
    if (opts.displays) for (const ev of TRACKED_DISPLAY_EVENTS) opts.displays.on(ev, () => this.sync());
    parent.on('closed', () => this.dispose());
  }

  /** true when this platform has a click-through window and one exists (or can be created) */
  get available(): boolean { return this.opts.createOverlay !== null && !this.disposed; }
  get overlayWindow(): OverlayWindowLike | null { return this.overlay; }

  /** Where a worker's page view is, content-relative DIP, or null when that view is hidden or gone. */
  setViewRect(workerId: string, rect: LayoutRect | null): void {
    if (this.disposed) return;
    const prev = this.rects.get(workerId) ?? null;
    if (sameRect(prev, rect)) return;
    if (rect) this.rects.set(workerId, { ...rect }); else this.rects.delete(workerId);
    this.post({ op: 'rect', workerId, rect: rect ? { ...rect } : null });
    this.sync();
  }

  removeWorker(workerId: string): void {
    if (this.disposed) return;
    this.rects.delete(workerId);
    this.post({ op: 'remove', workerId });
    this.sync();
  }

  /** Queue one presence event. Events of a hidden view are dropped (nothing may be drawn over a hidden page). */
  emit(e: PresenceEvent): void {
    if (this.disposed) return;
    this.stats.received++;
    if (!this.opts.createOverlay || !this.rects.has(e.workerId)) { this.stats.dropped++; return; }
    this.coalescer.push(e);
    if (this.flushHandle === null) this.flushHandle = this.schedule(() => this.flush(), this.flushMs);
  }

  flush(): void {
    this.flushHandle = null;
    const events = this.coalescer.drain();
    if (events.length === 0) return;
    this.stats.flushes++;
    for (const event of events) this.post({ op: 'event', event });
  }

  /** Fit the overlay to the parent's content area and show/hide it. Safe to call at any time. */
  sync(): void {
    if (this.disposed || !this.opts.createOverlay) return;
    if (this.parent.isDestroyed()) return;
    const minimised = this.parent.isMinimized();
    const wantVisible = !minimised && this.parent.isVisible() && this.rects.size > 0;
    if (wantVisible) this.ensureOverlay();
    const ov = this.overlay;
    if (!ov || ov.isDestroyed()) return;
    if (!minimised) {
      const b = overlayBounds(this.parent.getContentBounds());
      if (!sameRect(b, this.lastBounds)) { ov.setBounds(b); this.lastBounds = b; this.stats.boundsSyncs++; }
    }
    if (wantVisible && !ov.isVisible()) ov.showInactive();
    else if (!wantVisible && ov.isVisible()) ov.hide();
  }

  private ensureOverlay(): void {
    if (this.overlay || !this.opts.createOverlay) return;
    this.overlay = this.opts.createOverlay();
    this.overlay.onReady(() => {
      this.ready = true;
      const q = this.queue.splice(0);
      for (const m of q) this.overlay?.send(m);
    });
    // The queue already holds every rect message; a layer created late still has to know them all.
    for (const [workerId, rect] of this.rects) if (!this.queue.some(m => m.op === 'rect' && m.workerId === workerId)) this.queue.push({ op: 'rect', workerId, rect });
  }

  private post(m: PresenceMessage): void {
    if (!this.opts.createOverlay) return;
    if (this.overlay && this.ready && !this.overlay.isDestroyed()) {
      this.overlay.send(m);
      if (m.op === 'event') this.stats.sent++;
      return;
    }
    this.queue.push(m);
    if (this.queue.length > MAX_QUEUE) { this.queue.shift(); this.stats.dropped++; }
    if (m.op === 'event') this.stats.sent++;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.flushHandle !== null) this.cancel(this.flushHandle);
    this.flushHandle = null;
    try { if (this.overlay && !this.overlay.isDestroyed()) this.overlay.close(); } catch { /* already closing with its parent */ }
    this.overlay = null;
  }
}
