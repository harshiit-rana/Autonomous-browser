/**
 * Project Aegis - Autonomous Form & Document Workflows (Issue #184 - [DAT-04])
 * 
 * Features:
 * - Semantic form field mapping (autocomplete tokens, label matching, aria attributes)
 * - Honeypot detection: skips hidden, off-screen, or zero-dimension trap fields
 * - Multi-step wizard progression with inline error correction loops
 * - Pre-submission review card: presents diff of proposed form values for explicit approval
 * - Legal & terms attestation gating: never auto-accepts "I certify..." or binding terms
 */

import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('autonomous-forms');

export interface FormFieldDescriptor {
  id: string;
  name: string;
  type: string;
  label?: string;
  autocomplete?: string;
  placeholder?: string;
  required: boolean;
  isHoneypot: boolean;
  isLegalAttestation: boolean;
}

export interface FormReviewSummary {
  formId: string;
  targetUrl: string;
  fields: Array<{ fieldId: string; label: string; proposedValue: string }>;
  requiresHumanApproval: boolean;
  legalTermsDetected: boolean;
}

export class AutonomousFormFiller {
  /**
   * Identifies honeypot trap fields in DOM forms:
   * Hidden via CSS (display:none, visibility:hidden, opacity:0), zero dimensions,
   * or deceptive trap labels (e.g. 'do_not_fill', 'website_hp', 'leave_blank')
   */
  public static isHoneypot(field: {
    name?: string;
    id?: string;
    style?: string;
    ariaHidden?: boolean;
    tabIndex?: number;
    bounds?: { width: number; height: number };
  }): boolean {
    const nameOrId = `${field.name || ''} ${field.id || ''}`.toLowerCase();
    if (/\b(?:honeypot|hp|leave_blank|do_not_fill|fake_email)\b/i.test(nameOrId)) {
      return true;
    }

    if (field.ariaHidden === true || field.tabIndex === -1) {
      return true;
    }

    if (field.bounds && (field.bounds.width <= 0 || field.bounds.height <= 0)) {
      return true;
    }

    if (field.style) {
      const s = field.style.toLowerCase().replace(/\s/g, '');
      if (s.includes('display:none') || s.includes('visibility:hidden') || s.includes('opacity:0')) {
        return true;
      }
    }

    return false;
  }

  /**
   * Detects whether a checkbox or field represents a legal certification or binding terms
   */
  public static isLegalAttestation(labelOrText: string): boolean {
    if (!labelOrText) return false;
    return /\b(?:i\s+agree|i\s+certify|i\s+accept|terms\s+(?:and|&)\s+conditions|privacy\s+policy|under\s+penalty\s+of\s+perjury)\b/i.test(labelOrText);
  }

  /**
   * Maps user profile values to form fields using autocomplete and semantic labels
   */
  public static mapFormFields(
    fields: FormFieldDescriptor[],
    userProfile: Record<string, string>
  ): Map<string, string> {
    const plannedInputs = new Map<string, string>();

    for (const field of fields) {
      // 1. Skip honeypots
      if (field.isHoneypot) {
        logger.info('Skipping honeypot field', { fieldId: field.id, name: field.name });
        continue;
      }

      // 2. Check autocomplete attribute
      if (field.autocomplete && userProfile[field.autocomplete]) {
        plannedInputs.set(field.id, userProfile[field.autocomplete]);
        continue;
      }

      // 3. Check name or label heuristics
      const semanticKey = `${field.label || ''} ${field.name} ${field.placeholder || ''}`.toLowerCase();

      if (/email/i.test(semanticKey) && userProfile.email) {
        plannedInputs.set(field.id, userProfile.email);
      } else if (/(?:first.*name|fname)/i.test(semanticKey) && userProfile.firstName) {
        plannedInputs.set(field.id, userProfile.firstName);
      } else if (/(?:last.*name|lname)/i.test(semanticKey) && userProfile.lastName) {
        plannedInputs.set(field.id, userProfile.lastName);
      } else if (/(?:phone|mobile|tel)/i.test(semanticKey) && userProfile.phone) {
        plannedInputs.set(field.id, userProfile.phone);
      } else if (/(?:street|address)/i.test(semanticKey) && userProfile.address) {
        plannedInputs.set(field.id, userProfile.address);
      } else if (/(?:city)/i.test(semanticKey) && userProfile.city) {
        plannedInputs.set(field.id, userProfile.city);
      } else if (/(?:zip|postal)/i.test(semanticKey) && userProfile.zip) {
        plannedInputs.set(field.id, userProfile.zip);
      }
    }

    return plannedInputs;
  }

  /**
   * Generates a pre-submission review summary for human approval
   */
  public static generateReviewSummary(params: {
    formId: string;
    targetUrl: string;
    fields: FormFieldDescriptor[];
    plannedInputs: Map<string, string>;
  }): FormReviewSummary {
    const summaryFields: FormReviewSummary['fields'] = [];
    let hasLegalTerms = false;

    for (const f of params.fields) {
      if (f.isLegalAttestation) {
        hasLegalTerms = true;
      }

      const val = params.plannedInputs.get(f.id);
      if (val !== undefined) {
        summaryFields.push({
          fieldId: f.id,
          label: f.label || f.name,
          proposedValue: val
        });
      }
    }

    return {
      formId: params.formId,
      targetUrl: params.targetUrl,
      fields: summaryFields,
      requiresHumanApproval: hasLegalTerms || summaryFields.length > 0,
      legalTermsDetected: hasLegalTerms
    };
  }
}
