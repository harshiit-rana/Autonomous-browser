/**
 * Project Aegis - Security Shield Adapter
 * Re-exports PromptIsolationEngine and provides backward-compatible hardened methods.
 */

import { PageDOMState } from '../core/dom_indexer.js';
import { PromptIsolationEngine } from './prompt_isolation.js';

export interface SanitizedContent {
  rawText: string;
  wrappedPromptContext: string;
  detectedSuspiciousPatterns: string[];
  isQuarantined: boolean;
}

export class SecurityShield {
  private static isolationEngine = new PromptIsolationEngine();

  public static sanitizeWebContent(domState: PageDOMState): SanitizedContent {
    const isolated = this.isolationEngine.isolateDOMState(domState);
    return {
      rawText: domState.elements.map(e => `[${e.id}] <${e.tag}> ${e.label}`).join('\n'),
      wrappedPromptContext: isolated.sanitizedData,
      detectedSuspiciousPatterns: isolated.containsSuspiciousPatterns ? ['Advisory pattern detected'] : [],
      isQuarantined: isolated.containsSuspiciousPatterns
    };
  }

  public static sanitizeString(raw: string): { cleanText: string; isQuarantined: boolean; suspiciousHits: string[] } {
    // Stateless pattern checks (no shared stateful /g RegExp instance)
    const patterns = [
      /\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|above|prior)\s+instructions\b/i,
      /\bsystem\s*(?:prompt|:)\b/i,
      /\byou\s+are\s+now\s+in\s+developer\s+mode\b/i,
      /<!--[\s\S]*?-->/i
    ];

    const hits: string[] = [];
    let clean = raw;
    for (const pat of patterns) {
      if (pat.test(clean)) {
        hits.push(`Trigger '${pat.source}' detected`);
        clean = clean.replace(new RegExp(pat.source, 'gi'), '[REDACTED_PROMPT_INJECTION]');
      }
    }

    const exfil = PromptIsolationEngine.neutralizeExfiltration(clean);
    clean = exfil.cleaned;

    return {
      cleanText: clean,
      isQuarantined: hits.length > 0 || exfil.count > 0,
      suspiciousHits: hits
    };
  }

  public static redactSensitiveValue(tag: string, type: string, value: string, nameOrAutocomplete?: string): string {
    const combined = `${type || ''} ${nameOrAutocomplete || ''}`.toLowerCase();
    if (type === 'password' || /cvv|creditcard|card-number|cc-number|ssn|secret|password|token/i.test(combined)) {
      return '[REDACTED_SENSITIVE_FIELD]';
    }
    return value;
  }
}
