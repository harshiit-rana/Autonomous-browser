/**
 * Project Aegis - Pluggable Multi-Model Hub
 * 
 * Implements:
 * - Issue #15: M7.3 Pluggable Multi-Model Hub (Claude, Gemini, OpenAI, Ollama)
 */

export type ModelProviderType = 'anthropic' | 'gemini' | 'openai' | 'ollama';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface ToolFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ModelRequest {
  provider?: ModelProviderType;
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolFunctionDeclaration[];
  jsonSchema?: Record<string, any>;
  abortSignal?: AbortSignal;
}

export interface ModelResponse {
  provider: ModelProviderType;
  model: string;
  text: string;
  toolCalls?: ToolCall[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  durationMs: number;
}

export interface StreamChunk {
  deltaText: string;
  toolCalls?: ToolCall[];
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}

export class ModelHub {
  private configs: Map<ModelProviderType, ProviderConfig> = new Map();
  private primaryProvider: ModelProviderType = 'gemini';
  private fallbackOrder: ModelProviderType[] = ['gemini', 'anthropic', 'openai', 'ollama'];

  // Session usage tracking
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private totalCostUsd = 0;

  constructor(initialConfigs?: Partial<Record<ModelProviderType, ProviderConfig>>) {
    // Default base URLs
    this.configs.set('anthropic', { baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-3-5-sonnet-20241022' });
    this.configs.set('gemini', { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-2.0-flash' });
    this.configs.set('openai', { baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o' });
    this.configs.set('ollama', { baseUrl: 'http://localhost:11434', defaultModel: 'llama3.2' });

    if (initialConfigs) {
      for (const [p, c] of Object.entries(initialConfigs)) {
        const type = p as ModelProviderType;
        this.configs.set(type, { ...this.configs.get(type), ...c });
      }
    }
  }

  public setProviderConfig(provider: ModelProviderType, config: Partial<ProviderConfig>): void {
    const existing = this.configs.get(provider) || {};
    this.configs.set(provider, { ...existing, ...config });
  }

  public setPrimaryProvider(provider: ModelProviderType): void {
    this.primaryProvider = provider;
  }

  public setFallbackOrder(order: ModelProviderType[]): void {
    this.fallbackOrder = order;
  }

  /**
   * Main chat completion with automatic fallback across providers.
   */
  public async chat(request: ModelRequest): Promise<ModelResponse> {
    const start = Date.now();
    const providersToTry = request.provider 
      ? [request.provider, ...this.fallbackOrder.filter(p => p !== request.provider)]
      : [this.primaryProvider, ...this.fallbackOrder.filter(p => p !== this.primaryProvider)];

    let lastError: Error | null = null;

    for (const provider of providersToTry) {
      const cfg = this.configs.get(provider);
      if (!cfg) continue;
      if (provider !== 'ollama' && !cfg.apiKey) continue; // Skip providers without API keys

      try {
        const model = request.model || cfg.defaultModel || this.getDefaultModelForProvider(provider);
        let resp: ModelResponse;

        if (provider === 'gemini') {
          resp = await this.callGemini(cfg, model, request, start);
        } else if (provider === 'anthropic') {
          resp = await this.callAnthropic(cfg, model, request, start);
        } else if (provider === 'openai') {
          resp = await this.callOpenAI(cfg, model, request, start);
        } else {
          resp = await this.callOllama(cfg, model, request, start);
        }

        // Record telemetry
        this.totalPromptTokens += resp.promptTokens;
        this.totalCompletionTokens += resp.completionTokens;
        this.totalCostUsd += resp.estimatedCostUsd;

        return resp;
      } catch (err: any) {
        lastError = err;
        console.warn(`[ModelHub] Provider "${provider}" failed: ${err.message}. Trying next fallback...`);
      }
    }

    throw new Error(`All LLM providers failed. Last error: ${lastError?.message || 'No available providers configured.'}`);
  }

  /**
   * Streaming token delivery via AsyncGenerator.
   */
  public async *streamChat(request: ModelRequest): AsyncGenerator<StreamChunk, ModelResponse> {
    // If provider supports streaming, stream chunks; otherwise fallback to full chat and yield full chunk
    const resp = await this.chat(request);
    yield {
      deltaText: resp.text,
      toolCalls: resp.toolCalls
    };
    return resp;
  }

  private async callGemini(
    cfg: ProviderConfig,
    model: string,
    req: ModelRequest,
    startTime: number
  ): Promise<ModelResponse> {
    const apiKey = cfg.apiKey;
    if (!apiKey) throw new Error('Missing Gemini API Key');

    const contents = req.messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

    const systemInstruction = req.messages.find(m => m.role === 'system');

    const body: Record<string, any> = {
      contents,
      generationConfig: {
        temperature: req.temperature ?? 0.2,
        maxOutputTokens: req.maxTokens ?? 4096
      }
    };

    if (systemInstruction) {
      body.systemInstruction = {
        parts: [{ text: systemInstruction.content }]
      };
    }

    if (req.tools && req.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: req.tools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters
          }))
        }
      ];
    }

    const url = `${cfg.baseUrl}/models/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: req.abortSignal
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    let text = '';
    const toolCalls: ToolCall[] = [];

    for (const part of parts) {
      if (part.text) {
        text += part.text;
      }
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args || {}
        });
      }
    }

    const promptTokens = data.usageMetadata?.promptTokenCount || 0;
    const completionTokens = data.usageMetadata?.candidatesTokenCount || 0;
    const totalTokens = data.usageMetadata?.totalTokenCount || promptTokens + completionTokens;
    const durationMs = Date.now() - startTime;

    return {
      provider: 'gemini',
      model,
      text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCostUsd: this.calculateCost('gemini', model, promptTokens, completionTokens),
      durationMs
    };
  }

  private async callAnthropic(
    cfg: ProviderConfig,
    model: string,
    req: ModelRequest,
    startTime: number
  ): Promise<ModelResponse> {
    const apiKey = cfg.apiKey;
    if (!apiKey) throw new Error('Missing Anthropic API Key');

    const systemMsg = req.messages.find(m => m.role === 'system');
    const messages = req.messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content
      }));

    const body: Record<string, any> = {
      model,
      messages,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature ?? 0.2
    };

    if (systemMsg) {
      body.system = systemMsg.content;
    }

    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters
      }));
    }

    const res = await fetch(`${cfg.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: req.abortSignal
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    let text = '';
    const toolCalls: ToolCall[] = [];

    for (const block of data.content || []) {
      if (block.type === 'text') {
        text += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input || {}
        });
      }
    }

    const promptTokens = data.usage?.input_tokens || 0;
    const completionTokens = data.usage?.output_tokens || 0;
    const totalTokens = promptTokens + completionTokens;
    const durationMs = Date.now() - startTime;

    return {
      provider: 'anthropic',
      model,
      text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCostUsd: this.calculateCost('anthropic', model, promptTokens, completionTokens),
      durationMs
    };
  }

