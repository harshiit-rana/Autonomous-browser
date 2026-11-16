/**
 * Project Aegis - Accessibility WCAG 2.1 AA Compliance & Screen Reader Audit Tool
 * 
 * Implements:
 * - Issue #98: LOC-02 Accessibility WCAG 2.1 AA Compliance & Screen Reader Audit Tool
 */

export interface AccessibilityViolation {
  criterion: 'img-alt' | 'form-label' | 'interactive-role' | 'heading-order' | 'color-contrast';
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  selector: string;
  message: string;
}

export interface AccessibilityAuditReport {
  url: string;
  score: number; // 0 to 100
  wcagCompliant: boolean;
  totalViolations: number;
  violations: AccessibilityViolation[];
}

export class AccessibilityAuditor {
  /**
   * Browser script to run automated WCAG 2.1 AA compliance audit.
   */
  public static readonly DOM_AUDIT_SCRIPT = `
    (() => {
      const violations = [];

      // 1. Missing Image Alt Text
      const images = document.querySelectorAll('img');
      images.forEach((img, idx) => {
        if (!img.hasAttribute('alt')) {
          const sel = img.id ? '#' + img.id : (img.src ? 'img[src*="' + img.src.slice(-20) + '"]' : 'img[' + idx + ']');
          violations.push({
            criterion: 'img-alt',
            severity: 'critical',
            selector: sel,
            message: 'Image lacks required alt attribute for screen readers.'
          });
        }
      });

      // 2. Unlabeled Form Fields
      const inputs = document.querySelectorAll('input:not([type="hidden"]), textarea, select');
      inputs.forEach((input, idx) => {
        const id = input.id;
        const hasAriaLabel = input.hasAttribute('aria-label') || input.hasAttribute('aria-labelledby');
        const hasAssociatedLabel = id ? document.querySelector('label[for="' + id + '"]') !== null : false;

        if (!hasAriaLabel && !hasAssociatedLabel) {
          const sel = id ? '#' + id : 'input[' + idx + ']';
          violations.push({
            criterion: 'form-label',
            severity: 'critical',
            selector: sel,
            message: 'Form control lacks accessible label or associated <label> element.'
          });
        }
      });

      // 3. Non-Semantic Clickables
      const clickables = document.querySelectorAll('div[onclick], span[onclick]');
      clickables.forEach((el, idx) => {
        const role = el.getAttribute('role');
        const tabindex = el.getAttribute('tabindex');
        if (!role || tabindex === null) {
          violations.push({
            criterion: 'interactive-role',
            severity: 'serious',
            selector: el.id ? '#' + el.id : el.tagName.toLowerCase() + '[' + idx + ']',
            message: 'Interactive element missing ARIA role="button" or tabindex for keyboard navigation.'
          });
        }
      });

      // Compute score: baseline 100, deduction per violation
      let deductions = 0;
      violations.forEach(v => {
        if (v.severity === 'critical') deductions += 15;
        else if (v.severity === 'serious') deductions += 8;
        else deductions += 4;
      });

      const score = Math.max(0, 100 - deductions);

      return {
        url: window.location.href,
        score,
        wcagCompliant: score >= 90 && violations.filter(v => v.severity === 'critical').length === 0,
        totalViolations: violations.length,
        violations
      };
    })();
  `;
}
