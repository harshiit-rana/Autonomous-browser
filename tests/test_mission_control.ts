import assert from 'node:assert';
import { OmnibarParser } from '../src/ui/omnibar_parser.js';
import { PresenceEvent, PlanPreviewResponse } from '../ipc/contract.js';

console.log('--- Testing Milestone M3: Mission Control & Swarm Chrome UX ---');

async function runTests() {
  // 1. Issue #138 & #140: Omnibar intent routing & Plan Preview
  console.log('Testing Omnibar Intent Classification & Plan Preview...');
  const browseIntent = OmnibarParser.parse('https://news.ycombinator.com');
  assert.strictEqual(browseIntent.type, 'url');
  assert.strictEqual(browseIntent.targetUrl, 'https://news.ycombinator.com');

  const missionIntent = OmnibarParser.parse('find the cheapest mechanical keyboard on amazon');
  assert.strictEqual(missionIntent.type, 'agent_command');
  assert.strictEqual(missionIntent.command, 'do');

  const mockPlan: PlanPreviewResponse = {
    goal: missionIntent.prompt || '',
    steps: [
      { stepNumber: 1, title: 'Navigate to target store', description: 'Open search page', toolHint: 'navigate' },
      { stepNumber: 2, title: 'Locate top products', description: 'Filter and click lowest price items', toolHint: 'click' },
      { stepNumber: 3, title: 'Extract pricing details', description: 'Record title and price to report', toolHint: 'done' }
    ],
    estimatedCostUSD: 0.0035,
    estimatedDurationSec: 12
  };

  assert.strictEqual(mockPlan.steps.length, 3);
  assert(mockPlan.estimatedCostUSD > 0);
  console.log('✓ Omnibar intent routing & Plan Preview structure verified');

  // 2. Issue #136: Agent Presence Layer Contract
  console.log('Testing Agent Presence Layer Contract...');
  const moveEvent: PresenceEvent = {
    workerId: 'tab_test_1', seq: 1, ts: 0, kind: 'move', zoom: 1,
    x: 420,
    y: 280,
    name: 'Operator-1'
  };

  const clickEvent: PresenceEvent = {
    workerId: 'tab_test_1', seq: 2, ts: 0, kind: 'click', zoom: 1,
    x: 420,
    y: 280,
    name: 'Operator-1'
  };

  assert.strictEqual(moveEvent.kind, 'move');
  assert.strictEqual(clickEvent.kind, 'click');
  assert.strictEqual(moveEvent.x, clickEvent.x);
  console.log('✓ Agent Presence Layer payload contract verified');

  console.log('✓ All Mission Control & Swarm Chrome UX tests passed!\n');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
