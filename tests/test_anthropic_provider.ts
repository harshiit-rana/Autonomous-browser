import assert from 'node:assert';
import { AnthropicModelProvider } from '../src/models/anthropic_provider.js';
import { UsageLedger } from '../src/models/pricing.js';

console.log('--- Testing Milestone M1: Anthropic Adapter (Issue #129) ---');

async function runTests() {
  // 1. Test Instantiation and Configuration
  const provider = new AnthropicModelProvider({
    apiKey: 'test-api-key',
    modelName: 'claude-3-7-sonnet-latest',
    thinkingBudget: 1024,
    enableThinking: true,
    enablePromptCaching: true
  });

  assert.strictEqual(provider.providerName, 'anthropic');
  assert.strictEqual(provider.modelName, 'claude-3-7-sonnet-latest');
  console.log('✓ AnthropicModelProvider configuration verified');

  // 2. Test response parser with synthetic responses
  const parseResponse = (provider as any).parseResponse.bind(provider);

  // Normal text & tool call
  const mockToolUseRes = {
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'text', text: 'Navigating to search page.' },
      {
        type: 'tool_use',
        id: 'call_abc',
        name: 'navigate',
        input: { url: 'https://news.ycombinator.com' }
      }
    ],
    model: 'claude-3-7-sonnet-latest',
    stop_reason: 'tool_use',
    usage: {
      input_tokens: 150,
      output_tokens: 45,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 50
    }
  };

  const parsedToolUse = parseResponse(mockToolUseRes);
  assert.strictEqual(parsedToolUse.text, 'Navigating to search page.');
  assert.strictEqual(parsedToolUse.finishReason, 'tool_calls');
  assert.strictEqual(parsedToolUse.toolCalls.length, 1);
  assert.strictEqual(parsedToolUse.toolCalls[0].name, 'navigate');
  assert.strictEqual(parsedToolUse.toolCalls[0].arguments.url, 'https://news.ycombinator.com');
  assert.strictEqual(parsedToolUse.usage?.promptTokens, 150);
  assert.strictEqual(parsedToolUse.usage?.cacheReadTokens, 100);
  console.log('✓ Anthropic tool call & usage parsing verified');

  // Thinking block response
  const mockThinkingRes = {
    id: 'msg_think',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Analyzing page structure and finding the login button.' },
      { type: 'text', text: 'I found the login link.' }
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 80, output_tokens: 30 }
  };
  const parsedThinking = parseResponse(mockThinkingRes);
  assert.strictEqual(parsedThinking.thinking, 'Analyzing page structure and finding the login button.');
  assert.strictEqual(parsedThinking.text, 'I found the login link.');
  assert.strictEqual(parsedThinking.finishReason, 'stop');
  console.log('✓ Anthropic thinking block extraction verified');

  // Refusal response
  const mockRefusalRes = {
    id: 'msg_refusal',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'text', text: 'I cannot perform actions that bypass safety controls.' }
    ],
    stop_reason: 'refusal',
    usage: { input_tokens: 50, output_tokens: 20 }
  };
  const parsedRefusal = parseResponse(mockRefusalRes);
  assert.strictEqual(parsedRefusal.finishReason, 'refusal');
  console.log('✓ Anthropic refusal state detection verified');

  // Length truncation response
  const mockTruncatedRes = {
    id: 'msg_trunc',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'text', text: 'Partial output...' }
    ],
    stop_reason: 'max_tokens',
    usage: { input_tokens: 50, output_tokens: 2048 }
  };
  const parsedTruncated = parseResponse(mockTruncatedRes);
  assert.strictEqual(parsedTruncated.finishReason, 'length');
  console.log('✓ Anthropic length truncation detection verified');

  // 3. Test UsageLedger pricing with Claude models and prompt cache discounts
  const ledger = new UsageLedger();
  const res = ledger.recordUsage('claude-3-7-sonnet-latest', 1000, 200, 800);
  // Prompt: 200 regular tokens * $3/M = $0.0006
  // Cache read: 800 cached tokens * $0.30/M = $0.00024
  // Completion: 200 tokens * $15/M = $0.003
  // Total step cost = 0.0006 + 0.00024 + 0.003 = 0.00384
  assert(res.stepCost > 0.0038 && res.stepCost < 0.0039, `Expected ~0.00384, got ${res.stepCost}`);
  console.log(`✓ UsageLedger pricing with prompt caching verified: $${res.stepCost.toFixed(6)}`);

  // 4. Test message conversion ordering: images before text
  const convertMessages = (provider as any).convertMessages.bind(provider);
  const canonicalMsgs = [
    {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: 'Click the button in this screenshot' },
        { type: 'image' as const, mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUg==' }
      ]
    }
  ];
  const converted = convertMessages(canonicalMsgs);
  assert.strictEqual(converted[0].role, 'user');
  const userContent = converted[0].content as any[];
  assert.strictEqual(userContent[0].type, 'image');
  assert.strictEqual(userContent[1].type, 'text');
  console.log('✓ Anthropic vision ordering (images before text) verified');

  console.log('✓ All Anthropic Adapter tests passed!\n');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
