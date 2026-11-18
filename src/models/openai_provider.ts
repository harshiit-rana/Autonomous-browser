import OpenAI from 'openai';
import {
  IModelProvider,
  ModelRequest,
  ModelResponse,
  CanonicalMessage,
  ToolDefinition,
  ContentBlock
} from './types.js';
import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('openai-provider');

export interface OpenAIProviderOptions {
  apiKey?: string;
  baseURL?: string;
  modelName: string;
}

export class OpenAIModelProvider implements IModelProvider {
  public readonly providerName = 'openai';
  public readonly modelName: string;
  private client: OpenAI;

  constructor(options: OpenAIProviderOptions) {
    this.modelName = options.modelName;
    this.client = new OpenAI({
      apiKey: options.apiKey || process.env.OPENAI_API_KEY || 'no-key',
      baseURL: options.baseURL || undefined
    });
  }

  public async generate(request: ModelRequest): Promise<ModelResponse> {
    try {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

      if (request.systemPrompt) {
        messages.push({
          role: 'system',
          content: request.systemPrompt
        });
      }

      for (const msg of request.messages) {
        messages.push(this.mapMessageToOpenAI(msg));
      }

      const tools: OpenAI.Chat.ChatCompletionTool[] | undefined = request.tools?.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters
        }
      }));

      const response = await this.client.chat.completions.create(
        {
          model: this.modelName,
          messages,
          tools: tools && tools.length > 0 ? tools : undefined,
          temperature: request.temperature ?? 0.2,
          max_tokens: request.maxTokens ?? 2048
        },
        {
          signal: request.abortSignal
        }
      );

      const choice = response.choices[0];
      const toolCalls: Array<{ id: string; name: string; arguments: Record<string, any> }> = [];

      if (choice?.message?.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          if (tc.type === 'function') {
            let parsedArgs: Record<string, any> = {};
            try {
              parsedArgs = JSON.parse(tc.function.arguments || '{}');
            } catch (err: any) {
              logger.warn('Failed to parse tool call arguments JSON', { raw: tc.function.arguments, error: err.message });
              parsedArgs = { _raw: tc.function.arguments, _parseError: true };
            }

            toolCalls.push({
              id: tc.id,
              name: tc.function.name,
              arguments: parsedArgs
            });
          }
        }
      }

      return {
        text: choice?.message?.content || '',
        toolCalls,
        finishReason: choice?.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
        usage: {
          promptTokens: response.usage?.prompt_tokens || 0,
          completionTokens: response.usage?.completion_tokens || 0,
          totalTokens: response.usage?.total_tokens || 0
        },
        raw: response
      };
    } catch (err: any) {
      logger.error('OpenAI generation error', err);
      throw err;
    }
  }

  private mapMessageToOpenAI(msg: CanonicalMessage): OpenAI.Chat.ChatCompletionMessageParam {
    if (typeof msg.content === 'string') {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          content: msg.content,
          tool_call_id: msg.name || 'call_default'
        };
      }
      return {
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content
      };
    }

    // Handle ContentBlock[]
    if (msg.role === 'assistant') {
      let text = '';
      const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          text += block.text;
        } else if (block.type === 'tool_call') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.arguments)
            }
          });
        }
      }

      return {
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined
      };
    }

    if (msg.role === 'tool') {
      const toolResult = msg.content.find(b => b.type === 'tool_result') as any;
      return {
        role: 'tool',
        content: toolResult?.output || '',
        tool_call_id: toolResult?.toolCallId || msg.name || 'call_default'
      };
    }

    // User message with text or image
    const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
    for (const block of msg.content) {
      if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${block.mimeType};base64,${block.base64}`
          }
        });
      }
    }

    return {
      role: 'user',
      content: parts
    };
  }
}
