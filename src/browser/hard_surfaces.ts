/**
 * Project Aegis - Hard Surfaces Escalation Engine (Issue #176 - [BRW-09])
 * 
 * Implements multi-tier escalation strategy for canvas-rendered apps,
 * Google Docs/Sheets, WebGL, video players, maps, and rich editors:
 * 
 * - Tier 1: Accessibility Tree (Accessibility.getFullAXTree)
 * - Tier 2: DOM Text Layers / Hidden Buffers (Google Docs kix-line, canvas text buffers)
 * - Tier 3: Vision Grounding with DPR and Zoom Scaling
 * - Tier 4: Local OCR Fallback
 * - Video/Audio controls & caption transcript extraction
 */

import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('hard-surfaces');

export type SurfaceTier = 'a11y_tree' | 'dom_buffers' | 'vision_grounding' | 'ocr_fallback';

export interface HardSurfaceAnalysis {
  tier: SurfaceTier;
  hasCanvas: boolean;
  hasVideo: boolean;
  isDocsOrSheets: boolean;
  recommendedStrategy: string;
}

export interface ScaledCoordinate {
  pixelX: number;
  pixelY: number;
  dpr: number;
  zoomFactor: number;
}

export class HardSurfaceHandler {
  /**
   * Analyzes page DOM facts to detect hard surfaces (canvas, WebGL, Docs, video)
   */
  public analyzeSurface(facts: {
    url: string;
    canvasCount: number;
    videoCount: number;
    domElementCount: number;
    hasAccessibilityNodes: boolean;
  }): HardSurfaceAnalysis {
    const isDocs = facts.url.includes('docs.google.com') || facts.url.includes('sheets.google.com');
    const hasCanvas = facts.canvasCount > 0;
    const hasVideo = facts.videoCount > 0;

    let tier: SurfaceTier = 'a11y_tree';
    let strategy = 'Standard DOM accessibility targeting';

    if (isDocs) {
      tier = 'dom_buffers';
      strategy = 'Keyboard shortcuts and hidden editor buffer text extraction';
    } else if (hasCanvas && facts.domElementCount < 20) {
      // Pure canvas app (Figma, map, game)
      tier = 'vision_grounding';
      strategy = 'Vision model coordinate targeting with DPR/zoom scaling';
    } else if (hasCanvas && !facts.hasAccessibilityNodes) {
      tier = 'ocr_fallback';
      strategy = 'OCR fallback for non-accessible canvas regions';
    }

    logger.info('Hard surface analysis completed', { url: facts.url, tier, strategy });
    return {
      tier,
      hasCanvas,
      hasVideo,
      isDocsOrSheets: isDocs,
      recommendedStrategy: strategy
    };
  }

  /**
   * Translates normalized [0.0 - 1.0] coordinates to exact device pixels
   * taking into account viewport dimensions, zoom level, and Device Pixel Ratio (DPR)
   */
  public scaleCoordinate(
    normX: number,
    normY: number,
    viewportWidth: number,
    viewportHeight: number,
    dpr: number = 1.0,
    zoomFactor: number = 1.0
  ): ScaledCoordinate {
    const clampedX = Math.max(0.0, Math.min(1.0, normX));
    const clampedY = Math.max(0.0, Math.min(1.0, normY));

    // Calculate CSS pixels
    const cssX = clampedX * viewportWidth;
    const cssY = clampedY * viewportHeight;

    // Adjust for zoom factor and DPR
    const pixelX = Math.round((cssX / zoomFactor) * dpr);
    const pixelY = Math.round((cssY / zoomFactor) * dpr);

    return {
      pixelX,
      pixelY,
      dpr,
      zoomFactor
    };
  }

  /**
   * Formats media player captions/subtitles into structured text transcripts
   */
  public static parseVttCaptions(vttContent: string): Array<{ startSec: number; endSec: number; text: string }> {
    const lines = vttContent.split(/\r?\n/);
    const cues: Array<{ startSec: number; endSec: number; text: string }> = [];

    const timeRegex = /(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/;

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(timeRegex);
      if (match) {
        const startSec = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]) + parseInt(match[4]) / 1000;
        const endSec = parseInt(match[5]) * 3600 + parseInt(match[6]) * 60 + parseInt(match[7]) + parseInt(match[8]) / 1000;
        const text = lines[i + 1] ? lines[i + 1].trim() : '';
        if (text) {
          cues.push({ startSec, endSec, text });
        }
      }
    }

    return cues;
  }
}
