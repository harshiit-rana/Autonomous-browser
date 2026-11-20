/**
 * Project Aegis - pure layout rules for the live Grid (#232; contract in ADR 0012, capture rules in ADR 0010).
 * Kept free of Electron so the rules are unit-tested directly.
 */

import type { LayoutRect, LayoutReport } from '../ipc/contract.js';

/**
 * ADR 0012 rounding rule: x = round(x), y = round(y), right = round(x + w), bottom = round(y + h), w = right - x,
 * h = bottom - y, so adjacent tiles never leave a seam at fractional scales.
 */
export function roundRect(r: LayoutRect): LayoutRect {
  const x = Math.round(r.x);
  const y = Math.round(r.y);
  const right = Math.round(r.x + r.width);
  const bottom = Math.round(r.y + r.height);
  return { x, y, width: right - x, height: bottom - y };
}

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** A tile rect is usable only if it is a real, non-empty rect fully inside the window's content area. */
export function isUsableTileRect(r: LayoutRect | undefined, content: { width: number; height: number }): r is LayoutRect {
  if (!r || !finite(r.x) || !finite(r.y) || !finite(r.width) || !finite(r.height)) return false;
  const q = roundRect(r);
  if (q.width < 16 || q.height < 16) return false;
  return q.x >= 0 && q.y >= 0 && q.x + q.width <= Math.ceil(content.width) && q.y + q.height <= Math.ceil(content.height);
}

/** Chromium clamps zoom to [0.25, 5]; a tile never zooms in. */
export const MIN_TILE_ZOOM = 0.25;

/**
 * Zoom that keeps a worker's layout viewport (`viewportWidth` CSS px wide) inside a tile `tileWidth` DIP wide
 * (ADR 0010 decision 2). Below 0.25 Chromium clamps, so the page then lays out slightly narrower.
 */
export function tileZoomFactor(tileWidth: number, viewportWidth: number): number {
  if (!(tileWidth > 0) || !(viewportWidth > 0)) return 1;
  return Math.max(MIN_TILE_ZOOM, Math.min(1, tileWidth / viewportWidth));
}

/** Validates an incoming report; returns null for anything malformed. Only the newest `seq` is applied. */
export function parseLayoutReport(raw: unknown, lastSeq: number): LayoutReport | null {
  const r = raw as LayoutReport;
  if (!r || typeof r !== 'object' || !finite(r.seq) || r.seq <= lastSeq) return null;
  if (!['stage', 'grid', 'theatre', 'compact'].includes(r.mode as string)) return null;
  const tiles = Array.isArray(r.tiles)
    ? r.tiles.filter(t => t && typeof t.workerId === 'string' && t.rect && finite(t.rect.x) && finite(t.rect.y) && finite(t.rect.width) && finite(t.rect.height))
    : [];
  const vp = r.viewport && finite(r.viewport.x) ? r.viewport : { x: 0, y: 0, width: 0, height: 0 };
  return { seq: r.seq, dpr: finite(r.dpr) ? r.dpr : 1, mode: r.mode, viewport: vp, tiles };
}

/** Tile rects by source id, dropping duplicates (first wins) and rects that overlap an earlier tile. */
export function tilesById(report: LayoutReport | null, content: { width: number; height: number }): Map<string, LayoutRect> {
  const out = new Map<string, LayoutRect>();
  if (!report?.tiles) return out;
  const taken: LayoutRect[] = [];
  for (const t of report.tiles) {
    if (out.has(t.workerId) || !isUsableTileRect(t.rect, content)) continue;
    const q = roundRect(t.rect);
    // Two native views must never overlap: a covered view freezes (ADR 0010) and would steal the other's clicks.
    if (taken.some(o => q.x < o.x + o.width && o.x < q.x + q.width && q.y < o.y + o.height && o.y < q.y + q.height)) continue;
    taken.push(q);
    out.set(t.workerId, q);
  }
  return out;
}
