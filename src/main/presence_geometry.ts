/**
 * Presence layer: the pure parts (#233, ADR 0011). No Electron import, so tests can run them in plain node.
 */
import type { PresenceEvent, LayoutRect } from '../ipc/contract.js';

/**
 * Overlay position (DIP, relative to the content area) of a page-space point: view origin + (x * zoom, y * zoom).
 * ADR 0011 measured this within 0.6 px at 100/125/200 % and about 1 px at zoom 1.5; there is no DPR term.
 */
export function overlayPoint(view: LayoutRect, x: number, y: number, zoom: number): { x: number; y: number } {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return { x: view.x + x * z, y: view.y + y * z };
}

/** True when the page-space point is inside the visible viewport of the view (not scrolled/zoomed out of it). */
export function pointInView(view: LayoutRect, x: number, y: number, zoom: number): boolean {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return x >= 0 && y >= 0 && x * z <= view.width && y * z <= view.height;
}

/** Overlay window bounds for a parent's content bounds: identical, integer DIPs. */
export function overlayBounds(content: LayoutRect): LayoutRect {
  return { x: Math.round(content.x), y: Math.round(content.y), width: Math.max(1, Math.round(content.width)), height: Math.max(1, Math.round(content.height)) };
}

export function sameRect(a: LayoutRect | null | undefined, b: LayoutRect | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

const SECRET_AUTOCOMPLETE = /(^|\s)(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)/i;

/** True when a focused field must never have its text shown in the overlay. */
export function isSecretField(f: { tag?: string; type?: string; autocomplete?: string; probeFailed?: boolean } | null | undefined): boolean {
  // Unknown is secret: if the read-only probe of the focused element failed, show bullets rather than risk leaking.
  if (!f || f.probeFailed) return true;
  if ((f.type || '').toLowerCase() === 'password') return true;
  return SECRET_AUTOCOMPLETE.test(f.autocomplete || '');
}

/** The typed text as the overlay may show it: the last `max` characters, bullets when the field is secret. */
export function maskTextPreview(text: string, secret: boolean, max = 40): string {
  const chars = [...text];
  const tail = chars.slice(-max);
  return secret ? '•'.repeat(tail.length) : tail.join('');
}

/**
 * Coalescer: at most one pending `move` per worker (the newest wins); every other event is kept, in order. A worker
 * that fires 1000 moves between two flushes costs the overlay one move; a click is never dropped or reordered
 * behind a later move of the same worker.
 */
export class PresenceCoalescer {
  private pending: PresenceEvent[] = [];
  /** index in `pending` of the open `move` per worker, invalidated by any later non-move of that worker */
  private openMove = new Map<string, number>();

  push(e: PresenceEvent): void {
    if (e.kind === 'move') {
      const at = this.openMove.get(e.workerId);
      if (at !== undefined && this.pending[at] && this.pending[at].workerId === e.workerId) {
        // Keep the real path of the move being replaced: concatenate, so the cursor still follows what was dispatched.
        const prev = this.pending[at];
        const base = prev.path ?? [];
        const t0 = base.length ? base[base.length - 1].t : 0;
        const next = (e.path ?? [{ x: e.x, y: e.y, t: 0 }]).map(p => ({ ...p, t: p.t + t0 }));
        this.pending[at] = { ...e, path: [...base, ...next].slice(-64) };
        return;
      }
      this.openMove.set(e.workerId, this.pending.length);
      this.pending.push(e);
      return;
    }
    this.openMove.delete(e.workerId);
    this.pending.push(e);
  }

  get size(): number { return this.pending.length; }

  drain(): PresenceEvent[] {
    const out = this.pending;
    this.pending = [];
    this.openMove.clear();
    return out;
  }
}
