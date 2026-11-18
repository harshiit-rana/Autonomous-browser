import { IModelProvider } from './types.js';
import { GeminiModelProvider } from './gemini_provider.js';
import { OpenAIModelProvider } from './openai_provider.js';
import { AnthropicModelProvider } from './anthropic_provider.js';
import { MockModelProvider } from './mock_provider.js';
import { getSettings } from '../infrastructure/settings.js';
import { credentialVault } from '../infrastructure/credentials.js';
import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('provider-factory');

export class ModelProviderFactory {
  public static createProvider(modelOverride?: string): IModelProvider {
    const settings = getSettings();
    const model = modelOverride || settings.modelName || 'gemini-2.0-flash';

    logger.info('Creating model provider', { model, provider: settings.modelProvider });

    // 1. Ollama or DeepSeek local model
    if (model.includes('deepseek') || settings.modelProvider === 'ollama' || settings.modelProvider === 'local') {
      return new OpenAIModelProvider({
        baseURL: settings.ollamaBaseUrl || 'http://localhost:11434/v1',
        apiKey: 'ollama',
        modelName: model
      });
    }

    // 2. Anthropic
    if (settings.modelProvider === 'anthropic' || model.startsWith('claude-')) {
      const apiKey = settings.apiKeys.anthropic || credentialVault.getKeySync('anthropic') || process.env.ANTHROPIC_API_KEY;
      if (!apiKey && settings.demoMode) {
        logger.info('Using MockModelProvider for Anthropic in demo mode');
        return new MockModelProvider();
      }
      return new AnthropicModelProvider({
        apiKey,
        modelName: model
      });
    }

    // 3. OpenAI
    if (settings.modelProvider === 'openai' || model.startsWith('gpt-')) {
      const apiKey = settings.apiKeys.openai || credentialVault.getKeySync('openai') || process.env.OPENAI_API_KEY;
      if (!apiKey && settings.demoMode) {
        logger.info('Using MockModelProvider for OpenAI in demo mode');
        return new MockModelProvider();
      }
      if (!apiKey) {
        logger.warn('No OpenAI API key found');
      }
      return new OpenAIModelProvider({
        apiKey,
        modelName: model
      });
    }

    // 4. Gemini (default)
    const geminiKey = settings.apiKeys.gemini || credentialVault.getKeySync('gemini') || process.env.GEMINI_API_KEY;
    if (!geminiKey && settings.demoMode) {
      logger.info('Using MockModelProvider in demo mode');
      return new MockModelProvider();
    }

    return new GeminiModelProvider({
      apiKey: geminiKey,
      modelName: model
    });
  }
}