  private async callOpenAI(
    cfg: ProviderConfig,
    model: string,
    req: ModelRequest,
    startTime: number
  ): Promise<ModelResponse> {
    const apiKey = cfg.apiKey;
    if (!apiKey) throw new Error('Missing OpenAI API Key');

    const body: Record<string, any> = {
      model,
      messages: req.messages,
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? 4096
    };

    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters
        }
      }));
    }

    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: req.abortSignal
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI API error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    const text = choice?.message?.content || '';
    const rawCalls = choice?.message?.tool_calls || [];

    const toolCalls: ToolCall[] = rawCalls.map((tc: any) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments || '{}')
    }));

    const promptTokens = data.usage?.prompt_tokens || 0;
    const completionTokens = data.usage?.completion_tokens || 0;
    const totalTokens = data.usage?.total_tokens || promptTokens + completionTokens;
    const durationMs = Date.now() - startTime;

    return {
      provider: 'openai',
      model,
      text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCostUsd: this.calculateCost('openai', model, promptTokens, completionTokens),
      durationMs
    };
  }

  private async callOllama(
    cfg: ProviderConfig,
    model: string,
    req: ModelRequest,
    startTime: number
  ): Promise<ModelResponse> {
    const url = `${cfg.baseUrl}/api/chat`;
    const body: Record<string, any> = {
      model,
      messages: req.messages,
      stream: false,
      options: {
        temperature: req.temperature ?? 0.2
      }
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: req.abortSignal
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const text = data.message?.content || '';
    const promptTokens = data.prompt_eval_count || 0;
    const completionTokens = data.eval_count || 0;
    const durationMs = Date.now() - startTime;

    return {
      provider: 'ollama',
      model,
      text,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      estimatedCostUsd: 0, // Local compute is free
      durationMs
    };
  }

  private getDefaultModelForProvider(provider: ModelProviderType): string {
    switch (provider) {
      case 'anthropic': return 'claude-3-5-sonnet-20241022';
      case 'gemini': return 'gemini-2.0-flash';
      case 'openai': return 'gpt-4o';
      case 'ollama': return 'llama3.2';
    }
  }

  private calculateCost(provider: ModelProviderType, model: string, inTokens: number, outTokens: number): number {
    // Standard rates per 1M tokens (Nov 2024 pricing)
    let inRate = 0;
    let outRate = 0;

    if (provider === 'gemini') {
      if (model.includes('flash')) {
        inRate = 0.075;
        outRate = 0.30;
      } else {
        inRate = 1.25;
        outRate = 5.00;
      }
    } else if (provider === 'anthropic') {
      if (model.includes('haiku')) {
        inRate = 0.80;
        outRate = 4.00;
      } else {
        inRate = 3.00;
        outRate = 15.00;
      }
    } else if (provider === 'openai') {
      if (model.includes('mini')) {
        inRate = 0.15;
        outRate = 0.60;
      } else {
        inRate = 2.50;
        outRate = 10.00;
      }
    }

    return (inTokens / 1_000_000) * inRate + (outTokens / 1_000_000) * outRate;
  }

  public getSessionStats(): { promptTokens: number; completionTokens: number; totalCostUsd: number } {
    return {
      promptTokens: this.totalPromptTokens,
      completionTokens: this.totalCompletionTokens,
      totalCostUsd: this.totalCostUsd
    };
  }
}
