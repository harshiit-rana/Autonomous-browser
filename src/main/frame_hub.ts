/**
 * Project Aegis - FrameHub: live pixels of worker / tab pages for the chrome renderer (#232, ADR 0010).
 *
 * - A visible source streams with CDP `Page.startScreencast` on the page's ONE debugger session, borrowed from its
 *   ActionExecutor. The hub never attaches, detaches or calls `Page.bringToFront` (focus steal).
 * - Back-pressure: the CDP `Page.screencastFrameAck` is withheld until the renderer acked the previous frame AND
 *   `1/maxFps` has passed since the frame arrived. Chromium sends no new frame before the CDP ack, so frames never
 *   queue; a frame that arrives while a renderer ack is still outstanding is kept as the last frame but not posted.
 * - If the session is unavailable or the executor detaches, a visible source falls back to `capturePage()` polling
 *   (<= 10 fps, each call with a timeout); frames are flagged `source: 'capturePage'`.
 * - A parked source (hidden, frozen by Chromium) gets a still: round-robin `capturePage()`, at most 5 captures/s in
 *   total and at most one per source every 10 s. An empty image is "no frame" and is never forwarded.
 * - Minimised window: nothing is captured; streams restart on restore.
 * - Frames go to the renderer over a dedicated MessagePort as `{workerId, seq, ts, width, height, jpeg: ArrayBuffer}`.
 *   They are kept in memory only (last frame per source) and never persisted or sent to a model (#248).
 */

import type { FramePortFrame, FramePortToMain, WorkerPresentation } from '../ipc/contract.js';

export type { WorkerPresentation } from '../ipc/contract.js';

export interface FrameSubscription {
  workerId: string;
  /** <= 15. 0 means "keep the last frame, stream nothing". */
  maxFps: number;
  /** Default 320. */
  maxWidth?: number;
  /** JPEG quality, default 60. */
  quality?: number;
}

export type WorkerFrame = Omit<FramePortFrame, 'type'>;

/** The part of Electron's `Debugger` the hub uses. */
export interface CdpLike {
  isAttached(): boolean;
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: 'message', listener: (event: unknown, method: string, params: any) => void): unknown;
  on(event: 'detach', listener: (event: unknown, reason: string) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

export interface CapturedImage { jpeg: Uint8Array; width: number; height: number }

/** One page the hub can take pixels from. `electronFrameSource` builds it from a WebContents + ActionExecutor. */
export interface FrameSourceAdapter {
  readonly id: string;
  isDestroyed(): boolean;
  /** The page's shared CDP session (attached by its executor), or null. */
  borrowDebugger(): Promise<CdpLike | null>;
  /** One still. Resolves null for an empty image or a timeout; never throws. */
  capture(maxWidth: number, quality: number): Promise<CapturedImage | null>;
}

/** The part of MessagePortMain the hub uses. */
export interface FramePortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (e: { data: unknown }) => void): unknown;
  start(): void;
  close(): void;
}

export interface HubClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: HubClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: h => clearTimeout(h as NodeJS.Timeout)
};

export const MAX_FPS = 15;
export const FALLBACK_MAX_FPS = 10;
/** A renderer that does not ack within this time is treated as gone for that frame. */
export const RENDERER_ACK_TIMEOUT_MS = 1000;
export const PARKED_STILL_INTERVAL_MS = 10_000;
/** Global cap for parked stills: one capture per tick => at most 5/s. */
export const PARKED_TICK_MS = 200;

export interface SourceStats {
  mode: 'off' | 'screencast' | 'capturePage';
  presentation: WorkerPresentation;
  framesIn: number;
  framesPosted: number;
  framesDropped: number;
  cdpAcks: number;
  emptyCaptures: number;
  stills: number;
  lastFrameAt: number | null;
}

interface SourceState {
  adapter: FrameSourceAdapter;
  sub: Required<FrameSubscription> | null;
  presentation: WorkerPresentation;
  mode: 'off' | 'screencast' | 'capturePage';
  cdp: CdpLike | null;
  /** Set after the executor's session went away; cleared on the next transition to visible. */
  cdpLost: boolean;
  onMessage: ((event: unknown, method: string, params: any) => void) | null;
  onDetach: ((event: unknown, reason: string) => void) | null;
  /** Bumped on every (re)start/stop so stale async starts are ignored. */
  generation: number;
  screencastParams: string;
  seq: number;
  last: WorkerFrame | undefined;
  rendererPending: { seq: number; since: number } | null;
  pendingCdpAck: { sessionId: number; frameAt: number } | null;
  ackTimer: unknown;
  pollTimer: unknown;
  capturing: boolean;
  lastStillAt: number;
  stats: SourceStats;
}

