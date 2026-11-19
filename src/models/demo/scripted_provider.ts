/**
 * Scripted model provider (issue #224, RUN-02).
 *
 * This is NOT a model. It replays a fixed list of responses. It exists for two callers only:
 *   1. the labelled "Replay demo" (`./replay_player.ts`), which feeds it a hand-recorded transcript, and
 *   2. real-app e2e runs that set `AEGIS_E2E_MODEL_MODE=scripted` (see `ModelProviderFactory`).
 * It must never be reachable from a normal mission: `provider_factory.ts` loads it through a dynamic `import()` behind
 * that guard, and `scripts/release_gate.mjs` (no-fake-paths) rejects any reference to it outside `src/models/demo/`.
 */
import { IModelProvider, ModelRequest, ModelResponse } from '../types.js';

export interface ScriptedStepResponse {
  text?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, any>;
  }>;
}

export class ScriptedModelProvider implements IModelProvider {
  public readonly providerName = 'scripted';
  public readonly modelName = 'scripted-model';

  private responseQueue: ScriptedStepResponse[] = [];

  /**
   * With no script an empty queue is an error, not a canned "Task complete": a scripted provider that invents a
   * successful result is exactly the silent mock this issue removes.
   */
  constructor(presetResponses?: ScriptedStepResponse[]) {
    if (presetResponses && presetResponses.length > 0) {
      this.responseQueue = [...presetResponses];
    }
  }

  public enqueueResponse(response: ScriptedStepResponse): void {
    this.responseQueue.push(response);
  }

  public get remaining(): number {
    return this.responseQueue.length;
  }

  public async generate(request: ModelRequest): Promise<ModelResponse> {
    if (request.abortSignal?.aborted) {
      throw new Error('Operation aborted');
    }

    const next = this.responseQueue.shift();
    if (!next) {
      throw new Error('Scripted provider has no more scripted responses (this is a recorded replay, not a live model)');
    }
    const toolCalls = next.toolCalls || [];

    return {
      text: next.text || '',
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      // No model ran, so no tokens were used and nothing is billed.
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    };
  }
}
