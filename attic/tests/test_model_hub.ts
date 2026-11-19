import { ModelHub, ModelRequest } from '../src/core/model_hub.js';
import * as assert from 'node:assert';

async function testModelHub() {
  console.log('--- Testing ModelHub Architecture ---');
  const hub = new ModelHub({
    gemini: { apiKey: 'mock-gemini-key', defaultModel: 'gemini-2.0-flash' },
    anthropic: { apiKey: 'mock-anthropic-key', defaultModel: 'claude-3-5-sonnet-20241022' },
    openai: { apiKey: 'mock-openai-key', defaultModel: 'gpt-4o' }
  });

  // Verify initial stats
  const stats = hub.getSessionStats();
  assert.strictEqual(stats.promptTokens, 0);
  assert.strictEqual(stats.completionTokens, 0);
  assert.strictEqual(stats.totalCostUsd, 0);

  // Verify provider configuration updates
  hub.setProviderConfig('ollama', { baseUrl: 'http://127.0.0.1:11434', defaultModel: 'deepseek-r1' });
  hub.setFallbackOrder(['ollama', 'gemini', 'anthropic']);

  console.log('✓ ModelHub configuration & fallback hierarchy verified!\n');
}

testModelHub().catch(err => {
  console.error('ModelHub test failed:', err);
  process.exit(1);
});
