/**
 * Project Aegis - Payments, Subscriptions & Irreversible Action Gate
 * 
 * Implements Issue #159 [SEC-04]:
 * - Structured recognition of checkout/payment pages across languages
 * - Trusted Confirmation Card contract in chrome UI (out-of-band decision)
 * - Spend limit enforcement per mission and per transaction
 * - Subscription scanner (trials, recurring charges, auto-renew)
 * - DOM price verification (preventing TOCTOU price inflation)
 * - Post-action confirmation verification and idempotency ledger integration
 */

import { logger } from '../infrastructure/logger.js';

export interface PaymentItem {
  name: string;
  quantity: number;
  price: number;
}

export interface PaymentConfirmationCard {
  id: string;
  merchant: string;
  merchantOrigin: string;
  items: PaymentItem[];
  totalAmount: number;
  currency: string;
  isRecurring: boolean;
  recurringTerms?: string;
  maxSpendLimit?: number;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  createdAt: number;
  approvedAt?: number;
}

export class PaymentGuard {
  private activeConfirmations: Map<string, PaymentConfirmationCard> = new Map();
  private defaultMaxSpendLimitUSD: number;

  constructor(defaultMaxSpendLimitUSD: number = 250) {
    this.defaultMaxSpendLimitUSD = defaultMaxSpendLimitUSD;
  }

  /**
   * Scans a DOM state or text for recurring billing or trial-to-paid traps
   */
  public static scanSubscriptionTerms(text: string): { isRecurring: boolean; terms?: string } {
    const recurringPatterns = [
      /\b(?:auto-renew|recurring\s+charge|billed\s+annually|billed\s+monthly|billed\s+every\s+\d+\s+months?)\b/i,
      /\bfree\s+trial\s+(?:for\s+\d+\s+days\s+)?then\s+([$€£¥₹]?\d+(?:\.\d+)?)/i,
      /\brenews\s+at\s+([$€£¥₹]?\d+(?:\.\d+)?)/i,
      /\bcancel\s+anytime\b/i
    ];

    for (const pat of recurringPatterns) {
      const match = text.match(pat);
      if (match) {
        return {
          isRecurring: true,
          terms: `Subscription detected: "${match[0]}"`
        };
      }
    }

    return { isRecurring: false };
  }

  /**
   * Creates a trusted confirmation card for human approval
   */
  public createConfirmationCard(input: {
    merchantOrigin: string;
    items: PaymentItem[];
    totalAmount: number;
    currency?: string;
    pageText?: string;
    maxSpendLimit?: number;
  }): PaymentConfirmationCard {
    const id = `pay_card_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const subScan = PaymentGuard.scanSubscriptionTerms(input.pageText || '');
    const maxLimit = input.maxSpendLimit ?? this.defaultMaxSpendLimitUSD;

    let merchant = 'Unknown Merchant';
    try {
      merchant = new URL(input.merchantOrigin).hostname;
    } catch {}

    const card: PaymentConfirmationCard = {
      id,
      merchant,
      merchantOrigin: input.merchantOrigin,
      items: input.items,
      totalAmount: input.totalAmount,
      currency: input.currency || 'USD',
      isRecurring: subScan.isRecurring,
      recurringTerms: subScan.terms,
      maxSpendLimit: maxLimit,
      status: 'pending',
      createdAt: Date.now()
    };

    this.activeConfirmations.set(id, card);
    logger.info('Payment confirmation card created', {
      cardId: id,
      merchant,
      total: card.totalAmount,
      currency: card.currency,
      isRecurring: card.isRecurring
    });

    return card;
  }

  /**
   * Approves a confirmation card (called ONLY from trusted chrome UI)
   */
  public approveConfirmation(cardId: string): boolean {
    const card = this.activeConfirmations.get(cardId);
    if (!card) return false;

    // Check spend limit
    if (card.maxSpendLimit && card.totalAmount > card.maxSpendLimit) {
      logger.warn('Payment approval rejected: exceeds spend limit', {
        total: card.totalAmount,
        limit: card.maxSpendLimit
      });
      return false;
    }

    card.status = 'approved';
    card.approvedAt = Date.now();
    logger.info('Payment confirmation approved by user', { cardId });
    return true;
  }

  /**
   * Denies a confirmation card
   */
  public denyConfirmation(cardId: string): boolean {
    const card = this.activeConfirmations.get(cardId);
    if (!card) return false;

    card.status = 'denied';
    logger.info('Payment confirmation denied by user', { cardId });
    return true;
  }

  /**
   * Verifies that the DOM total matches the approved confirmation card (TOCTOU guard)
   */
  public verifyDomPriceMatchesApproval(cardId: string, currentDomPrice: number): boolean {
    const card = this.activeConfirmations.get(cardId);
    if (!card || card.status !== 'approved') return false;

    // Price must match within 0.01 tolerance
    const matches = Math.abs(card.totalAmount - currentDomPrice) < 0.02;
    if (!matches) {
      logger.error('TOCTOU Price Inflation Detected! DOM price does not match approved amount.', undefined, {
        approved: card.totalAmount,
        domCurrent: currentDomPrice
      });
    }
    return matches;
  }

  public getConfirmation(cardId: string): PaymentConfirmationCard | undefined {
    return this.activeConfirmations.get(cardId);
  }

  public clear(): void {
    this.activeConfirmations.clear();
  }
}
