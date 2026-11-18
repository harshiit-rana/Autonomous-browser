import assert from 'node:assert';
import { InstructionManager } from '../src/workspace/custom_instructions.js';
import { TemplateLibrary } from '../src/workspace/template_library.js';
import { PromptWorkspaceManager, StructuredMissionDraft } from '../src/workspace/prompt_workspace.js';
import { ThreadManager } from '../src/workspace/conversation_threads.js';
import { ChoreographyEngine } from '../src/ui/motion_engine.js';

console.log('--- Testing Milestone M2: Workspace, Instructions, Threads & Motion ---');

async function runTests() {
  // 1. Issue #208: Layered Custom Instructions
  console.log('Testing InstructionManager...');
  const instrMgr = InstructionManager.getInstance();
  const compiledGeneral = instrMgr.compile();
  assert(compiledGeneral.rulesAppliedCount >= 1);
  assert(compiledGeneral.compiledInstructions.includes('GLOBAL'));

  const compiledHn = instrMgr.compile('https://news.ycombinator.com/item?id=123');
  assert(compiledHn.compiledInstructions.includes('SITE:news.ycombinator.com'));
  assert(compiledHn.tokenEstimate > 0);
  console.log('✓ Layered instructions compilation and domain precedence verified');

  // 2. Issue #207: Template Library & Variable Interpolation
  console.log('Testing TemplateLibrary...');
  const tplLib = TemplateLibrary.getInstance();
  const templates = tplLib.getTemplates();
  assert(templates.length >= 3);

  const priceTpl = tplLib.getTemplate('tpl_price_comp');
  assert(priceTpl !== undefined);
  assert(priceTpl.variables.includes('product'));

  const interpolated = TemplateLibrary.interpolate(priceTpl.templateText, {
    store_a: 'Amazon',
    store_b: 'Best Buy',
    product: 'Sony WH-1000XM5'
  });
  assert(interpolated.includes('Sony WH-1000XM5'));
  assert(interpolated.includes('Amazon'));
  assert(interpolated.includes('Best Buy'));
  console.log('✓ Template Library starter pack and variable substitution verified');

  // 3. Issue #206: Prompt Workspace Structured Drafts
  console.log('Testing PromptWorkspaceManager...');
  const wksMgr = PromptWorkspaceManager.getInstance();
  const testDraft: StructuredMissionDraft = {
    id: 'draft_test_1',
    title: 'Monitor GPU stock',
    goal: 'Track availability of RTX 5090 GPUs under $1999',
    constraints: {
      budgetUSD: 0.10,
      deadlineMinutes: 30,
      neverSubmitOrBuy: true,
      allowedDomains: ['bestbuy.com', 'newegg.com']
    },
    successCriteria: 'Report price and stock link',
    outputFormat: 'table',
    autonomyLevel: 'ask_for_risky',
    lastModified: Date.now()
  };

  const compiledPrompt = wksMgr.compileToPrompt(testDraft);
  assert(compiledPrompt.includes('GOAL: Track availability of RTX 5090'));
  assert(compiledPrompt.includes('STRICT: Never click purchase'));
  assert(compiledPrompt.includes('OUTPUT FORMAT: Output final results as structured table'));

  wksMgr.saveDraft(testDraft);
  const retrieved = wksMgr.getDraft('draft_test_1');
  assert(retrieved !== undefined);
  assert.strictEqual(retrieved.title, 'Monitor GPU stock');
  wksMgr.deleteDraft('draft_test_1');
  console.log('✓ Structured Prompt Workspace compilation and draft persistence verified');

  // 4. Issue #210: Conversation Threads & Branching
  console.log('Testing ThreadManager...');
  const threadMgr = ThreadManager.getInstance();
  const thread = threadMgr.createThread('E-Commerce Research Thread');
  assert.strictEqual(thread.title, 'E-Commerce Research Thread');

  threadMgr.addMissionToThread(thread.id, {
    missionId: 'm_101',
    prompt: 'Find best noise-cancelling headphones',
    status: 'completed',
    result: 'Top choice: Bose QuietComfort Ultra',
    timestamp: new Date().toISOString()
  });

  const forked = threadMgr.forkThread(thread.id, 'Branch: Focus on Sony');
  assert(forked !== undefined);
  assert.strictEqual(forked.parentThreadId, thread.id);
  assert.strictEqual(forked.missions.length, 1);

  const markdown = threadMgr.exportThreadMarkdown(thread.id);
  assert(markdown.includes('# Conversation Thread: E-Commerce Research Thread'));
  assert(markdown.includes('Bose QuietComfort Ultra'));
  console.log('✓ Conversation thread creation, mission chaining, forking, and markdown export verified');

  // 5. Issue #213: Motion & Choreography Engine
  console.log('Testing ChoreographyEngine...');
  const motion = new ChoreographyEngine();

  const moveAnim = motion.mapEventToIntent({ type: 'move', x: 200, y: 300 });
  assert(moveAnim !== null);
  assert.strictEqual(moveAnim.type, 'cursor_travel');
  assert.strictEqual(moveAnim.targetX, 200);

  const clickAnim = motion.mapEventToIntent({ type: 'click', x: 200, y: 300 });
  assert(clickAnim !== null);
  assert.strictEqual(clickAnim.type, 'click_ripple');

  // Reduced motion test
  motion.setReducedMotion(true);
  const reducedAnim = motion.mapEventToIntent({ type: 'move', x: 250, y: 350 });
  assert(reducedAnim !== null);
  assert.strictEqual(reducedAnim.durationMs, 0, 'In reduced motion mode, duration must be 0ms');
  console.log('✓ ChoreographyEngine event mapping and reduced motion modes verified');

  console.log('✓ All Milestone M2 Workspace, Instructions, Threads & Motion tests passed!\n');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
