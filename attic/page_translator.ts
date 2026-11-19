/**
 * Project Aegis - Autonomous Multi-Lingual Page Translation & Context Normalization
 * 
 * Implements:
 * - Issue #97: LOC-01 Autonomous Multi-Lingual Page Translation & Context Normalization
 */

export interface DetectedLanguage {
  code: string;
  name: string;
  confidence: number;
}

export class PageTranslator {
  /**
   * Fast client-side language script detector based on Unicode ranges.
   */
  public static detectLanguage(text: string): DetectedLanguage {
    const trimmed = text.slice(0, 1000);
    let cjkCount = 0;
    let cyrillicCount = 0;
    let arabicCount = 0;
    let devanagariCount = 0;
    let latinCount = 0;

    for (let i = 0; i < trimmed.length; i++) {
      const code = trimmed.charCodeAt(i);
      if (code >= 0x4E00 && code <= 0x9FFF) cjkCount++;
      else if (code >= 0x0400 && code <= 0x04FF) cyrillicCount++;
      else if (code >= 0x0600 && code <= 0x06FF) arabicCount++;
      else if (code >= 0x0900 && code <= 0x097F) devanagariCount++;
      else if ((code >= 0x0041 && code <= 0x005A) || (code >= 0x0061 && code <= 0x007A)) latinCount++;
    }

    const total = cjkCount + cyrillicCount + arabicCount + devanagariCount + latinCount;
    if (total === 0) return { code: 'en', name: 'English', confidence: 1.0 };

    if (cjkCount / total > 0.3) return { code: 'zh', name: 'Chinese/Japanese', confidence: cjkCount / total };
    if (cyrillicCount / total > 0.3) return { code: 'ru', name: 'Russian/Cyrillic', confidence: cyrillicCount / total };
    if (arabicCount / total > 0.3) return { code: 'ar', name: 'Arabic', confidence: arabicCount / total };
    if (devanagariCount / total > 0.3) return { code: 'hi', name: 'Hindi', confidence: devanagariCount / total };

    return { code: 'en', name: 'English/Latin', confidence: latinCount / total };
  }
}
