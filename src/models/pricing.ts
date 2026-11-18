/**
 * Project Aegis - Model Pricing and Usage Ledger
 * Implements: Issue #132 [MDL-05] Real usage, cost and budget accounting
 */

export interface ModelPricing {
  promptPricePerMillion: number;
  completionPricePerMillion: number;
}

export const MODEL_PRICING_TABLE: Record<string, ModelPricing> = {
  'gemini-2.0-flash': {
    promptPricePerMillion: 0.10,
    completionPricePerMillion: 0.40
  },
  'gemini-1.5-pro': {
    promptPricePerMillion: 1.25,
    completionPricePerMillion: 5.00
  },
  'gpt-4o': {
    promptPricePerMillion: 2.50,
    completionPricePerMillion: 10.00
  },
  'gpt-4o-mini': {
    promptPricePerMillion: 0.15,
    completionPricePerMillion: 0.60
  },
  'claude-3-5-sonnet': {
    promptPricePerMillion: 3.00,
    completionPricePerMillion: 15.00
  },
  // Local models cost zero API fees
  'deepseek-r1': {
    promptPricePerMillion: 0,
    completionPricePerMillion: 0
  },
  'deepseek-r1:8b': {
    promptPricePerMillion: 0,
    completionPricePerMillion: 0
  },
  'mock-model': {
    promptPricePerMillion: 0,
    completionPricePerMillion: 0
  }
};

export class UsageLedger {
  private promptTokensTotal = 0;
  private completionTokensTotal = 0;
  private costTotal = 0;

  public recordUsage(modelName: string, promptTokens: number, completionTokens: number): {
    tokensTotal: number;
    costTotal: number;
    stepCost: number;
  } {
    this.promptTokensTotal += promptTokens;
    this.completionTokensTotal += completionTokens;

    const pricing = MODEL_PRICING_TABLE[modelName] || {
      promptPricePerMillion: 0,
      completionPricePerMillion: 0
    };

    const stepCost =
      (promptTokens / 1_000_000) * pricing.promptPricePerMillion +
      (completionTokens / 1_000_000) * pricing.completionPricePerMillion;

    this.costTotal += stepCost;

    return {
      tokensTotal: this.promptTokensTotal + this.completionTokensTotal,
      costTotal: this.costTotal,
      stepCost
    };
  }

  public getSummary(): {
    promptTokens: number;
    completionTokens: number;
    tokensTotal: number;
    costTotal: number;
  } {
    return {
      promptTokens: this.promptTokensTotal,
      completionTokens: this.completionTokensTotal,
      tokensTotal: this.promptTokensTotal + this.completionTokensTotal,
      costTotal: this.costTotal
    };
  }

  public reset(): void {
    this.promptTokensTotal = 0;
    this.completionTokensTotal = 0;
    this.costTotal = 0;
  }
}
