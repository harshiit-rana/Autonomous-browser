import { strict as assert } from 'node:assert';
import { ScriptedModelProvider } from '../src/models/demo/scripted_provider.js';
import { ModelRequest, CanonicalMessage } from '../src/models/types.js';
import { BROWSER_TOOLS, ToolExecutor } from '../src/agent/tools.js';
import { PageSnapshot } from '../src/agent/perception.js';

console.log('--- Testing Milestone M1: Agent Runtime & Model Layer ---');

async function testScriptedModelProvider() {
  console.log('Testing ScriptedModelProvider...');

  const provider = new ScriptedModelProvider([
    {
      text: 'Searching for laptops...',
      toolCalls: [
        {
          id: 'call_1',
          name: 'navigate',
          arguments: { url: 'https://news.ycombinator.com' }
        }
      ]
    },
    {
      text: 'Done analyzing page',
      toolCalls: [
        {
          id: 'call_2',
          name: 'done',
          arguments: {
            result: 'Found 3 top posts',
            evidence: ['Post A (+120)', 'Post B (+95)', 'Post C (+80)']
          }
        }
      ]
    }
  ]);

  const req1: ModelRequest = {
    messages: [{ role: 'user', content: 'Find top posts' }],
    tools: BROWSER_TOOLS
  };

  const res1 = await provider.generate(req1);
  assert.equal(res1.toolCalls.length, 1);
  assert.equal(res1.toolCalls[0].name, 'navigate');
  assert.equal(res1.toolCalls[0].arguments.url, 'https://news.ycombinator.com');

  const req2: ModelRequest = {
    messages: [
      { role: 'user', content: 'Find top posts' },
      { role: 'assistant', content: [{ type: 'tool_call', id: 'call_1', name: 'navigate', arguments: { url: 'https://news.ycombinator.com' } }] },
      { role: 'tool', name: 'navigate', content: [{ type: 'tool_result', toolCallId: 'call_1', output: 'Navigated to https://news.ycombinator.com' }] }
    ],
    tools: BROWSER_TOOLS
  };

  const res2 = await provider.generate(req2);
  assert.equal(res2.toolCalls.length, 1);
  assert.equal(res2.toolCalls[0].name, 'done');
  assert.equal(res2.toolCalls[0].arguments.result, 'Found 3 top posts');
  assert.equal(res2.finishReason, 'tool_calls');

  console.log('✓ ScriptedModelProvider multi-turn tool calling verified!');
}

async function testToolExecutor() {
  console.log('Testing ToolExecutor logic...');

  // Mock snapshot
  const mockSnapshot: PageSnapshot = {
    url: 'https://example.com',
    title: 'Example Domain',
    elements: new Map([
      [
        'e1',
        {
          ref: 'e1',
          tagName: 'button',
          name: 'Submit Query',
          bounds: { x: 100, y: 150, width: 80, height: 30 },
          isClickable: true,
          isTextInput: false
        }
      ],
      [
        'e2',
        {
          ref: 'e2',
          tagName: 'input',
          type: 'text',
          name: 'Search',
          value: '',
          bounds: { x: 50, y: 50, width: 200, height: 35 },
          isClickable: false,
          isTextInput: true
        }
      ]
    ]),
    formattedTree: '[e1] button "Submit Query"\n[e2] input[type="text"] "Search"'
  };

  const mockTab: any = {
    id: 'test_tab',
    view: {
      webContents: {
        loadURL: async (url: string) => {},
        executeJavaScript: async (code: string) => {},
        sendInputEvent: async (ev: any) => {}
      }
    },
    executor: {
      moveMouseTo: async () => {}
    }
  };

  // Test navigate
  const navResult = await ToolExecutor.execute('navigate', { url: 'https://duckduckgo.com' }, { tab: mockTab, snapshot: mockSnapshot });
  assert.equal(navResult.ok, true);
  assert.equal(navResult.effect?.navigated, 'https://duckduckgo.com');

  // Test click
  const clickResult = await ToolExecutor.execute('click', { ref: 'e1' }, { tab: mockTab, snapshot: mockSnapshot });
  assert.equal(clickResult.ok, true);
  assert.equal(clickResult.effect?.clicked, 'e1');

  // Test click stale ref
  const staleClick = await ToolExecutor.execute('click', { ref: 'e99' }, { tab: mockTab, snapshot: mockSnapshot });
  assert.equal(staleClick.ok, false);
  assert.equal(staleClick.error, 'stale_ref');

  // Test type
  const typeResult = await ToolExecutor.execute('type', { ref: 'e2', text: 'Anthropic Claude' }, { tab: mockTab, snapshot: mockSnapshot });
  assert.equal(typeResult.ok, true);
  assert.equal(typeResult.effect?.typed, 'Anthropic Claude');

  // Test done
  const doneResult = await ToolExecutor.execute('done', { result: 'Goal achieved', evidence: ['Fact 1', 'Fact 2'] }, { tab: mockTab, snapshot: mockSnapshot });
  assert.equal(doneResult.ok, true);
  assert.equal(doneResult.isTerminal, true);
  assert.equal(doneResult.isDone, true);
  assert.deepEqual(doneResult.effect?.evidence, ['Fact 1', 'Fact 2']);

  // Test ask_user
  const askResult = await ToolExecutor.execute('ask_user', { question: 'Please solve the CAPTCHA' }, { tab: mockTab, snapshot: mockSnapshot });
  assert.equal(askResult.ok, true);
  assert.equal(askResult.requiresUser, true);

  // Test fail
  const failResult = await ToolExecutor.execute('fail', { reason: 'Page blocked by Cloudflare' }, { tab: mockTab, snapshot: mockSnapshot });
  assert.equal(failResult.ok, false);
  assert.equal(failResult.isTerminal, true);
  assert.equal(failResult.isDone, false);

  console.log('✓ ToolExecutor all tools and error branches verified!');
}

