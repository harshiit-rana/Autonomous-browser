import { strict as assert } from 'node:assert';
import { MockModelProvider } from '../src/models/mock_provider.js';
import { ModelRequest, CanonicalMessage } from '../src/models/types.js';
import { BROWSER_TOOLS, ToolExecutor } from '../src/agent/tools.js';
import { PageSnapshot } from '../src/agent/perception.js';

console.log('--- Testing Milestone M1: Agent Runtime & Model Layer ---');

async function testMockModelProvider() {
  console.log('Testing MockModelProvider...');

  const provider = new MockModelProvider([
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

  console.log('✓ MockModelProvider multi-turn tool calling verified!');
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

  // Test fail
  const failResult = await ToolExecutor.execute('fail', { reason: 'Page blocked by Cloudflare' }, { tab: mockTab, snapshot: mockSnapshot });
  assert.equal(failResult.ok, false);
  assert.equal(failResult.isTerminal, true);
  assert.equal(failResult.isDone, false);

  console.log('✓ ToolExecutor all tools and error branches verified!');
}

async function run() {
  await testMockModelProvider();
  await testToolExecutor();
  console.log('✓ All Milestone M1 tests passed successfully!');
}

run().catch((err) => {
  console.error('Test failure:', err);
  process.exit(1);
});
