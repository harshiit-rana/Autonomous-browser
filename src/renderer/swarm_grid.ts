/**
 * Project Aegis - live Swarm Grid (#232, ADR 0010 / ADR 0012).
 *
 * Each tile is a DOM card with a header (identity, status ring, current action), a frame area and a footer. While
 * a tile's frame area is fully on screen the main process places that source's own native view exactly over it
 * (reported with `layout:report`), so the user sees the live page. Underneath, a <canvas> is painted in place with
 * the frames FrameHub streams over the frames MessagePort; it is what shows when the view is hidden (parked tile,
 * crashed page, scrolled out of view): the last frame plus a badge, never a grey box. Frame updates never rebuild
 * the DOM; the renderer acks each frame after it is drawn, which is the hub's back-pressure.
 */

import type {
  GridSource, GridSourcesPayload, FramePortFrame, FramePortToMain, LayoutReport, LayoutRect, WorkerEventPayload
} from '../ipc/contract.js';

export interface TileStats {
  frames: number;
  distinctHashes: number;
  firstFrameAt: number | null;
  lastFrameAt: number | null;
  lastHash: string;
  lastSource: string;
  lastSize: string;
  /** performance.now() of each frame, first 300 only (enough for "frames in the first 2 s"). */
  times: number[];
  subscribedAt: number | null;
}

/** 32-bit FNV-1a of the JPEG bytes: different bytes => different frame. */
export function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Frame rate a tile asks for (ADR 0010): visible and large 15, visible but small 5, not on screen 1 (stills). */
export function tileFps(onScreen: boolean, widthPx: number): number {
  if (!onScreen) return 1;
  return widthPx >= 200 ? 15 : 5;
}

function hostOf(url: string): string {
  try { return new URL(url).host || url; } catch { return url || ''; }
}

function clean(s: string | undefined): string {
  return (s || '').replace(/[\u0000-\u001F\u007F-\u009F‎‏‪-‮]/g, '').trim();
}

interface Tile {
  id: string;
  root: HTMLElement;
  glyph: HTMLElement;
  name: HTMLElement;
  ring: HTMLElement;
  chip: HTMLElement;
  frame: HTMLElement;
  canvas: HTMLCanvasElement;
  badge: HTMLElement;
  age: HTMLElement;
  host: HTMLElement;
  task: HTMLElement;
  progress: HTMLElement;
  source: GridSource;
  lastFrameAt: number | null;
  hashes: Set<string>;
  stats: TileStats;
  subscribedFps: number | null;
  subscribedWidth: number;
  drawing: boolean;
}

interface Bridge {
  reportLayout?(r: LayoutReport): Promise<unknown>;
  getGridSources?(): Promise<{ data?: GridSourcesPayload } | GridSourcesPayload>;
  promoteToStage?(id: string): Promise<unknown>;
}

export class SwarmGrid {
  private tiles = new Map<string, Tile>();
  private list: HTMLElement;
  private empty: HTMLElement;
  private port: MessagePort | null = null;
  private active = false;
  private seq = 0;
  private layoutQueued = false;
  private workerEvents = new Map<string, WorkerEventPayload>();
  private ageTimer: number | null = null;
  private statsRoot: Record<string, TileStats> | null = null;

  constructor(private container: HTMLElement, private bridge: Bridge, private options: { testMode: boolean; onPromote: (s: GridSource) => void }) {
    this.list = document.createElement('div');
    this.list.className = 'live-grid';
    this.empty = document.createElement('div');
    this.empty.className = 'empty-state-text';
    this.empty.textContent = 'No open tabs or active workers in the swarm grid';
    container.replaceChildren(this.list, this.empty);
    if (options.testMode) this.enableTestStats();

    const ro = new ResizeObserver(() => this.queueLayout());
    ro.observe(container);
    container.addEventListener('scroll', () => this.queueLayout(), { passive: true });
    window.addEventListener('resize', () => this.queueLayout());
  }