async function testModelProviderFactory() {
  console.log('Testing ModelProviderFactory...');
  const { ModelProviderFactory } = await import('../src/models/provider_factory.js');

  // Ollama provider instantiation
  const ollamaProvider = await ModelProviderFactory.createProvider('deepseek-r1:8b');
  assert.equal(ollamaProvider.providerName, 'ollama');
  assert.equal(ollamaProvider.modelName, 'deepseek-r1:8b');

  // Gemini provider instantiation needs a key (no key -> MODEL_NOT_CONFIGURED, see test_provider_factory.ts)
  const { updateSettings } = await import('../src/infrastructure/settings.js');
  updateSettings({ apiKeys: { gemini: 'AIza-unit-test-key' } });
  const geminiProvider = await ModelProviderFactory.createProvider('gemini-2.0-flash');
  assert.equal(geminiProvider.providerName, 'gemini');
  updateSettings({ apiKeys: { gemini: '' } });

  console.log('✓ ModelProviderFactory dynamic resolution verified!');
}

async function testUsageLedger() {
  console.log('Testing UsageLedger (Issue #132)...');
  const { UsageLedger } = await import('../src/models/pricing.js');
  const ledger = new UsageLedger();

  // Test Gemini 2.0 Flash pricing: $0.10/M in, $0.40/M out
  const stats1 = ledger.recordUsage('gemini-2.0-flash', 1_000_000, 500_000);
  assert.equal(stats1.tokensTotal, 1_500_000);
  assert.equal(Math.round(stats1.costTotal * 100) / 100, 0.30); // 0.10 + 0.20 = 0.30

  // Test local model: $0 cost
  const stats2 = ledger.recordUsage('deepseek-r1:8b', 500_000, 200_000);
  assert.equal(stats2.tokensTotal, 2_200_000);
  assert.equal(Math.round(stats2.costTotal * 100) / 100, 0.30);

  console.log('✓ UsageLedger token and cost calculations verified!');
}

async function testActionTaxonomy() {
  console.log('Testing ActionTaxonomy (Issue #125)...');
  const { ActionTaxonomy } = await import('../src/agent/errors.js');

  const stale = ActionTaxonomy.classify('Element e5 not found in current snapshot');
  assert.equal(stale.code, 'STALE_REF');
  assert.equal(stale.retryable, true);

  const captcha = ActionTaxonomy.classify('Page challenge: verify you are human via cloudflare turnstile');
  assert.equal(captcha.code, 'CAPTCHA');
  assert.equal(captcha.requiresHumanHandoff, true);

  const roadblock = ActionTaxonomy.detectPageRoadblocks('Just a moment...', 'https://protected.com', 'Please verify you are human');
  assert.notEqual(roadblock, null);
  assert.equal(roadblock?.code, 'CAPTCHA');

  console.log('✓ ActionTaxonomy error classification and roadblocks verified!');
}

async function run() {
  await testScriptedModelProvider();
  await testToolExecutor();
  await testModelProviderFactory();
  await testUsageLedger();
  await testActionTaxonomy();
  console.log('✓ All Milestone M1 tests passed successfully!');
}

run().catch((err) => {
  console.error('Test failure:', err);
  process.exit(1);
});
