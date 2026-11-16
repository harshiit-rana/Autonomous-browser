/**
 * Project Aegis - Clipboard Intelligence Hub (Smart Formats & Code Parsing)
 * 
 * Implements:
 * - Issue #83: DATA-07 Clipboard Intelligence Hub (Smart Formats & Code Parsing)
 */

export interface ClipboardAnalysis {
  detectedType: 'json' | 'code' | 'url' | 'csv' | 'text';
  cleanedText: string;
  metadata?: Record<string, any>;
}

export class ClipboardHub {
  /**
   * Analyzes and intelligently normalizes copied clipboard text.
   */
  public static analyzeAndClean(rawText: string): ClipboardAnalysis {
    const trimmed = rawText.trim();

    // 1. URL Detection & UTM Stripping
    if (/^https?:\/\/[^\s]+$/i.test(trimmed)) {
      try {
        const u = new URL(trimmed);
        const utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'];
        for (const k of utmKeys) {
          u.searchParams.delete(k);
        }
        return {
          detectedType: 'url',
          cleanedText: u.toString(),
          metadata: { host: u.hostname, cleanUrl: true }
        };
      } catch {}
    }

    // 2. JSON Detection
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        const pretty = JSON.stringify(parsed, null, 2);
        return {
          detectedType: 'json',
          cleanedText: pretty,
          metadata: { isArray: Array.isArray(parsed) }
        };
      } catch {}
    }

    // 3. Code Block Detection (strip enclosing markdown code fences)
    const codeFenceMatch = trimmed.match(/^```([a-zA-Z0-9_-]*)\n([\s\S]*?)\n```$/);
    if (codeFenceMatch) {
      return {
        detectedType: 'code',
        cleanedText: codeFenceMatch[2],
        metadata: { language: codeFenceMatch[1] || 'text' }
      };
    }

    // 4. CSV / Tabular detection
    const lines = trimmed.split('\n');
    if (lines.length > 2 && lines.every(l => l.includes('\t') || l.includes(','))) {
      return {
        detectedType: 'csv',
        cleanedText: trimmed,
        metadata: { rowCount: lines.length }
      };
    }

    return {
      detectedType: 'text',
      cleanedText: trimmed
    };
  }
}