  /** Test mode only (AEGIS_TEST_MODE=1): per-tile frame counters and hashes on `window.__tileStats` for e2e. */
  public enableTestStats(): void {
    if (this.statsRoot) return;
    this.statsRoot = {};
    for (const t of this.tiles.values()) this.statsRoot[t.id] = t.stats;
    (window as any).__tileStats = this.statsRoot;
  }

  // ------------------------------------------------------------------------------------------- frames port
  public attachPort(port: MessagePort): void {
    this.port?.close();
    this.port = port;
    for (const t of this.tiles.values()) { t.subscribedFps = null; t.drawing = false; }
    port.onmessage = (ev: MessageEvent) => this.onFrame(ev.data as FramePortFrame);
    port.start();
    this.syncSubscriptions();
  }

  private send(m: FramePortToMain): void {
    try { this.port?.postMessage(m); } catch { /* port closed */ }
  }

  private onFrame(f: FramePortFrame): void {
    if (!f || f.type !== 'frame') return;
    const t = this.tiles.get(f.workerId);
    const ack = () => this.send({ type: 'ack', workerId: f.workerId, seq: f.seq });
    if (!t || !(f.jpeg instanceof ArrayBuffer) || f.jpeg.byteLength === 0) { ack(); return; }
    const bytes = new Uint8Array(f.jpeg);
    const hash = fnv1a(bytes);
    const now = performance.now();
    const s = t.stats;
    // A 'cached' frame is the hub's replay of the last frame to a new subscriber: drawn, not counted as live.
    if (f.source !== 'cached') {
      if (!t.hashes.has(hash)) {
        s.distinctHashes++;
        if (t.hashes.size >= 512) t.hashes.clear(); // bound memory; the count keeps growing
        t.hashes.add(hash);
      }
      s.frames++;
      s.firstFrameAt ??= now;
      s.lastFrameAt = now;
      if (s.times.length < 300) s.times.push(now);
    }
    s.lastHash = hash;
    s.lastSource = f.source;
    s.lastSize = `${f.width}x${f.height}`;
    t.lastFrameAt = Date.now();
    // Decode and paint in place; ack only when drawn (back-pressure), or at once on a decode error.
    t.drawing = true;
    createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
      .then(bmp => {
        if (t.canvas.width !== bmp.width || t.canvas.height !== bmp.height) {
          t.canvas.width = bmp.width;
          t.canvas.height = bmp.height;
        }
        t.canvas.getContext('2d')?.drawImage(bmp, 0, 0);
        bmp.close();
        t.root.classList.add('has-frame');
      })
      .catch(() => { /* corrupt frame: keep the previous one */ })
      .finally(() => { t.drawing = false; ack(); this.updateAge(t); });
  }

  // ------------------------------------------------------------------------------------------- data in
  public async refresh(): Promise<void> {
    const res: any = await this.bridge.getGridSources?.();
    const payload: GridSourcesPayload | undefined = res?.data || res;
    if (payload?.sources) this.setSources(payload.sources);
  }

  public setSources(sources: GridSource[]): void {
    // Workers first: the Grid is the swarm's view; tabs follow.
    const ordered = [...sources.filter(s => s.kind === 'worker'), ...sources.filter(s => s.kind === 'tab')];
    const seen = new Set<string>();
    ordered.forEach((src, i) => {
      seen.add(src.id);
      let t = this.tiles.get(src.id);
      if (!t) { t = this.createTile(src); this.tiles.set(src.id, t); }
      t.source = src;
      this.renderTile(t);
      if (this.list.children[i] !== t.root) this.list.insertBefore(t.root, this.list.children[i] || null);
    });
    for (const [id, t] of this.tiles) {
      if (seen.has(id)) continue;
      t.root.remove();
      this.tiles.delete(id);
      if (this.statsRoot) delete this.statsRoot[id];
      if (this.port && t.subscribedFps !== null) this.send({ type: 'unsubscribe', workerId: id });
    }
    this.empty.classList.toggle('hidden', this.tiles.size > 0);
    this.queueLayout();
  }

