/**
 * Presence overlay page (#233, ADR 0011). Runs in the transparent click-through child window, never in the chrome
 * renderer and never in a page. It only draws; it sends nothing back. All text goes in through textContent.
 * Types are imported with `import type`, so nothing from the contract is bundled.
 */
import type { PresenceEvent, PresenceMessage, LayoutRect } from '../ipc/contract.js';

interface WorkerLayer {
  box: HTMLDivElement;
  cursor: HTMLDivElement;
  chip: HTMLDivElement;
  bubble: HTMLDivElement | null;
  rect: LayoutRect;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastX: number;
  lastY: number;
}

const IDLE_DIM_MS = 30_000;
const reduced = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const layers = new Map<string, WorkerLayer>();
const root = document.getElementById('root') as HTMLElement;

function safeColor(c: string | undefined): string {
  return typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#7c5cff';
}

function place(box: HTMLElement, r: LayoutRect): void {
  box.style.left = `${r.x}px`;
  box.style.top = `${r.y}px`;
  box.style.width = `${r.width}px`;
  box.style.height = `${r.height}px`;
}

function create(workerId: string, rect: LayoutRect): WorkerLayer {
  const box = document.createElement('div');
  box.className = 'view';
  place(box, rect);
  const cursor = document.createElement('div');
  cursor.className = 'cursor';
  cursor.style.visibility = 'hidden';
  const dot = document.createElement('div'); dot.className = 'dot';
  const arrow = document.createElement('div'); arrow.className = 'arrow'; arrow.textContent = '◤';
  const chip = document.createElement('div'); chip.className = 'chip'; chip.textContent = workerId;
  cursor.append(dot, arrow, chip);
  box.appendChild(cursor);
  root.appendChild(box);
  const l: WorkerLayer = { box, cursor, chip, bubble: null, rect, idleTimer: null, lastX: 0, lastY: 0 };
  layers.set(workerId, l);
  return l;
}

function moveTo(l: WorkerLayer, e: PresenceEvent): void {
  const z = e.zoom > 0 ? e.zoom : 1;
  const to = `translate(${e.x * z}px, ${e.y * z}px)`;
  l.cursor.style.visibility = 'visible';
  l.cursor.classList.remove('idle');
  const path = e.path;
  if (!reduced() && path && path.length >= 2 && typeof l.cursor.animate === 'function') {
    const total = Math.max(1, path[path.length - 1].t - path[0].t);
    const keyframes = path.map(p => ({ transform: `translate(${p.x * z}px, ${p.y * z}px)`, offset: Math.min(1, Math.max(0, (p.t - path[0].t) / total)) }));
    keyframes[0].offset = 0; keyframes[keyframes.length - 1].offset = 1;
    try { l.cursor.animate(keyframes, { duration: Math.min(700, Math.max(60, total)), easing: 'linear' }); } catch { /* fall through to the final position */ }
  }
  l.cursor.style.transform = to;
  l.lastX = e.x * z; l.lastY = e.y * z;
  if (l.idleTimer) clearTimeout(l.idleTimer);
  l.idleTimer = setTimeout(() => l.cursor.classList.add('idle'), IDLE_DIM_MS);
}

function transient(l: WorkerLayer, el: HTMLElement, ms: number): void {
  l.box.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function handle(e: PresenceEvent): void {
  const l = layers.get(e.workerId);
  if (!l) return; // no rect yet: the view is hidden, nothing may be drawn
  const color = safeColor(e.color);
  l.cursor.style.setProperty('--c', color);
  if (e.name) l.chip.textContent = e.name + (e.glyph ? ` ${e.glyph}` : '');
  const z = e.zoom > 0 ? e.zoom : 1;
  switch (e.kind) {
    case 'move': moveTo(l, e); break;
    case 'click': {
      moveTo(l, e);
      const r = document.createElement('div'); r.className = 'ripple';
      r.style.left = `${e.x * z}px`; r.style.top = `${e.y * z}px`; r.style.setProperty('--c', color);
      transient(l, r, 600);
      break;
    }
    case 'type': {
      moveTo(l, e);
      if (!l.bubble) { l.bubble = document.createElement('div'); l.bubble.className = 'bubble'; l.cursor.appendChild(l.bubble); }
      l.bubble.textContent = e.textPreview ?? '';
      l.bubble.style.display = e.textPreview ? 'block' : 'none';
      break;
    }
    case 'scroll': {
      moveTo(l, e);
      const s = document.createElement('div'); s.className = 'scroll'; s.textContent = e.label === 'up' ? '▲' : '▼';
      s.style.left = `${e.x * z + 18}px`; s.style.top = `${e.y * z - 4}px`; s.style.setProperty('--c', color);
      transient(l, s, 1100);
      break;
    }
    case 'target': {
      const q = e.quadRect;
      if (!q) break;
      const t = document.createElement('div'); t.className = 'target';
      t.style.left = `${q.x * z}px`; t.style.top = `${q.y * z}px`; t.style.width = `${q.w * z}px`; t.style.height = `${q.h * z}px`;
      t.style.setProperty('--c', color);
      transient(l, t, 1700); // a highlighted element that vanishes leaves nothing behind: the box expires on its own
      break;
    }
    case 'think': l.chip.classList.add('think'); setTimeout(() => l.chip.classList.remove('think'), 1500); break;
    case 'needs_you': {
      const b = document.createElement('div'); b.className = 'beacon';
      b.style.left = `${l.lastX - 22}px`; b.style.top = `${l.lastY - 22}px`;
      transient(l, b, 3300);
      break;
    }
  }
  if (e.kind !== 'type' && l.bubble) { l.bubble.style.display = 'none'; }
}

function onMessage(raw: unknown): void {
  const m = raw as PresenceMessage;
  if (!m || typeof m !== 'object') return;
  if (m.op === 'rect') {
    const l = layers.get(m.workerId);
    if (!m.rect) { if (l) l.box.style.display = 'none'; return; }
    if (l) { place(l.box, m.rect); l.rect = m.rect; l.box.style.display = 'block'; }
    else create(m.workerId, m.rect);
  } else if (m.op === 'remove') {
    layers.get(m.workerId)?.box.remove();
    layers.delete(m.workerId);
  } else if (m.op === 'event') {
    handle(m.event);
  }
}

(window as any).presence?.onMessage(onMessage);