function clampSub(sub: FrameSubscription): Required<FrameSubscription> {
  const fps = Number.isFinite(sub.maxFps) ? Math.max(0, Math.min(MAX_FPS, sub.maxFps)) : 0;
  const maxWidth = Math.max(64, Math.min(1920, Math.round(sub.maxWidth || 320)));
  const quality = Math.max(10, Math.min(95, Math.round(sub.quality || 60)));
  return { workerId: sub.workerId, maxFps: fps, maxWidth, quality };
}

/** Own ArrayBuffer for exactly these bytes (small Buffers share a pooled slab, so `buf.buffer` would leak others). */
export function toOwnArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/** Width/height from a JPEG's SOF marker, or null if the bytes are not a JPEG. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (marker === 0xda || len < 2) return null;
    i += 2 + len;
  }
  return null;
}

export class FrameHub {
  private sources = new Map<string, SourceState>();
  private port: FramePortLike | null = null;
  private minimised = false;
  private parkedTimer: unknown = null;
  private readonly clock: HubClock;

  constructor(options: { clock?: HubClock } = {}) {
    this.clock = options.clock || realClock;
  }

  // ------------------------------------------------------------------------------------------- sources
  public addSource(adapter: FrameSourceAdapter): void {
    if (this.sources.has(adapter.id)) return;
    this.sources.set(adapter.id, {
      adapter, sub: null, presentation: 'parked', mode: 'off', cdp: null, cdpLost: false,
      onMessage: null, onDetach: null, generation: 0, screencastParams: '', seq: 0, last: undefined,
      rendererPending: null, pendingCdpAck: null, ackTimer: null, pollTimer: null, capturing: false,
      lastStillAt: Number.NEGATIVE_INFINITY,
      stats: { mode: 'off', presentation: 'parked', framesIn: 0, framesPosted: 0, framesDropped: 0, cdpAcks: 0, emptyCaptures: 0, stills: 0, lastFrameAt: null }
    });
  }

  /** Stops capture and forgets the source (and its last frame). Call BEFORE the executor detaches / the page closes. */
  public removeSource(id: string): void {
    const s = this.sources.get(id);
    if (!s) return;
    this.stop(s);
    this.sources.delete(id);
    this.updateParkedTicker();
  }

  public hasSource(id: string): boolean {
    return this.sources.has(id);
  }

  // ------------------------------------------------------------------------------------------- ADR interface
  public subscribe(sub: FrameSubscription): void {
    const s = this.sources.get(sub.workerId);
    if (!s) return;
    const next = clampSub(sub);
    const wasSubscribed = !!s.sub;
    s.sub = next;
    // A new subscriber (a new tile, or a reloaded renderer) gets the cached frame at once: never a grey box.
    if (!wasSubscribed && s.last) this.post(s, { ...s.last, source: 'cached' }, true);
    this.reconcile(s);
  }

  public unsubscribe(workerId: string): void {
    const s = this.sources.get(workerId);
    if (!s) return;
    s.sub = null;
    this.reconcile(s);
  }

  /** visible: screencast; parked: <= 1 still / 10 s; minimised: nothing. ViewManager (layout) decides, not the hub. */
  public setPresentation(workerId: string, p: WorkerPresentation): void {
    const s = this.sources.get(workerId);
    if (!s) return;
    if (s.presentation === p) return;
    const becameVisible = p === 'visible' && s.presentation !== 'visible';
    s.presentation = p;
    s.stats.presentation = p;
    if (becameVisible) s.cdpLost = false; // give the shared session another try
    if (p === 'parked') s.lastStillAt = Number.NEGATIVE_INFINITY; // refresh the still soon after parking
    this.reconcile(s);
  }

  public setWindowMinimised(minimised: boolean): void {
    if (this.minimised === minimised) return;
    this.minimised = minimised;
    for (const s of this.sources.values()) this.reconcile(s);
  }

  public lastFrame(workerId: string): WorkerFrame | undefined {
    return this.sources.get(workerId)?.last;
  }

  public stats(workerId: string): SourceStats | undefined {
    const s = this.sources.get(workerId);
    return s ? { ...s.stats } : undefined;
  }

  public allStats(): Record<string, SourceStats> {
    const out: Record<string, SourceStats> = {};
    for (const [id, s] of this.sources) out[id] = { ...s.stats };
    return out;
  }

  // ------------------------------------------------------------------------------------------- renderer port
  /** Installs the renderer's port (a new one after every chrome load). Outstanding renderer acks are forgotten. */
  public attachPort(port: FramePortLike): void {
    if (this.port && this.port !== port) {
      try { this.port.close(); } catch { /* already closed */ }
    }
    this.port = port;
    for (const s of this.sources.values()) {
      s.rendererPending = null;
      // The new renderer subscribes again; until it does nothing is streamed.
      s.sub = null;
      this.reconcile(s);
    }
    port.on('message', e => this.onPortMessage(e.data));
    port.start();
  }

  public onPortMessage(data: unknown): void {
    const m = data as FramePortToMain;
    if (!m || typeof m !== 'object' || typeof (m as any).workerId !== 'string') return;
    if (m.type === 'ack') {
      const s = this.sources.get(m.workerId);
      if (s?.rendererPending && s.rendererPending.seq === m.seq) {
        s.rendererPending = null;
        this.tryCdpAck(s);
      }
    } else if (m.type === 'subscribe') {
      this.subscribe({ workerId: m.workerId, maxFps: Number(m.maxFps), maxWidth: m.maxWidth, quality: m.quality });
    } else if (m.type === 'unsubscribe') {
      this.unsubscribe(m.workerId);
    }
  }

  public dispose(): void {
    for (const s of this.sources.values()) this.stop(s);
    this.sources.clear();
    this.updateParkedTicker();
    try { this.port?.close(); } catch { /* ignore */ }
    this.port = null;
  }

  // ------------------------------------------------------------------------------------------- state machine
  private effectivePresentation(s: SourceState): WorkerPresentation {
    return this.minimised ? 'minimised' : s.presentation;
  }

  private reconcile(s: SourceState): void {
    const p = this.effectivePresentation(s);
    const wantStream = !!s.sub && s.sub.maxFps > 0 && p === 'visible' && !s.adapter.isDestroyed();
    if (!wantStream) {
      if (s.mode !== 'off') this.stop(s);
    } else if (s.mode === 'off') {
      void this.start(s);
    } else if (s.mode === 'screencast' && s.screencastParams !== this.paramsKey(s)) {
      // Width or quality changed: restart the screencast with the new parameters.
      this.stop(s);
      void this.start(s);
    }
    this.updateParkedTicker();
  }

  private paramsKey(s: SourceState): string {
    return s.sub ? `${s.sub.maxWidth}/${s.sub.quality}` : '';
  }

  private async start(s: SourceState): Promise<void> {
    const gen = ++s.generation;
    s.mode = 'capturePage'; // provisional, so a concurrent reconcile does not start twice
    let cdp: CdpLike | null = null;
    if (!s.cdpLost) {
      try { cdp = await s.adapter.borrowDebugger(); } catch { cdp = null; }
    }
    if (gen !== s.generation || !this.sources.has(s.adapter.id)) return; // stopped meanwhile
    if (cdp && cdp.isAttached()) {
      s.cdp = cdp;
      s.mode = 'screencast';
      s.stats.mode = 'screencast';
      s.onMessage = (_e, method, params) => {
        if (method === 'Page.screencastFrame') this.onScreencastFrame(s, gen, params);
      };
      s.onDetach = () => {
        if (gen !== s.generation) return;
        // The executor's session is gone (teardown, crash, external detach): fall back, keep the last frame.
        this.clearScreencast(s);
        s.cdpLost = true;
        s.mode = 'off';
        s.stats.mode = 'off';
        this.reconcile(s);
      };
      cdp.on('message', s.onMessage);
      cdp.on('detach', s.onDetach);
      s.screencastParams = this.paramsKey(s);
      const w = s.sub?.maxWidth || 320;
      try {
        await cdp.sendCommand('Page.startScreencast', { format: 'jpeg', quality: s.sub?.quality || 60, maxWidth: w, maxHeight: w * 2, everyNthFrame: 1 });
      } catch {
        if (gen !== s.generation) return;
        this.clearScreencast(s);
        s.cdpLost = true;
        s.mode = 'off';
        this.reconcile(s);
      }
      return;
    }
    s.mode = 'capturePage';
    s.stats.mode = 'capturePage';
    this.schedulePoll(s, gen, 0);
  }

  private clearScreencast(s: SourceState): void {
    if (s.cdp) {
      if (s.onMessage) s.cdp.removeListener('message', s.onMessage);
      if (s.onDetach) s.cdp.removeListener('detach', s.onDetach);
    }
    s.onMessage = null;
    s.onDetach = null;
    s.cdp = null;
    s.pendingCdpAck = null;
    if (s.ackTimer) { this.clock.clearTimeout(s.ackTimer); s.ackTimer = null; }
  }

  private stop(s: SourceState): void {
    s.generation++;
    if (s.mode === 'screencast' && s.cdp && s.cdp.isAttached()) {
      s.cdp.sendCommand('Page.stopScreencast').catch(() => { /* page gone */ });
    }
    this.clearScreencast(s);
    if (s.pollTimer) { this.clock.clearTimeout(s.pollTimer); s.pollTimer = null; }
    s.mode = 'off';
    s.stats.mode = 'off';
  }

  // ------------------------------------------------------------------------------------------- screencast
  private onScreencastFrame(s: SourceState, gen: number, params: any): void {
    if (gen !== s.generation || !params) return;
    const now = this.clock.now();
    const bytes = Buffer.from(String(params.data || ''), 'base64');
    if (bytes.length > 0) {
      const size = jpegSize(bytes) || { width: Math.round(params.metadata?.deviceWidth || 0), height: Math.round(params.metadata?.deviceHeight || 0) };
      this.emitFrame(s, { jpeg: bytes, width: size.width, height: size.height }, 'screencast');
    }
    s.pendingCdpAck = { sessionId: Number(params.sessionId), frameAt: now };
    this.tryCdpAck(s);
  }

  private tryCdpAck(s: SourceState): void {
    const pending = s.pendingCdpAck;
    if (!pending || !s.cdp) return;
    if (s.ackTimer) { this.clock.clearTimeout(s.ackTimer); s.ackTimer = null; }
    const now = this.clock.now();
    const interval = 1000 / Math.max(1, s.sub?.maxFps || 1);
    const intervalLeft = pending.frameAt + interval - now;
    let rendererLeft = 0;
    if (s.rendererPending) {
      rendererLeft = s.rendererPending.since + RENDERER_ACK_TIMEOUT_MS - now;
      if (rendererLeft <= 0) s.rendererPending = null; // that renderer ack is lost; do not stall the stream
    }
    const wait = Math.max(intervalLeft, s.rendererPending ? rendererLeft : 0);
    if (wait > 0) {
      s.ackTimer = this.clock.setTimeout(() => { s.ackTimer = null; this.tryCdpAck(s); }, Math.ceil(wait));
      return;
    }
    s.pendingCdpAck = null;
    s.stats.cdpAcks++;
    s.cdp.sendCommand('Page.screencastFrameAck', { sessionId: pending.sessionId }).catch(() => { /* session gone */ });
  }

  // ------------------------------------------------------------------------------------------- capturePage
  private schedulePoll(s: SourceState, gen: number, delay: number): void {
    s.pollTimer = this.clock.setTimeout(async () => {
      s.pollTimer = null;
      if (gen !== s.generation) return;
      const fps = Math.max(1, Math.min(FALLBACK_MAX_FPS, s.sub?.maxFps || 1));
      const began = this.clock.now();
      await this.captureOnce(s, 'visible');
      if (gen !== s.generation) return;
      const spent = this.clock.now() - began;
      this.schedulePoll(s, gen, Math.max(0, 1000 / fps - spent));
    }, delay);
  }

  private async captureOnce(s: SourceState, why: 'visible' | 'parked'): Promise<void> {
    if (s.capturing || s.adapter.isDestroyed()) return;
    s.capturing = true;
    try {
      const img = await s.adapter.capture(s.sub?.maxWidth || 320, s.sub?.quality || 60);
      if (!this.sources.has(s.adapter.id)) return;
      if (!img || img.jpeg.byteLength === 0 || img.width <= 0 || img.height <= 0) {
        s.stats.emptyCaptures++; // empty NativeImage = no frame (never-shown or crashed page)
        return;
      }
      if (why === 'parked') s.stats.stills++;
      this.emitFrame(s, img, 'capturePage');
    } finally {
      s.capturing = false;
    }
  }

  private updateParkedTicker(): void {
    const needed = !this.minimised && [...this.sources.values()].some(s => s.sub && this.effectivePresentation(s) === 'parked');
    if (needed && !this.parkedTimer) {
      const tick = () => {
        this.parkedTimer = null;
        this.parkedTick();
        this.updateParkedTicker();
      };
      this.parkedTimer = this.clock.setTimeout(tick, PARKED_TICK_MS);
    } else if (!needed && this.parkedTimer) {
      this.clock.clearTimeout(this.parkedTimer);
      this.parkedTimer = null;
    }
  }

  /** One capture per tick at most, for the parked source whose still is oldest and older than 10 s. */
  private parkedTick(): void {
    const now = this.clock.now();
    let pick: SourceState | null = null;
    for (const s of this.sources.values()) {
      if (!s.sub || this.effectivePresentation(s) !== 'parked' || s.capturing || s.adapter.isDestroyed()) continue;
      if (now - s.lastStillAt < PARKED_STILL_INTERVAL_MS) continue;
      if (!pick || s.lastStillAt < pick.lastStillAt) pick = s;
    }
    if (!pick) return;
    pick.lastStillAt = now;
    void this.captureOnce(pick, 'parked');
  }

  // ------------------------------------------------------------------------------------------- output
  private emitFrame(s: SourceState, img: CapturedImage, source: WorkerFrame['source']): void {
    const now = this.clock.now();
    const frame: WorkerFrame = {
      workerId: s.adapter.id, seq: ++s.seq, ts: now, width: img.width, height: img.height,
      jpeg: toOwnArrayBuffer(img.jpeg), source
    };
    s.last = frame;
    s.stats.framesIn++;
    s.stats.lastFrameAt = now;
    if (!s.sub) return;
    if (s.rendererPending && now - s.rendererPending.since >= RENDERER_ACK_TIMEOUT_MS) s.rendererPending = null;
    if (s.rendererPending) { s.stats.framesDropped++; return; } // back-pressure: renderer still busy with the last one
    this.post(s, frame, false);
  }

  private post(s: SourceState, frame: WorkerFrame, cached: boolean): void {
    if (!this.port) return;
    const msg: FramePortFrame = { type: 'frame', ...frame };
    try {
      this.port.postMessage(msg);
    } catch {
      return;
    }
    s.stats.framesPosted++;
    if (!cached) s.rendererPending = { seq: frame.seq, since: this.clock.now() };
  }
}

