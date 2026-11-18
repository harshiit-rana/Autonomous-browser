import { IModelProvider, ModelRequest, ModelResponse } from './types.js';

export interface MockStepResponse {
  text?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, any>;
  }>;
}

export class MockModelProvider implements IModelProvider {
  public readonly providerName = 'mock';
  public readonly modelName = 'mock-model';

  private responseQueue: MockStepResponse[] = [];
  private defaultResponse: MockStepResponse = {
    text: 'Task complete',
    toolCalls: [{ id: 'mock_done_1', name: 'done', arguments: { result: 'Mock task finished' } }]
  };

  constructor(presetResponses?: MockStepResponse[]) {
    if (presetResponses && presetResponses.length > 0) {
      this.responseQueue = [...presetResponses];
    }
  }

  public enqueueResponse(response: MockStepResponse): void {
    this.responseQueue.push(response);
  }

  public async generate(request: ModelRequest): Promise<ModelResponse> {
    if (request.abortSignal?.aborted) {
      throw new Error('Operation aborted');
    }

    const next = this.responseQueue.shift() || this.defaultResponse;
    const toolCalls = next.toolCalls || [];

    return {
      text: next.text || '',
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      usage: {
        promptTokens: 100,
        completionTokens: 25,
        totalTokens: 125
      }
    };
  }
}
