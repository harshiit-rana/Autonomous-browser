/**
 * Project Aegis - Data Clean-Room Sanitizer (PII & Enterprise Compliance Stripping)
 * 
 * Implements:
 * - Issue #84: DATA-08 Data Clean-Room Sanitizer (PII & Enterprise Compliance Stripping)
 */

export interface SanitizerOptions {
  stripSSN?: boolean;
  stripCreditCards?: boolean;
  stripApiKeys?: boolean;
  stripEmails?: boolean;
  stripPhoneNumbers?: boolean;
}

export class DataCleanRoomSanitizer {
  // Regex definitions
  private static readonly SSN_REGEX = /\b(?!000|666|9\d{2})\d{3}[- ]?(?!00)\d{2}[- ]?(?!0000)\d{4}\b/g;
  private static readonly CC_REGEX = /\b(?:\d{4}[- ]?){3}\d{4}\b|\b\d{15,16}\b/g;
  private static readonly API_KEY_REGEX = /\b(?:sk-[a-zA-Z0-9_-]{24,}|ghp_[a-zA-Z0-9]{36}|AKIA[0-9A-Z]{16}|bearer\s+[a-zA-Z0-9._-]{30,})\b/gi;
  private static readonly EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b/g;
  private static readonly PHONE_REGEX = /\b(?:\+?1[-. ]?)?\(?([0-9]{3})\)?[-. ]?([0-9]{3})[-. ]?([0-9]{4})\b/g;

  /**
   * Sanitizes text by stripping out sensitive enterprise PII and secrets.
   */
  public static sanitize(text: string, options: SanitizerOptions = {}): { sanitizedText: string; redactedCount: number } {
    let result = text;
    let redactedCount = 0;

    const countMatches = (regex: RegExp) => {
      const matches = result.match(regex);
      return matches ? matches.length : 0;
    };

    if (options.stripSSN !== false) {
      redactedCount += countMatches(DataCleanRoomSanitizer.SSN_REGEX);
      result = result.replace(DataCleanRoomSanitizer.SSN_REGEX, '[REDACTED_SSN]');
    }

    if (options.stripCreditCards !== false) {
      redactedCount += countMatches(DataCleanRoomSanitizer.CC_REGEX);
      result = result.replace(DataCleanRoomSanitizer.CC_REGEX, '[REDACTED_CREDIT_CARD]');
    }

    if (options.stripApiKeys !== false) {
      redactedCount += countMatches(DataCleanRoomSanitizer.API_KEY_REGEX);
      result = result.replace(DataCleanRoomSanitizer.API_KEY_REGEX, '[REDACTED_API_KEY]');
    }

    if (options.stripEmails) {
      redactedCount += countMatches(DataCleanRoomSanitizer.EMAIL_REGEX);
      result = result.replace(DataCleanRoomSanitizer.EMAIL_REGEX, '[REDACTED_EMAIL]');
    }

    if (options.stripPhoneNumbers) {
      redactedCount += countMatches(DataCleanRoomSanitizer.PHONE_REGEX);
      result = result.replace(DataCleanRoomSanitizer.PHONE_REGEX, '[REDACTED_PHONE]');
    }

    return { sanitizedText: result, redactedCount };
  }
}