// ---------------------------------------------------------------------------------------------------------
// Electron adapter
// ---------------------------------------------------------------------------------------------------------

export const CAPTURE_TIMEOUT_MS = 1000;

interface ElectronLikeWebContents {
  isDestroyed(): boolean;
  capturePage(): Promise<{ isEmpty(): boolean; getSize(): { width: number; height: number }; resize(o: { width: number }): any; toJPEG(q: number): Buffer }>;
}

/** Builds a source from a page and its executor (which owns the debugger attach). */
export function electronFrameSource(id: string, wc: ElectronLikeWebContents, executor: { borrowDebugger(): Promise<CdpLike | null> }): FrameSourceAdapter {
  return {
    id,
    isDestroyed: () => wc.isDestroyed(),
    borrowDebugger: () => executor.borrowDebugger(),
    async capture(maxWidth, quality) {
      if (wc.isDestroyed()) return null;
      let timer: NodeJS.Timeout | undefined;
      try {
        // capturePage on a detached view never settles (run01 D1): always race a timeout.
        const img = await Promise.race([
          wc.capturePage(),
          new Promise<null>(res => { timer = setTimeout(() => res(null), CAPTURE_TIMEOUT_MS); })
        ]);
        if (!img || img.isEmpty()) return null;
        const size = img.getSize();
        const scaled = size.width > maxWidth ? img.resize({ width: maxWidth }) : img;
        const jpeg: Buffer = scaled.toJPEG(quality);
        const out = scaled.getSize();
        return { jpeg, width: out.width, height: out.height };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
