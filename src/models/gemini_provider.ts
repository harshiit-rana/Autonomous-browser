import { GoogleGenAI } from '@google/genai';
import {
  IModelProvider,
  ModelRequest,
  ModelResponse,
  CanonicalMessage,
  ToolDefinition
} from './types.js';
import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('gemini-provider');

export interface GeminiProviderOptions {
  apiKey?: string;
  modelName?: string;
  /** API root override (a proxy, or a local server in tests). */
  baseUrl?: string;
}

export class GeminiModelProvider implements IModelProvider {
  public readonly providerName = 'gemini';
  public readonly modelName: string;
  private ai: GoogleGenAI;

  constructor(options: GeminiProviderOptions = {}) {
    this.modelName = options.modelName || 'gemini-2.0-flash';
    const apiKey = options.apiKey || process.env.GEMINI_API_KEY || '';
    this.ai = new GoogleGenAI({ apiKey, ...(options.baseUrl ? { httpOptions: { baseUrl: options.baseUrl } } : {}) });
  }

  public async generate(request: ModelRequest): Promise<ModelResponse> {
    try {
      const contents = this.formatContents(request.messages);

      const functionDeclarations = request.tools?.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters as any
      }));

      const toolsConfig = functionDeclarations && functionDeclarations.length > 0
        ? [{ functionDeclarations }]
        : undefined;

      const response = await this.ai.models.generateContent({
        model: this.modelName,
        contents,
        config: {
          systemInstruction: request.systemPrompt || undefined,
          temperature: request.temperature ?? 0.2,
          maxOutputTokens: request.maxTokens ?? 2048,
          tools: toolsConfig as any,
          // Cancelling a mission must abort the HTTP request (#225).
          abortSignal: request.abortSignal
        }
      });

      const candidate = response.candidates?.[0];
      let text = '';
      const toolCalls: Array<{ id: string; name: string; arguments: Record<string, any> }> = [];

      if (candidate?.content?.parts) {
        for (const part of candidate.content.parts) {
          if (part.text) {
            text += part.text;
          }
          if (part.functionCall) {
            toolCalls.push({
              id: `call_${part.functionCall.name || 'tool'}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
              name: part.functionCall.name || 'unknown_tool',
              arguments: (part.functionCall.args as Record<string, any>) || {}
            });
          }
        }
      }

      return {
        text,
        toolCalls,
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        usage: {
          promptTokens: response.usageMetadata?.promptTokenCount || 0,
          completionTokens: response.usageMetadata?.candidatesTokenCount || 0,
          totalTokens: response.usageMetadata?.totalTokenCount || 0
        },
        raw: response
      };
    } catch (err: any) {
      logger.error('Gemini generation error', err);
      throw err;
    }
  }

  private formatContents(messages: CanonicalMessage[]): any[] {
    const contents: any[] = [];

    for (const msg of messages) {
      const role = msg.role === 'assistant' ? 'model' : 'user';

      if (typeof msg.content === 'string') {
        contents.push({
          role,
          parts: [{ text: msg.content }]
        });
        continue;
      }

      const parts: any[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ text: block.text });
        } else if (block.type === 'image') {
          parts.push({
            inlineData: {
              mimeType: block.mimeType,
              data: block.base64
            }
          });
        } else if (block.type === 'tool_call') {
          parts.push({
            functionCall: {
              name: block.name,
              args: block.arguments
            }
          });
        } else if (block.type === 'tool_result') {
          parts.push({
            functionResponse: {
              name: msg.name || 'tool_response',
              response: { output: block.output }
            }
          });
        }
      }

      if (parts.length > 0) {
        contents.push({ role, parts });
      }
    }

    return contents;
  }
}
