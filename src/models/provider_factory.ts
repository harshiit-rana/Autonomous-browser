import { IModelProvider } from './types.js';
import { GeminiModelProvider } from './gemini_provider.js';
import { OpenAIModelProvider } from './openai_provider.js';
import { AnthropicModelProvider } from './anthropic_provider.js';
import { OllamaModelProvider } from './ollama_provider.js';
import { ollamaRootUrl } from './ollama_url.js';
import { estimateStepCost } from './pricing.js';
import { getSettings, AppSettings } from '../infrastructure/settings.js';
import { credentialVault } from '../infrastructure/credentials.js';
import { rootLogger } from '../infrastructure/logger.js';
import { MODEL_NOT_CONFIGURED, ModelProviderId, ModelStatusResponse } from '../ipc/contract.js';

const logger = rootLogger.child('provider-factory');

const PROVIDER_LABEL: Record<ModelProviderId, string> = {
  gemini: 'Google Gemini',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'Ollama'
};

const API_KEY_ENV: Record<Exclude<ModelProviderId, 'ollama'>, string> = {
  gemini: 'GEMINI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY'
};

/**
 * Thrown when no usable model exists for the selected provider (no key, or Ollama unreachable). `code` is the typed
 * IPC error code (`MODEL_NOT_CONFIGURED`): the renderer opens Settings with `message` instead of showing a crash.
 */
export class ModelNotConfiguredError extends Error {
  public readonly code = MODEL_NOT_CONFIGURED;
  constructor(
    public readonly provider: ModelProviderId,
    message: string,
    public readonly baseUrl?: string
  ) {
    super(message);
    this.name = 'ModelNotConfiguredError';
  }
}

export interface ModelConfigInspection {
  provider: ModelProviderId;
  model: string;
  configured: boolean;
  message?: string;
  baseUrl?: string;
}

/**
 * Which provider serves `model` under the saved settings. Ollama wins when selected or when the model is a local
 * DeepSeek; otherwise a known cloud model-name prefix decides (the model picker is the explicit per-mission choice),
 * and only an unknown name falls back to the saved provider.
 */
export function resolveProviderId(settings: Pick<AppSettings, 'modelProvider'>, model: string): ModelProviderId {
  if (model.includes('deepseek') || settings.modelProvider === 'ollama' || settings.modelProvider === 'local') return 'ollama';
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gpt-')) return 'openai';
  if (model.startsWith('gemini')) return 'gemini';
  if (settings.modelProvider === 'anthropic') return 'anthropic';
  if (settings.modelProvider === 'openai') return 'openai';
  return 'gemini';
}

function lookupApiKey(provider: Exclude<ModelProviderId, 'ollama'>, settings: AppSettings): string | undefined {
  const key = settings.apiKeys?.[provider] || credentialVault.getKeySync(provider) || process.env[API_KEY_ENV[provider]];
  const trimmed = key?.trim();
  return trimmed ? trimmed : undefined;
}

/** Real-app e2e only: scripted / replay (without recording) need no key. Mirrors e2eModeIsOffline in demo/e2e_scripted.ts. */
function e2eOffline(): boolean {
  const mode = process.env.AEGIS_E2E_MODEL_MODE;
  return mode === 'scripted' || (mode === 'replay' && process.env.AEGIS_E2E_RECORD !== '1');
}

export class ModelProviderFactory {
  /** Synchronous check of the saved credentials for the provider that would serve `modelOverride`. No network. */
  public static inspect(modelOverride?: string): ModelConfigInspection {
    const settings = getSettings();
    const model = modelOverride || settings.modelName || 'gemini-2.0-flash';
    const provider = resolveProviderId(settings, model);

    if (e2eOffline()) {
      return { provider, model, configured: true }; // explicit e2e opt-in (scripted or replay), see createProvider
    }
    if (provider === 'ollama') {
      return { provider, model, configured: true, baseUrl: ollamaRootUrl(settings.ollamaBaseUrl) };
    }
    if (lookupApiKey(provider, settings)) {
      return { provider, model, configured: true };
    }

    const others = (['gemini', 'anthropic', 'openai'] as const)
      .filter(p => p !== provider && lookupApiKey(p, settings))
      .map(p => PROVIDER_LABEL[p]);
    const hint = others.length > 0
      ? ` A key for ${others.join(', ')} is saved, but this mission uses ${PROVIDER_LABEL[provider]} (model "${model}"): ` +
        `add a ${PROVIDER_LABEL[provider]} key or switch the provider and model.`
      : '';
    return {
      provider,
      model,
      configured: false,
      message: `Add an API key to run missions. No ${PROVIDER_LABEL[provider]} API key is configured for model "${model}".${hint}`
    };
  }

