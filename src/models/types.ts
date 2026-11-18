/**
 * Project Aegis - Canonical Model Layer Types & Interfaces
 * Provider-neutral message model, content blocks, tool calling, and streaming.
 */

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  mimeType: string;
  base64: string;
}

export interface ToolCallContent {
  type: 'tool_call';
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ToolResultContent {
  type: 'tool_result';
  toolCallId: string;
  output: string;
  isError?: boolean;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
}

export type ContentBlock =
  | TextContent
  | ImageContent
  | ToolCallContent
  | ToolResultContent
  | ThinkingContent;

export interface CanonicalMessage {
  role: MessageRole;
  content: string | ContentBlock[];
  name?: string;
}

export interface ToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: Record<string, any>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameterProperty>;
    required?: string[];
  };
}

export interface ModelRequest {
  messages: CanonicalMessage[];
  tools?: ToolDefinition[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  abortSignal?: AbortSignal;
  missionId?: string;
  stepId?: string;
}

export interface ModelResponse {
  text: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, any>;
  }>;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  raw?: any;
}

export interface IModelProvider {
  readonly providerName: string;
  readonly modelName: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
}
