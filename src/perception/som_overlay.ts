/**
 * Project Aegis - Visual 'Set-of-Mark' (SoM) Dynamic Overlay Generator
 * 
 * Implements:
 * - Issue #27: PERC-02 Visual 'Set-of-Mark' (SoM) Dynamic Overlay Generator
 */

import { IndexedElement } from '../core/dom_indexer.js';

export interface SoMMarker {
  id: string; // e.g. "1", "2"
  elementId: string;
  tag: string;
  role?: string;
  bounds: { x: number; y: number; w: number; h: number };
  color: string;
}

export class SoMOverlayGenerator {
  // Vibrant high-contrast color palette for visual grounding
  private static readonly COLOR_PALETTE = [
    '#E11D48', // Rose
    '#2563EB', // Blue
    '#059669', // Emerald
    '#D97706', // Amber
    '#7C3AED', // Violet
    '#0891B2', // Cyan
    '#DC2626', // Red
    '#4F46E5', // Indigo
  ];

  /**
   * Generates in-page script to inject visual bounding boxes and badge numbers
   * on all interactive elements matching the Set-of-Marks paradigm.
   */
  public static getInjectOverlayScript(elements: IndexedElement[]): string {
    const markers: SoMMarker[] = elements.map((el, index) => ({
      id: String(index + 1),
      elementId: el.id,
      tag: el.tag,
      role: el.role,
      bounds: el.bounds,
      color: SoMOverlayGenerator.COLOR_PALETTE[index % SoMOverlayGenerator.COLOR_PALETTE.length]
    }));

    const markersJson = JSON.stringify(markers);

    return `
      (() => {
        // Remove existing overlay container if present
        const existing = document.getElementById('aegis-som-overlay-container');
        if (existing) existing.remove();

        const container = document.createElement('div');
        container.id = 'aegis-som-overlay-container';
        container.style.position = 'fixed';
        container.style.top = '0';
        container.style.left = '0';
        container.style.width = '100vw';
        container.style.height = '100vh';
        container.style.pointerEvents = 'none';
        container.style.zIndex = '2147483647';

        const markers = ${markersJson};

        for (const m of markers) {
          const { x, y, w, h } = m.bounds;
          if (w <= 0 || h <= 0) continue;

          // Box outline
          const box = document.createElement('div');
          box.style.position = 'absolute';
          box.style.left = x + 'px';
          box.style.top = y + 'px';
          box.style.width = w + 'px';
          box.style.height = h + 'px';
          box.style.border = '2px solid ' + m.color;
          box.style.boxSizing = 'border-box';
          box.style.borderRadius = '3px';
          box.style.pointerEvents = 'none';

          // Numeric badge
          const badge = document.createElement('div');
          badge.innerText = m.id;
          badge.style.position = 'absolute';
          badge.style.left = (x - 2) + 'px';
          badge.style.top = Math.max(0, y - 18) + 'px';
          badge.style.backgroundColor = m.color;
          badge.style.color = '#FFFFFF';
          badge.style.fontSize = '11px';
          badge.style.fontWeight = '700';
          badge.style.fontFamily = 'monospace, sans-serif';
          badge.style.padding = '1px 5px';
          badge.style.borderRadius = '3px';
          badge.style.boxShadow = '0 1px 3px rgba(0,0,0,0.5)';
          badge.style.pointerEvents = 'none';

          container.appendChild(box);
          container.appendChild(badge);
        }

        document.documentElement.appendChild(container);
        return markers.length;
      })();
    `;
  }

  /**
   * Generates script to instantly clean up SoM overlays from the page.
   */
  public static readonly REMOVE_OVERLAY_SCRIPT = `
    (() => {
      const container = document.getElementById('aegis-som-overlay-container');
      if (container) {
        container.remove();
        return true;
      }
      return false;
    })();
  `;
}
