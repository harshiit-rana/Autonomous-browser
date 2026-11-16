/**
 * Project Aegis - Autonomous Form Filler with Smart Context Synthesis
 * 
 * Implements:
 * - Issue #92: AUTO-08 Autonomous Form Filler with Smart Context Synthesis
 */

import { IndexedElement } from '../core/dom_indexer.js';

export interface UserFormProfile {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  email?: string;
  phone?: string;
  company?: string;
  jobTitle?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  customFields?: Record<string, string>;
}

export interface FormFillPlan {
  elementId: string;
  fieldName: string;
  suggestedValue: string;
  confidence: number;
}

export class AutonomousFormFiller {
  /**
   * Synthesizes an intelligent form-filling plan based on user profile and DOM field clues.
   */
  public static planFill(elements: IndexedElement[], profile: UserFormProfile): FormFillPlan[] {
    const plans: FormFillPlan[] = [];
    const inputs = elements.filter(el => ['input', 'textarea', 'select'].includes(el.tag));

    for (const el of inputs) {
      const clue = `${el.id} ${el.label || ''} ${el.type || ''}`.toLowerCase();
      let matchedValue: string | undefined;
      let fieldName = 'unknown';
      let confidence = 0.5;

      if (/email|e-mail/i.test(clue)) {
        matchedValue = profile.email;
        fieldName = 'email';
        confidence = 0.95;
      } else if (/first[_\s-]?name|fname/i.test(clue)) {
        matchedValue = profile.firstName;
        fieldName = 'firstName';
        confidence = 0.9;
      } else if (/last[_\s-]?name|lname|surname/i.test(clue)) {
        matchedValue = profile.lastName;
        fieldName = 'lastName';
        confidence = 0.9;
      } else if (/full[_\s-]?name|your[_\s-]?name/i.test(clue)) {
        matchedValue = profile.fullName || `${profile.firstName || ''} ${profile.lastName || ''}`.trim();
        fieldName = 'fullName';
        confidence = 0.85;
      } else if (/phone|mobile|telephone|cell/i.test(clue)) {
        matchedValue = profile.phone;
        fieldName = 'phone';
        confidence = 0.9;
      } else if (/company|organization|employer/i.test(clue)) {
        matchedValue = profile.company;
        fieldName = 'company';
        confidence = 0.85;
      } else if (/job[_\s-]?title|role|position/i.test(clue)) {
        matchedValue = profile.jobTitle;
        fieldName = 'jobTitle';
        confidence = 0.85;
      } else if (/address|street/i.test(clue)) {
        matchedValue = profile.addressLine1;
        fieldName = 'address';
        confidence = 0.8;
      } else if (/city|town/i.test(clue)) {
        matchedValue = profile.city;
        fieldName = 'city';
        confidence = 0.85;
      } else if (/zip|postal/i.test(clue)) {
        matchedValue = profile.postalCode;
        fieldName = 'postalCode';
        confidence = 0.9;
      }

      if (matchedValue) {
        plans.push({
          elementId: el.id,
          fieldName,
          suggestedValue: matchedValue,
          confidence
        });
      }
    }

    return plans;
  }
}
