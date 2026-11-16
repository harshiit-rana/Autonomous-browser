import { OmnibarParser } from '../src/ui/omnibar_parser.js';
import * as assert from 'node:assert';

function testOmnibarParser() {
  console.log('--- Testing OmnibarParser ---');

  // 1. Slash commands
  const swarmCmd = OmnibarParser.parse('/swarm compare iPhone 16 prices across BestBuy and Amazon');
  assert.strictEqual(swarmCmd.type, 'agent_command');
  assert.strictEqual(swarmCmd.command, 'swarm');
  assert.strictEqual(swarmCmd.prompt, 'compare iPhone 16 prices across BestBuy and Amazon');

  const researchCmd = OmnibarParser.parse('/research AI agent planning algorithms');
  assert.strictEqual(researchCmd.type, 'agent_command');
  assert.strictEqual(researchCmd.command, 'research');

  // 2. Direct URLs
  const url1 = OmnibarParser.parse('github.com/features/actions');
  assert.strictEqual(url1.type, 'url');
  assert.strictEqual(url1.targetUrl, 'https://github.com/features/actions');

  const url2 = OmnibarParser.parse('http://localhost:3000/dashboard');
  assert.strictEqual(url2.type, 'url');
  assert.strictEqual(url2.targetUrl, 'http://localhost:3000/dashboard');

  // 3. Natural language prompt
  const nlPrompt = OmnibarParser.parse('extract all table rows on this page');
  assert.strictEqual(nlPrompt.type, 'agent_command');
  assert.strictEqual(nlPrompt.command, 'swarm');

  // 4. Standard search
  const search = OmnibarParser.parse('weather in San Francisco');
  assert.strictEqual(search.type, 'search');
  assert.strictEqual(search.targetUrl?.includes('google.com/search'), true);

  console.log('✓ OmnibarParser verified!\n');
}

testOmnibarParser();