  public onWorkerEvent(e: WorkerEventPayload): void {
    this.workerEvents.set(e.id, e);
    const t = this.tiles.get(e.id);
    if (t) this.renderTile(t);
  }

  /** Grid shown or hidden. Hidden: unsubscribe everything (0 fps) and report no tiles, so views go back to Stage. */
  public setActive(active: boolean): void {
    this.active = active;
    if (active) {
      void this.refresh();
      if (this.ageTimer === null) this.ageTimer = window.setInterval(() => this.tiles.forEach(t => this.updateAge(t)), 1000);
    } else if (this.ageTimer !== null) {
      window.clearInterval(this.ageTimer);
      this.ageTimer = null;
    }
    this.queueLayout();
  }

  // ------------------------------------------------------------------------------------------- DOM
  private createTile(src: GridSource): Tile {
    const el = (tag: string, cls: string, parent?: HTMLElement) => {
      const e = document.createElement(tag);
      e.className = cls;
      parent?.appendChild(e);
      return e;
    };
    const root = el('div', 'live-tile');
    root.dataset.id = src.id;
    const head = el('div', 'tile-head', root);
    head.title = 'Show on Stage';
    const ring = el('span', 'tile-ring', head);
    const glyph = el('span', 'tile-glyph', ring);
    const name = el('span', 'tile-name', head);
    const chip = el('span', 'tile-chip', head);
    const frame = el('div', 'tile-frame', root);
    const canvas = document.createElement('canvas');
    canvas.className = 'tile-canvas';
    canvas.width = 320;
    canvas.height = 200;
    frame.appendChild(canvas);
    const badge = el('div', 'tile-badge hidden', frame);
    const age = el('div', 'tile-age', frame);
    const foot = el('div', 'tile-foot', root);
    const host = el('span', 'tile-host', foot);
    const task = el('span', 'tile-task', foot);
    const bar = el('div', 'tile-progress', foot);
    const progress = el('div', 'tile-progress-fill', bar);
    const promote = el('button', 'tile-promote', foot) as HTMLButtonElement;
    promote.textContent = 'Stage';
    promote.title = 'Show this page on the Stage (no reload)';
    const go = (ev: Event) => { ev.stopPropagation(); void this.promote(src.id); };
    head.addEventListener('click', go);
    promote.addEventListener('click', go);
    const stats: TileStats = { frames: 0, distinctHashes: 0, firstFrameAt: null, lastFrameAt: null, lastHash: '', lastSource: '', lastSize: '', times: [], subscribedAt: null };
    if (this.statsRoot) this.statsRoot[src.id] = stats;
    return {
      id: src.id, root, glyph, name, ring, chip, frame, canvas, badge, age, host, task, progress, source: src,
      lastFrameAt: null, hashes: new Set(), stats, subscribedFps: null, subscribedWidth: 0, drawing: false
    };
  }

  private renderTile(t: Tile): void {
    const s = t.source;
    const ev = this.workerEvents.get(s.id);
    const isWorker = s.kind === 'worker';
    t.root.classList.toggle('is-worker', isWorker);
    t.root.classList.toggle('is-active', s.isActive);
    t.root.style.setProperty('--tile-color', s.color || (isWorker ? '#64748b' : '#334155'));
    t.glyph.textContent = isWorker ? (s.glyph || '?') : 'T';
    t.name.textContent = clean(isWorker ? `${s.name || s.id}${s.title ? ' - ' + s.title : ''}` : (s.title || 'Tab'));
    t.host.textContent = clean(hostOf(s.url));
    const status = s.crashed ? 'failed' : (ev?.status || (s.loading ? 'running' : 'idle'));
    t.ring.dataset.status = status;
    t.chip.textContent = clean(s.crashed ? 'crashed' : s.loading ? 'navigating' : (ev?.task || (isWorker ? 'idle' : (s.owner?.startsWith('agent:') ? 'agent tab' : 'user tab'))));
    t.task.textContent = isWorker && ev ? `${ev.progress}%` : '';
    t.progress.style.width = `${Math.max(0, Math.min(100, ev?.progress || 0))}%`;
    // Badge over the canvas; only seen when the live view is not on top of it.
    let badge = '';
    if (s.crashed) badge = 'Crashed - last frame';
    else if (s.presentation === 'minimised') badge = 'Window minimised';
    else if (s.presentation === 'parked') badge = 'Paused (not on screen)';
    t.badge.textContent = badge;
    t.badge.classList.toggle('hidden', !badge);
    t.root.dataset.presentation = s.crashed ? 'crashed' : s.presentation;
    this.updateAge(t);
  }