  /**
   * `inspect` plus, for Ollama, a short `/api/tags` probe. Only a failed connection is a hard "not configured"; a server
   * that answers without a model list (an OpenAI-compatible proxy) is allowed through.
   */
  public static async checkConfigured(modelOverride?: string): Promise<ModelConfigInspection> {
    const base = ModelProviderFactory.inspect(modelOverride);
    if (!base.configured || base.provider !== 'ollama') return base;

    const root = base.baseUrl as string;
    let res: Response;
    try {
      res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(3000) });
    } catch (err: any) {
      return {
        ...base,
        configured: false,
        message: `Cannot reach Ollama at ${root}. Start it with "ollama serve" or correct the Ollama base URL in Settings. (${err?.cause?.code || err?.message || 'connection failed'})`
      };
    }
    if (!res.ok) return base;
    try {
      const data = await res.json() as { models?: Array<{ name?: string }> };
      const installed = (data.models || []).map(m => m.name).filter((n): n is string => !!n);
      const has = installed.some(n => n === base.model || n === `${base.model}:latest`);
      if (installed.length > 0 && !has) {
        return {
          ...base,
          configured: false,
          message: `Ollama at ${root} does not have model "${base.model}" installed (installed: ${installed.slice(0, 6).join(', ')}). ` +
            `Run "ollama pull ${base.model}" or pick another model.`
        };
      }
    } catch {
      /* unparsable list: let the first model call report the real error */
    }
    return base;
  }

  /** Status for the renderer: configuration plus a rough per-step cost estimate. */
  public static async describe(modelOverride?: string): Promise<ModelStatusResponse> {
    const check = await ModelProviderFactory.checkConfigured(modelOverride);
    return {
      configured: check.configured,
      provider: check.provider,
      model: check.model,
      code: check.configured ? undefined : MODEL_NOT_CONFIGURED,
      message: check.message,
      baseUrl: check.baseUrl,
      estimate: estimateStepCost(check.model)
    };
  }

  /**
   * Builds the provider for a real mission. Throws `ModelNotConfiguredError` when no usable credential exists; there
   * is no fallback to a scripted provider. The only way to get one is `AEGIS_E2E_MODEL_MODE=scripted|replay` (real-app e2e
   * runs; `live` wraps the real provider in a cost cap), loaded through a dynamic import so it stays out of the normal path.
   */
  public static async createProvider(modelOverride?: string): Promise<IModelProvider> {
    const e2eMode = process.env.AEGIS_E2E_MODEL_MODE;
    if (e2eMode) {
      const e2e = await import('./demo/e2e_scripted.js');
      return e2e.createE2EProvider(e2eMode, () => ModelProviderFactory.createRealProvider(modelOverride));
    }
    return ModelProviderFactory.createRealProvider(modelOverride);
  }

  private static async createRealProvider(modelOverride?: string): Promise<IModelProvider> {
    const settings = getSettings();
    const check = ModelProviderFactory.inspect(modelOverride);
    logger.info('Creating model provider', { model: check.model, provider: check.provider });

    if (!check.configured) {
      throw new ModelNotConfiguredError(check.provider, check.message || 'No model is configured', check.baseUrl);
    }

    switch (check.provider) {
      case 'ollama':
        return new OllamaModelProvider({ baseUrl: settings.ollamaBaseUrl, modelName: check.model });
      case 'anthropic':
        return new AnthropicModelProvider({ apiKey: lookupApiKey('anthropic', settings), modelName: check.model });
      case 'openai':
        return new OpenAIModelProvider({ apiKey: lookupApiKey('openai', settings), modelName: check.model });
      default:
        return new GeminiModelProvider({ apiKey: lookupApiKey('gemini', settings), modelName: check.model });
    }
  }

  /**
   * Provider for the completion verifier (#225): `verifierModel` from settings when it is usable (a cheaper model is
   * allowed), otherwise the mission's own model. In real-app e2e runs it is a second, separate scripted queue.
   */
  public static async createVerifierProvider(missionModel: string, verifierModel?: string): Promise<IModelProvider> {
    if (process.env.AEGIS_E2E_MODEL_MODE === 'scripted') {
      const e2e = await import('./demo/e2e_scripted.js');
      return e2e.createE2EScriptedVerifier();
    }
    if (verifierModel && ModelProviderFactory.inspect(verifierModel).configured) {
      return ModelProviderFactory.createProvider(verifierModel);
    }
    if (verifierModel) logger.warn('Verifier model is not configured; using the mission model', { verifierModel, missionModel });
    return ModelProviderFactory.createProvider(missionModel);
  }
}
