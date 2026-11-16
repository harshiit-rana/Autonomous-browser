/**
 * Project Aegis - Dynamic OCR & Canvas/SVG Text Extraction Fallback
 * 
 * Implements:
 * - Issue #30: PERC-05 Dynamic OCR & Canvas/SVG Text Extraction Fallback
 */

export interface GraphicTextItem {
  type: 'svg_text' | 'canvas' | 'image';
  text: string;
  bounds: { x: number; y: number; w: number; h: number };
}

export class CanvasTextExtractor {
  /**
   * Browser script to extract text rendered in SVGs, canvas, and graphic elements.
   */
  public static readonly EXTRACT_GRAPHIC_TEXT_SCRIPT = `
    (() => {
      const items = [];

      // 1. SVG Text Extraction
      const svgTexts = document.querySelectorAll('svg text, svg tspan');
      for (const el of svgTexts) {
        const text = el.textContent ? el.textContent.trim() : '';
        if (!text) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          items.push({
            type: 'svg_text',
            text,
            bounds: {
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              w: Math.round(rect.width),
              h: Math.round(rect.height)
            }
          });
        }
      }

      // 2. Canvas Elements with aria-label or title
      const canvases = document.querySelectorAll('canvas');
      for (const c of canvases) {
        const label = c.getAttribute('aria-label') || c.getAttribute('title') || '';
        if (label) {
          const rect = c.getBoundingClientRect();
          items.push({
            type: 'canvas',
            text: label,
            bounds: {
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              w: Math.round(rect.width),
              h: Math.round(rect.height)
            }
          });
        }
      }

      return items;
    })();
  `;
}
