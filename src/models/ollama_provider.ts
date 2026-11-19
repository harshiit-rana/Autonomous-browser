import { IModelProvider, ModelRequest, ModelResponse } from './types.js';
import { OpenAIModelProvider } from './openai_provider.js';
import OpenAI from 'openai';
import { ollamaOpenAIBaseUrl, ollamaRootUrl } from './ollama_url.js';

/**
 * Ollama through its OpenAI-compatible endpoint, with errors that name the base URL (#224). The bare OpenAI SDK errors
 * ("Connection error.", "404 status code (no body)") do not tell the user which server was tried or what to do.
 */
export class OllamaModelProvider implements IModelProvider {
  public readonly providerName = 'ollama';
  public readonly modelName: string;
  private readonly inner: OpenAIModelProvider;
  private readonly root: string;

  constructor(options: { baseUrl?: string; modelName: string }) {
    this.modelName = options.modelName;
    this.root = ollamaRootUrl(options.baseUrl);
    this.inner = new OpenAIModelProvider({
      baseURL: ollamaOpenAIBaseUrl(options.baseUrl),
      apiKey: 'ollama',
      modelName: options.modelName
    });
  }

  public async generate(request: ModelRequest): Promise<ModelResponse> {
    try {
      return await this.inner.generate(request);
    } catch (err: any) {
      if (request.abortSignal?.aborted || err?.name === 'AbortError') throw err;
      throw this.explain(err);
    }
  }

  private explain(err: any): Error {
    if (err?.status === 404) {
      return new Error(
        `Ollama at ${this.root} does not serve model "${this.modelName}" (HTTP 404). ` +
        `Run "ollama pull ${this.modelName}" or choose a model you have installed.`
      );
    }
    if (err instanceof OpenAI.APIConnectionError) {
      return new Error(
        `Cannot reach Ollama at ${this.root}. Start it with "ollama serve" or correct the Ollama base URL in Settings. ` +
        `(${err?.message || 'connection failed'})`
      );
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}
