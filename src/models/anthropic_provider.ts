/**
 * Project Aegis - Anthropic Model Provider Adapter
 * Implements: Issue #129 [MDL-02] Current Anthropic models, adaptive thinking,
 * prompt caching, refusal detection, and token budgeting.
 */

import { Anthropic } from '@anthropic-ai/sdk';
import {
  IModelProvider,
  ModelRequest,
  ModelResponse,
  CanonicalMessage,
  ToolDefinition
} from './types.js';
import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('anthropic-provider');

export interface AnthropicModelConfig {
  apiKey?: string;
  modelName?: string;
  thinkingBudget?: number;
  enableThinking?: boolean;
  enablePromptCaching?: boolean;
  /** API root override (a proxy, or a local server in tests). */
  baseURL?: string;
}

export class AnthropicModelProvider implements IModelProvider {
  public readonly providerName = 'anthropic';
  public readonly modelName: string;
  private client: Anthropic;
  private thinkingBudget?: number;
  private enableThinking: boolean;
  private enablePromptCaching: boolean;

  constructor(config: AnthropicModelConfig = {}) {
    this.modelName = config.modelName || 'claude-3-7-sonnet-latest';
    this.thinkingBudget = config.thinkingBudget;
    this.enableThinking = config.enableThinking ?? this.modelName.includes('3-7');
    this.enablePromptCaching = config.enablePromptCaching ?? true;

    const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    this.client = new Anthropic({
      apiKey: apiKey || 'dummy-key-for-init',
      baseURL: config.baseURL || undefined
    });
  }

  public async generate(request: ModelRequest): Promise<ModelResponse> {
    try {
      const messages = this.convertMessages(request.messages);
      const tools = this.convertTools(request.tools);

      // Setup system parameter with prompt caching if enabled
      let systemParam: any = undefined;
      if (request.systemPrompt) {
        if (this.enablePromptCaching) {
          systemParam = [
            {
              type: 'text',
              text: request.systemPrompt,
              cache_control: { type: 'ephemeral' }
            }
          ];
        } else {
          systemParam = request.systemPrompt;
        }
      }

      // Configure thinking parameters for models that support it
      const thinkingConfig = (this.enableThinking && this.modelName.includes('3-7'))
        ? {
            type: 'enabled' as const,
            budget_tokens: this.thinkingBudget || 2048
          }
        : undefined;

      const maxTokens = request.maxTokens || (thinkingConfig ? 4096 : 2048);

      const createParams: any = {
        model: this.modelName,
        messages,
        max_tokens: maxTokens,
        system: systemParam
      };

      if (tools && tools.length > 0) {
        createParams.tools = tools;
      }

      if (thinkingConfig) {
        createParams.thinking = thinkingConfig;
        // Anthropic requires temperature to be unset or 1.0 when thinking is enabled
      } else if (request.temperature !== undefined) {
        createParams.temperature = request.temperature;
      }

      logger.info('Dispatching Anthropic completion request', {
        model: this.modelName,
        messageCount: messages.length,
        hasTools: Boolean(tools && tools.length > 0),
        thinkingEnabled: Boolean(thinkingConfig)
      });

      const response = await this.client.messages.create(createParams, {
        signal: request.abortSignal
      });

      return this.parseResponse(response);
    } catch (err: any) {
      return this.handleError(err);
    }
  }

  private convertMessages(canonicalMessages: CanonicalMessage[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const msg of canonicalMessages) {
      if (msg.role === 'system') {
        // System messages are passed via createParams.system
        continue;
      }

      if (msg.role === 'assistant') {
        const contentParts: any[] = [];
        if (typeof msg.content === 'string') {
          contentParts.push({ type: 'text', text: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'text') {
              contentParts.push({ type: 'text', text: block.text });
            } else if (block.type === 'thinking') {
              contentParts.push({ type: 'thinking', thinking: block.thinking, signature: '' });
            } else if (block.type === 'tool_call') {
              contentParts.push({
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: block.arguments
              });
            }
          }
        }
        result.push({ role: 'assistant', content: contentParts });
      } else if (msg.role === 'user' || msg.role === 'tool') {
        const contentParts: any[] = [];
        // Images must be placed before text in user turns
        if (typeof msg.content === 'string') {
          contentParts.push({ type: 'text', text: msg.content });
        } else if (Array.isArray(msg.content)) {
          const images = msg.content.filter(b => b.type === 'image');
          const others = msg.content.filter(b => b.type !== 'image');

          for (const img of images) {
            if (img.type === 'image') {
              contentParts.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: img.mimeType as any,
                  data: img.base64
                }
              });
            }
          }

          for (const block of others) {
            if (block.type === 'text') {
              contentParts.push({ type: 'text', text: block.text });
            } else if (block.type === 'tool_result') {
              contentParts.push({
                type: 'tool_result',
                tool_use_id: block.toolCallId,
                content: block.output,
                is_error: block.isError
              });
            }
          }
        }
        result.push({ role: 'user', content: contentParts });
      }
    }

    return result;
  }

  private convertTools(tools?: ToolDefinition[]): Anthropic.Tool[] | undefined {
    if (!tools || tools.length === 0) return undefined;

    return tools.map((t, idx) => {
      const toolObj: Anthropic.Tool = {
        name: t.name,
        description: t.description,
        input_schema: {
          type: 'object',
          properties: t.parameters.properties as any,
          required: t.parameters.required || []
        }
      };

      // Set ephemeral prompt cache breakpoint on the final tool to cache the tools prefix
      if (this.enablePromptCaching && idx === tools.length - 1) {
        (toolObj as any).cache_control = { type: 'ephemeral' };
      }

      return toolObj;
    });
  }

  private parseResponse(response: Anthropic.Message): ModelResponse {
    let text = '';
    let thinking = '';
    const toolCalls: Array<{ id: string; name: string; arguments: Record<string, any> }> = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        text += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: (block.input as Record<string, any>) || {}
        });
      } else if ((block as any).type === 'thinking') {
        thinking += (block as any).thinking || '';
      }
    }

    let finishReason: ModelResponse['finishReason'] = 'stop';
    if (response.stop_reason === 'refusal') {
      finishReason = 'refusal';
    } else if (response.stop_reason === 'tool_use') {
      finishReason = 'tool_calls';
    } else if (response.stop_reason === 'max_tokens') {
      finishReason = 'length';
    }

    const usage = response.usage ? {
      promptTokens: response.usage.input_tokens || 0,
      completionTokens: response.usage.output_tokens || 0,
      totalTokens: (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0),
      cacheReadTokens: (response.usage as any).cache_read_input_tokens || 0,
      cacheWriteTokens: (response.usage as any).cache_creation_input_tokens || 0
    } : undefined;

    return {
      text,
      thinking: thinking.length > 0 ? thinking : undefined,
      toolCalls,
      finishReason,
      usage,
      raw: response
    };
  }

  private handleError(err: any): ModelResponse {
    logger.error('Anthropic API request failed', err instanceof Error ? err : new Error(String(err)), {
      name: err.name,
      status: err.status,
      message: err.message
    });

    const isRefusal = err.message?.toLowerCase().includes('refusal') || err.status === 403;

    return {
      text: `Anthropic Error: ${err.message}`,
      toolCalls: [],
      finishReason: isRefusal ? 'refusal' : 'error',
      raw: err
    };
  }
}
