/**
 * Project Aegis - Model Pricing and Usage Ledger
 * Implements: Issue #132 [MDL-05] Real usage, cost and budget accounting
 */

export interface ModelPricing {
  promptPricePerMillion: number;
  completionPricePerMillion: number;
  cacheReadPricePerMillion?: number;
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
  'claude-3-7-sonnet': {
    promptPricePerMillion: 3.00,
    completionPricePerMillion: 15.00,
    cacheReadPricePerMillion: 0.30
  },
  'claude-3-7-sonnet-latest': {
    promptPricePerMillion: 3.00,
    completionPricePerMillion: 15.00,
    cacheReadPricePerMillion: 0.30
  },
  'claude-3-5-sonnet': {
    promptPricePerMillion: 3.00,
    completionPricePerMillion: 15.00,
    cacheReadPricePerMillion: 0.30
  },
  'claude-3-5-sonnet-latest': {
    promptPricePerMillion: 3.00,
    completionPricePerMillion: 15.00,
    cacheReadPricePerMillion: 0.30
  },
  'claude-3-5-haiku': {
    promptPricePerMillion: 0.80,
    completionPricePerMillion: 4.00,
    cacheReadPricePerMillion: 0.08
  },
  'claude-3-5-haiku-latest': {
    promptPricePerMillion: 0.80,
    completionPricePerMillion: 4.00,
    cacheReadPricePerMillion: 0.08
  },
  'claude-3-opus': {
    promptPricePerMillion: 15.00,
    completionPricePerMillion: 75.00,
    cacheReadPricePerMillion: 1.50
  },
  'claude-3-opus-latest': {
    promptPricePerMillion: 15.00,
    completionPricePerMillion: 75.00,
    cacheReadPricePerMillion: 1.50
  },
  // Local models cost zero API fees
  'deepseek-r1': {
    promptPricePerMillion: 0,
    completionPricePerMillion: 0
  },
  'deepseek-r1:8b': {
    promptPricePerMillion: 0,
    completionPricePerMillion: 0
  }
};

/**
 * Tokens assumed for one agent step in the first-run cost estimate. The prompt carries the page snapshot plus history,
 * the completion is one tool call. These are round planning figures, not measurements; the UI states them next to the price.
 */
export const ASSUMED_STEP_PROMPT_TOKENS = 6000;
export const ASSUMED_STEP_COMPLETION_TOKENS = 400;

export interface StepCostEstimate {
  /** null when the model has no entry in MODEL_PRICING_TABLE: the UI shows "no pricing data" instead of a guess. */
  costUSD: number | null;
  promptTokens: number;
  completionTokens: number;
}

export function estimateStepCost(modelName: string): StepCostEstimate {
  const pricing = MODEL_PRICING_TABLE[modelName];
  const promptTokens = ASSUMED_STEP_PROMPT_TOKENS;
  const completionTokens = ASSUMED_STEP_COMPLETION_TOKENS;
  if (!pricing) return { costUSD: null, promptTokens, completionTokens };
  const costUSD =
    (promptTokens / 1_000_000) * pricing.promptPricePerMillion +
    (completionTokens / 1_000_000) * pricing.completionPricePerMillion;
  return { costUSD, promptTokens, completionTokens };
}

export class UsageLedger {
  private promptTokensTotal = 0;
  private completionTokensTotal = 0;
  private cacheReadTokensTotal = 0;
  private costTotal = 0;

  public recordUsage(
    modelName: string,
    promptTokens: number,
    completionTokens: number,
    cacheReadTokens: number = 0
  ): {
    tokensTotal: number;
    costTotal: number;
    stepCost: number;
  } {
    this.promptTokensTotal += promptTokens;
    this.completionTokensTotal += completionTokens;
    this.cacheReadTokensTotal += cacheReadTokens;

    const pricing = MODEL_PRICING_TABLE[modelName] || {
      promptPricePerMillion: 2.0,
      completionPricePerMillion: 10.0
    };

    const regularPromptTokens = Math.max(0, promptTokens - cacheReadTokens);
    const cachePrice = pricing.cacheReadPricePerMillion ?? (pricing.promptPricePerMillion * 0.1);

    const stepCost =
      (regularPromptTokens / 1_000_000) * pricing.promptPricePerMillion +
      (cacheReadTokens / 1_000_000) * cachePrice +
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

  public getTotalCost(): number {
    return this.costTotal;
  }

  public reset(): void {
    this.promptTokensTotal = 0;
    this.completionTokensTotal = 0;
    this.costTotal = 0;
  }
}
