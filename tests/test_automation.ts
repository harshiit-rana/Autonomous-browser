import { TaskScheduler } from '../src/automation/task_scheduler.js';
import { BatchJobRunner } from '../src/automation/batch_runner.js';
import { FlightRecorder } from '../src/automation/flight_recorder.js';
import { AutonomousFormFiller } from '../src/automation/form_filler.js';
import { AutonomousResearchAgent } from '../src/automation/research_agent.js';
import { MemoryStore } from '../src/memory/memory_store.js';
import { SharedBlackboard } from '../src/swarm/blackboard.js';
import { IndexedElement } from '../src/core/dom_indexer.js';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

function testBatchRunner() {
  console.log('--- Testing BatchJobRunner ---');
  const template = 'Research price for {product} on {supplier}';
  const rows = [
    { product: 'MacBook Pro', supplier: 'Amazon' },
    { product: 'ThinkPad X1', supplier: 'BestBuy' }
  ];

  const items = BatchJobRunner.expandTemplate(template, rows);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].expandedPrompt, 'Research price for MacBook Pro on Amazon');
  assert.strictEqual(items[1].expandedPrompt, 'Research price for ThinkPad X1 on BestBuy');
  console.log('✓ BatchJobRunner parameter expansion verified!\n');
}

function testFlightRecorder() {
  console.log('--- Testing FlightRecorder ---');
  const recorder = new FlightRecorder();
  recorder.startRecording('flight_1', 'Automate GitHub PR creation');

  recorder.recordFrame({
    url: 'https://github.com/pulls',
    action: 'clickElement',
    thinking: 'Locating "New pull request" button',
    mousePosition: { x: 450, y: 120 },
    screenshotBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  });

  const log = recorder.stopRecording();
  assert.strictEqual(log !== null, true);
  assert.strictEqual(log!.frames.length, 1);

  const tempHtml = path.join(process.cwd(), '.temp_replay.html');
  FlightRecorder.exportReplayHTML(log!, tempHtml);
  assert.strictEqual(fs.existsSync(tempHtml), true);

  if (fs.existsSync(tempHtml)) fs.unlinkSync(tempHtml);
  console.log('✓ FlightRecorder blackbox HTML replay verified!\n');
}

function testFormFiller() {
  console.log('--- Testing AutonomousFormFiller ---');
  const mockElements: IndexedElement[] = [
    { id: 'user_email_input', tag: 'input', label: 'Work Email Address', bounds: { x: 0, y: 0, w: 100, h: 30 }, isContentEditable: false },
    { id: 'first_name_field', tag: 'input', label: 'First Name', bounds: { x: 0, y: 0, w: 100, h: 30 }, isContentEditable: false },
    { id: 'phone_num_input', tag: 'input', label: 'Mobile Phone', bounds: { x: 0, y: 0, w: 100, h: 30 }, isContentEditable: false }
  ];

  const plans = AutonomousFormFiller.planFill(mockElements, {
    firstName: 'Harshit',
    email: 'harshit@example.com',
    phone: '+1-555-0199'
  });

  assert.strictEqual(plans.length, 3);
  assert.strictEqual(plans.find(p => p.fieldName === 'email')?.suggestedValue, 'harshit@example.com');
  assert.strictEqual(plans.find(p => p.fieldName === 'firstName')?.suggestedValue, 'Harshit');
  console.log('✓ AutonomousFormFiller verified!\n');
}

function testResearchAgent() {
  console.log('--- Testing AutonomousResearchAgent ---');
  const memory = new MemoryStore(':memory:');
  const bb = new SharedBlackboard();
  const agent = new AutonomousResearchAgent(memory, bb);

  const subQueries = agent.generateSubQueries('DeepSeek R1');
  assert.strictEqual(subQueries.length, 3);

  agent.recordFinding({
    query: 'DeepSeek R1 overview',
    sourceUrl: 'https://deepseek.com/r1',
    title: 'DeepSeek-R1 Architecture',
    summary: 'Inference time reasoning model with test-time compute reinforcement learning.',
    extractedFacts: ['Trained with pure RL without human supervised fine tuning.']
  });

  const fts = memory.searchFTS('DeepSeek RL');
  assert.strictEqual(fts.length >= 1, true);
  assert.strictEqual(bb.getAllEvidence().length, 1);

  memory.close();
  console.log('✓ AutonomousResearchAgent verified!\n');
}

async function main() {
  testBatchRunner();
  testFlightRecorder();
  testFormFiller();
  testResearchAgent();
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