  private updateAge(t: Tile): void {
    if (t.lastFrameAt === null) {
      t.age.textContent = t.source.presentation === 'visible' ? '' : 'no frame yet';
      return;
    }
    const sec = Math.round((Date.now() - t.lastFrameAt) / 1000);
    t.age.textContent = t.source.presentation === 'visible' && !t.source.crashed ? '' : `frame ${sec}s old`;
  }

  private async promote(id: string): Promise<void> {
    const t = this.tiles.get(id);
    if (!t) return;
    await this.bridge.promoteToStage?.(id);
    this.options.onPromote(t.source);
  }

  // ------------------------------------------------------------------------------------------- layout + subscriptions
  private queueLayout(): void {
    if (this.layoutQueued) return;
    this.layoutQueued = true;
    requestAnimationFrame(() => {
      this.layoutQueued = false;
      this.report();
    });
  }

  private rectOf(el: Element): LayoutRect {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  /** Sends `layout:report` and adjusts each tile's subscription to what it can show. */
  private report(): void {
    const viewport = this.rectOf(this.container);
    const tiles: { workerId: string; rect: LayoutRect }[] = [];
    const onScreen = new Set<string>();
    if (this.active) {
      for (const t of this.tiles.values()) {
        const r = this.rectOf(t.frame);
        // A native view cannot be clipped by the DOM: only tiles FULLY inside the scroll area get their live view.
        const inside = r.width > 0 && r.height > 0 && r.x >= viewport.x - 0.5 && r.y >= viewport.y - 0.5 &&
          r.x + r.width <= viewport.x + viewport.width + 0.5 && r.y + r.height <= viewport.y + viewport.height + 0.5;
        if (inside) { tiles.push({ workerId: t.id, rect: r }); onScreen.add(t.id); }
      }
    }
    this.seq++;
    void this.bridge.reportLayout?.({ seq: this.seq, dpr: window.devicePixelRatio || 1, mode: this.active ? 'grid' : 'stage', viewport, tiles });
    this.syncSubscriptions(onScreen);
  }

  private lastOnScreen = new Set<string>();

  private syncSubscriptions(onScreen: Set<string> = this.lastOnScreen): void {
    this.lastOnScreen = onScreen;
    if (!this.port) return;
    const dpr = window.devicePixelRatio || 1;
    for (const t of this.tiles.values()) {
      if (!this.active) {
        if (t.subscribedFps !== null) { this.send({ type: 'unsubscribe', workerId: t.id }); t.subscribedFps = null; }
        continue;
      }
      const w = t.frame.getBoundingClientRect().width;
      const fps = tileFps(onScreen.has(t.id), w);
      const maxWidth = Math.max(160, Math.min(480, Math.round(w * dpr)));
      if (t.subscribedFps === fps && Math.abs(t.subscribedWidth - maxWidth) < 32) continue;
      t.subscribedFps = fps;
      t.subscribedWidth = maxWidth;
      t.stats.subscribedAt ??= performance.now();
      this.send({ type: 'subscribe', workerId: t.id, maxFps: fps, maxWidth, quality: 60 });
    }
  }
}
