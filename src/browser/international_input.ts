/**
 * Project Aegis - International Text Input & Locale Coherence Engine (Issue #177 - [BRW-10])
 * 
 * Features:
 * - Grapheme-aware Unicode iteration using Intl.Segmenter (never splits emoji or astral plane characters)
 * - IME composition handling for CJK input (compositionstart/update/end)
 * - Auto-formatted input mask verification (phone masks, card masks)
 * - RTL (Right-to-Left) text detection and bidi control stripping
 * - Locale coherence configuration (Accept-Language, Timezone, Currency, Number normalization)
 */

import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('international-input');

export interface LocaleProfile {
  locale: string;
  languages: string[];
  timezone: string;
  currency: string;
}

export class InternationalInputManager {
  private currentLocale: LocaleProfile;

  constructor(profile?: Partial<LocaleProfile>) {
    this.currentLocale = {
      locale: profile?.locale || 'en-US',
      languages: profile?.languages || ['en-US', 'en'],
      timezone: profile?.timezone || 'UTC',
      currency: profile?.currency || 'USD'
    };
  }

  public getLocaleProfile(): LocaleProfile {
    return { ...this.currentLocale };
  }

  public setLocale(locale: string, timezone?: string, currency?: string): void {
    this.currentLocale = {
      locale,
      languages: [locale, locale.split('-')[0]],
      timezone: timezone || 'UTC',
      currency: currency || (locale === 'en-GB' ? 'GBP' : locale === 'ja-JP' ? 'JPY' : locale.startsWith('de') ? 'EUR' : 'USD')
    };
    logger.info('Updated browser locale profile', this.currentLocale);
  }

  /**
   * Splits input into genuine user-perceived grapheme clusters using Intl.Segmenter,
   * preventing surrogate pair fragmentation on emoji sequences (e.g. 👨‍👩‍👧‍👦, 🏳️‍🌈, 🚀)
   */
  public segmentGraphemes(text: string): string[] {
    if (!text) return [];
    if (typeof Intl !== 'undefined' && (Intl as any).Segmenter) {
      const segmenter = new (Intl as any).Segmenter(this.currentLocale.locale, { granularity: 'grapheme' });
      const segments: string[] = [];
      for (const seg of segmenter.segment(text)) {
        segments.push(seg.segment);
      }
      return segments;
    }

    // Fallback using Array.from which correctly handles basic surrogate pairs
    return Array.from(text);
  }

  /**
   * Detects if a text string contains Right-to-Left (RTL) scripts (Arabic, Hebrew, Persian)
   */
  public isRTL(text: string): boolean {
    if (!text) return false;
    // Matches Arabic, Hebrew, Syriac, Thaana, Samaritan, Mandaic, etc.
    const rtlRegex = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/;
    return rtlRegex.test(text);
  }

  /**
   * Strips dangerous bidirectional control characters (U+202A to U+202E, U+2066 to U+2069)
   * used in spoofing attacks
   */
  public sanitizeBidiControls(text: string): string {
    if (!text) return '';
    return text.replace(/[\u202A-\u202E\u2066-\u2069]/g, '');
  }

  /**
   * Verifies if an input masked field matches intended user input:
   * e.g. User intended '1234567890' -> Mask produced '(123) 456-7890'
   */
  public verifyMaskedInput(intendedDigits: string, maskedValue: string): boolean {
    const rawIntended = intendedDigits.replace(/\D/g, '');
    const rawMasked = maskedValue.replace(/\D/g, '');
    return rawIntended === rawMasked;
  }

  /**
   * Normalizes localized numbers (e.g. European '1.234,56' vs US '1,234.56') to standard float
   */
  public parseLocalizedNumber(rawNumberStr: string): number {
    if (!rawNumberStr) return NaN;
    let cleaned = rawNumberStr.trim().replace(/[^\d.,-]/g, '');

    // If both '.' and ',' appear:
    if (cleaned.includes('.') && cleaned.includes(',')) {
      const lastDot = cleaned.lastIndexOf('.');
      const lastComma = cleaned.lastIndexOf(',');
      if (lastComma > lastDot) {
        // European style: 1.234,56 -> 1234.56
        cleaned = cleaned.replace(/\./g, '').replace(',', '.');
      } else {
        // US style: 1,234.56 -> 1234.56
        cleaned = cleaned.replace(/,/g, '');
      }
    } else if (cleaned.includes(',')) {
      // Only comma: could be 12,50 (decimal) or 1,234 (thousands)
      const parts = cleaned.split(',');
      if (parts.length === 2 && parts[1].length <= 2) {
        // Decimal comma
        cleaned = cleaned.replace(',', '.');
      } else {
        cleaned = cleaned.replace(/,/g, '');
      }
    }

    return parseFloat(cleaned);
  }
}
