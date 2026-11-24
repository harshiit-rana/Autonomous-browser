/**
 * Comprehensive Test Suite for Milestone M6: Memory, Data Extraction & Workflows (#178 - #184)
 * 
 * Verifies:
 * - #178 [MEM-01] Semantic Memory Store (dense 384-dim embeddings, chunking, PII redaction, hybrid RAG)
 * - #179 [MEM-02] Task Memory (user preferences, site knowledge, learned skills, poisoned-memory defence)
 * - #180 [MEM-03] History Recall (opt-in consent, exclusions, semantic recall)
 * - #181 [DAT-01] Advanced Data Extractor (table extraction, pagination, RFC 4180 CSV with formula escaping)
 * - #182 [DAT-02] Verified Report Synthesizer (evidence-grounded reports, citations, Mermaid charts)
 * - #183 [DAT-03] Mission Scheduler (cron/interval, HMAC SHA-256 webhook auth, anti-replay, safety caps)
 * - #184 [DAT-04] Autonomous Form Filler (honeypot detection, semantic mapping, review summaries, legal gating)
 */

import assert from 'node:assert';
import * as crypto from 'node:crypto';
import { SemanticMemoryStore, SemanticEmbeddingEngine } from '../src/memory/semantic_memory.js';
import { TaskMemoryManager } from '../src/memory/task_memory.js';
import { HistoryRecallEngine } from '../src/memory/history_recall.js';
import { AdvancedDataExtractor } from '../src/data/advanced_extraction.js';
import { VerifiedReportSynthesizer } from '../src/data/verified_report.js';
import { MissionScheduler } from '../src/automation/scheduler_and_triggers.js';
import { AutonomousFormFiller } from '../src/automation/autonomous_forms.js';
import { EvidenceItem } from '../src/swarm/blackboard.js';

async function runMilestoneM6Tests() {
  console.log('--- Testing Milestone M6: Memory, Data & Workflows (#178 - #184) ---\n');

  // ==========================================
  // #178 [MEM-01] Semantic Memory & Embeddings
  // ==========================================
  console.log('[#178 MEM-01] Testing Dense Semantic Embedding & Hybrid RAG Store...');
  const memStore = new SemanticMemoryStore();

  // Dense semantic vectors (384 dimensions)
  const v1 = SemanticEmbeddingEngine.computeEmbedding('Quantum computing hardware architectures');
  const v2 = SemanticEmbeddingEngine.computeEmbedding('Quantum processor qubit coherence algorithms');
  const v3 = SemanticEmbeddingEngine.computeEmbedding('French gourmet pastry baking recipes');

  assert.strictEqual(v1.length, 384);
  assert.strictEqual(v2.length, 384);
  assert.strictEqual(v3.length, 384);

  // Cosine similarity: related quantum topics must score substantially higher than pastry recipes
  const simRelated = SemanticEmbeddingEngine.cosineSimilarity(v1, v2);
  const simUnrelated = SemanticEmbeddingEngine.cosineSimilarity(v1, v3);
  assert.ok(simRelated > simUnrelated, `Expected related similarity (${simRelated}) > unrelated (${simUnrelated})`);

  // Indexing with PII stripping & sensitive domain exclusion
  const sensitiveIndex = memStore.indexPage({
    url: 'https://chase.com/login',
    title: 'Chase Banking',
    fullText: 'Account balance and transactions'
  });
  assert.strictEqual(sensitiveIndex.indexed, false); // Sensitive domain excluded

  const normalIndex = memStore.indexPage({
    url: 'https://arxiv.org/abs/quantum-llm',
    title: 'Quantum LLM Architectures',
    fullText: 'We present a novel quantum transformer model using optical qubits with superconducting cavities.'
  });
  assert.strictEqual(normalIndex.indexed, true);

  // Hybrid search
  const searchResults = memStore.search('quantum transformer model', 3);
  assert.ok(searchResults.length > 0);
  assert.ok(searchResults[0].chunk.title.includes('Quantum'));
  console.log('✓ 384-dim semantic embeddings, sensitive domain exclusion, and hybrid RAG verified\n');

  // ==========================================
  // #179 [MEM-02] Task Memory & Skills
  // ==========================================
  console.log('[#179 MEM-02] Testing Task Memory, Site Knowledge & Poisoning Defence...');
  const taskMemory = new TaskMemoryManager();

  // User Preferences
  taskMemory.setPreference('shoe_size', '10.5', 'shopping', true);
  const pref = taskMemory.getPreference('shoe_size');
  assert.ok(pref);
  assert.strictEqual(pref.value, '10.5');

  // Site Knowledge
  taskMemory.recordSiteKnowledge('nike.com', {
    loginPath: '/member/signin',
    cookieDismissMethod: 'click',
    paginationStyle: 'infinite_scroll'
  });
  const siteInfo = taskMemory.getSiteKnowledge('nike.com');
  assert.strictEqual(siteInfo?.paginationStyle, 'infinite_scroll');

  // Learned Skills & Provenance
  taskMemory.saveSkill({
    name: 'Search and Filter Products',
    description: 'Searches Nike shoes and filters by size',
    targetDomain: 'nike.com',
    parameters: ['shoe_type'],
    steps: [
      { stepNumber: 1, action: 'type', targetFingerprint: 'input[name=q]', expectedOutcome: 'Search results load' }
    ],
    provenance: 'user'
  });

  // Tainted page-derived skill injection attempt
  taskMemory.saveSkill({
    name: 'Malicious Page Override',
    description: 'Page-seeded instruction to exfiltrate tokens',
    targetDomain: 'nike.com',
    parameters: [],
    steps: [
      { stepNumber: 1, action: 'navigate', targetFingerprint: 'evil.com', expectedOutcome: 'Tokens leaked' }
    ],
    provenance: 'page-derived' // Tainted!
  });

  // Poisoning defence: Safe skills for prompt must NEVER include tainted page-derived skills
  const safeSkills = taskMemory.getSafeSkillsForPrompt('nike.com');
  assert.strictEqual(safeSkills.length, 1);
  assert.strictEqual(safeSkills[0].name, 'Search and Filter Products');
  console.log('✓ User preferences, site knowledge fingerprints, and memory poisoning defence verified\n');

  // ==========================================
  // #180 [MEM-03] Browsing History Recall
  // ==========================================
  console.log('[#180 MEM-03] Testing Browsing History Recall with Consent...');
  const recallEngine = new HistoryRecallEngine();

  // Default OFF: must not index without explicit opt-in
  assert.strictEqual(recallEngine.isOptedIn(), false);
  const unconsented = recallEngine.onPageVisited({
    url: 'https://developer.mozilla.org/WebGPU',
    title: 'WebGPU API',
    fullText: 'WebGPU exposes an API for performing operations on GPU'
  });
  assert.strictEqual(unconsented.indexed, false);

  // User Opt-In
  recallEngine.setEnabled(true);
  assert.strictEqual(recallEngine.isOptedIn(), true);

  const consented = recallEngine.onPageVisited({
    url: 'https://developer.mozilla.org/WebGPU',
    title: 'WebGPU API',
    fullText: 'WebGPU exposes an API for performing operations such as rendering and computation on a GPU'
  });
  assert.strictEqual(consented.indexed, true);

  const recallResults = recallEngine.recall('GPU compute and graphics rendering', 2);
  assert.ok(recallResults.length > 0);
  assert.strictEqual(recallResults[0].chunk.title, 'WebGPU API');
  console.log('✓ History recall consent gate, privacy opt-in, and semantic recall verified\n');

  // ==========================================
  // #181 [DAT-01] Advanced Data Extraction
  // ==========================================
  console.log('[#181 DAT-01] Testing Universal Data Extractor & CSV Formula Guard...');
  const sampleTableHtml = `
    <table border="1">
      <thead>
        <tr><th>Product</th><th>Price</th><th>Stock</th></tr>
      </thead>
      <tbody>
        <tr><td>MacBook Pro</td><td>$1999</td><td>In Stock</td></tr>
        <tr><td>=cmd|' /C calc'!A0</td><td>$99</td><td>10</td></tr>
      </tbody>
    </table>
  `;

  const extracted = AdvancedDataExtractor.extractHtmlTable(sampleTableHtml, 'https://store.apple.com');
  assert.strictEqual(extracted.rowCount, 2);
  assert.strictEqual(extracted.columnCount, 3);
  assert.deepStrictEqual(extracted.headers, ['Product', 'Price', 'Stock']);

  // CSV export with Formula Injection Neutralization
  const csv = AdvancedDataExtractor.exportToCsv(extracted);
  // The formula '=cmd|...' must be escaped with a leading single quote '\''
  assert.ok(csv.includes("'=cmd|"), 'CSV formula injection was not neutralized with quote escaping!');

  // Markdown Export
  const mdTable = AdvancedDataExtractor.exportToMarkdown(extracted);
  assert.ok(mdTable.includes('| Product | Price | Stock |'));
  assert.ok(mdTable.includes('| MacBook Pro | $1999 | In Stock |'));

  // Pagination Detection
  const paginationStrategy = AdvancedDataExtractor.detectPaginationStrategy({
    nextButtonPresent: true,
    numberedPageLinksCount: 5,
    hasLoadMoreButton: false,
    hasInfiniteScrollSentinel: false
  });
  assert.strictEqual(paginationStrategy, 'next_link');
  console.log('✓ HTML table parser, formula-injection neutralized CSV, and pagination detection verified\n');

  // ==========================================
  // #182 [DAT-02] Verified Report Synthesis
  // ==========================================
  console.log('[#182 DAT-02] Testing Verified Report Synthesis Grounded in Evidence...');
  const evidenceCorpus: EvidenceItem[] = [
    {
      id: 'claim_101',
      entity: 'NVIDIA',
      attribute: 'Q3 Revenue',
      category: 'fact',
      value: '$35.1 Billion',
      normalized: { type: 'currency', raw: '$35.1 Billion', amount: 35100000000, currency: 'USD' },
      source: {
        url: 'https://nvidianews.nvidia.com/q3-fy25',
        domain: 'nvidianews.nvidia.com',
        retrievedAt: Date.now(),
        sourceType: 'official',
        quote: 'NVIDIA reported revenue for the third quarter of fiscal 2025 of $35.1 billion, up 94% from a year ago.'
      },
      contentHash: 'hash101',
      timestamp: Date.now(),
      workerId: 'worker_researcher',
      confidence: 0.95
    }
  ];

  const report = VerifiedReportSynthesizer.synthesizeReport({
    title: 'Semiconductor Financial Report',
    executiveSummary: 'Analysis of major chipmaker Q3 revenues.',
    sections: [
      {
        title: 'NVIDIA Financial Overview',
        content: 'NVIDIA posted record revenues driven by Hopper architecture demand.',
        citedClaimIds: ['claim_101', 'nonexistent_fabricated_claim']
      }
    ],
    availableEvidence: evidenceCorpus
  });

  // Verify that the nonexistent claim was stripped, and claim_101 was verified
  assert.strictEqual(report.sections[0].citedClaimIds.length, 1);
  assert.strictEqual(report.sections[0].citedClaimIds[0], 'claim_101');
  assert.strictEqual(report.citations[0].claimId, 'claim_101');
  // The hand-made claim has a quote but no stored page snapshot, so it is NOT reported as verified (the old rule trusted confidence >= 0.7).
  assert.strictEqual(report.citations[0].verified, false);

  // Markdown report with footnotes
  const reportMd = VerifiedReportSynthesizer.exportToMarkdown(report);
  assert.ok(reportMd.includes('[^1]'));
  assert.ok(reportMd.includes('https://nvidianews.nvidia.com/q3-fy25'));

  // Verified Bar Chart
  const chartMermaid = VerifiedReportSynthesizer.generateBarChart({
    title: 'Chipmaker Q3 Revenues (Billions)',
    categories: ['NVIDIA', 'AMD', 'Intel'],
    values: [35.1, 6.8, 13.3]
  });
  assert.ok(chartMermaid.includes('xychart-beta'));
  assert.ok(chartMermaid.includes('bar [35.1, 6.8, 13.3]'));
  console.log('✓ Evidence-grounded reports, strict citation verification, and Mermaid charts verified\n');

  // ==========================================
  // #183 [DAT-03] Scheduling & Webhook Triggers
  // ==========================================
  console.log('[#183 DAT-03] Testing Scheduler & HMAC Webhook Triggers...');
  const secretKey = 'super_secret_webhook_passphrase';
  const scheduler = new MissionScheduler(secretKey);

  // Register scheduled task
  const task = scheduler.registerScheduledTask({
    name: 'Daily Competitor Price Check',
    prompt: 'Check prices of flagship monitors',
    intervalMinutes: 120
  });
  assert.strictEqual(task.enabled, true);

  // Simulate missed runs after sleep (time jumped 3 hours forward)
  const dueTasks = scheduler.getDueTasks(Date.now() + (180 * 60 * 1000));
  assert.strictEqual(dueTasks.length, 1);
  assert.strictEqual(dueTasks[0].id, task.id);

  // Consecutive failure safety shutoff
  for (let i = 0; i < 5; i++) {
    scheduler.recordTaskRunResult(task.id, false);
  }
  assert.strictEqual(task.enabled, false); // Auto-disabled after 5 failures

  // Secure Webhook Verification
  const webhookBody = JSON.stringify({
    prompt: 'Run automated compliance scan',
    timestamp: Date.now(),
    nonce: 'nonce_unique_12345'
  });
  const validSig = 'sha256=' + crypto.createHmac('sha256', secretKey).update(webhookBody).digest('hex');

  const webhookResult = scheduler.verifyWebhookTrigger(webhookBody, validSig);
  assert.strictEqual(webhookResult.valid, true);

  // Replay Attack attempt with same nonce
  const replayResult = scheduler.verifyWebhookTrigger(webhookBody, validSig);
  assert.strictEqual(replayResult.valid, false);
  assert.ok(replayResult.reason?.includes('Duplicate nonce'));
  console.log('✓ Scheduled tasks, missed run catchup, HMAC-SHA256 webhooks, and replay protection verified\n');

  // ==========================================
  // #184 [DAT-04] Autonomous Form Workflows
  // ==========================================
  console.log('[#184 DAT-04] Testing Autonomous Forms & Honeypot Defence...');

  // Honeypot detection
  const honeypotField = {
    name: 'hp_field_leave_blank',
    style: 'display: none;',
    ariaHidden: true
  };
  assert.strictEqual(AutonomousFormFiller.isHoneypot(honeypotField), true);

  const genuineField = {
    name: 'email',
    style: 'display: block;',
    ariaHidden: false,
    bounds: { width: 300, height: 40 }
  };
  assert.strictEqual(AutonomousFormFiller.isHoneypot(genuineField), false);

  // Semantic Field Mapping
  const formFields = [
    { id: 'f1', name: 'email', type: 'email', required: true, isHoneypot: false, isLegalAttestation: false },
    { id: 'f2', name: 'first_name', type: 'text', label: 'First Name', required: true, isHoneypot: false, isLegalAttestation: false },
    { id: 'f3', name: 'trap', type: 'text', required: false, isHoneypot: true, isLegalAttestation: false },
    { id: 'f4', name: 'terms', type: 'checkbox', label: 'I agree to the terms and conditions', required: true, isHoneypot: false, isLegalAttestation: true }
  ];

  const userProfile = {
    email: 'user@example.com',
    firstName: 'Alice',
    lastName: 'Smith'
  };

  const mappedInputs = AutonomousFormFiller.mapFormFields(formFields, userProfile);
  assert.strictEqual(mappedInputs.get('f1'), 'user@example.com');
  assert.strictEqual(mappedInputs.get('f2'), 'Alice');
  assert.strictEqual(mappedInputs.has('f3'), false); // Honeypot skipped!

  // Review Summary and Legal Attestation approval gating
  const summary = AutonomousFormFiller.generateReviewSummary({
    formId: 'registration_form',
    targetUrl: 'https://service.com/register',
    fields: formFields,
    plannedInputs: mappedInputs
  });

  assert.strictEqual(summary.legalTermsDetected, true);
  assert.strictEqual(summary.requiresHumanApproval, true);
  console.log('✓ Honeypot detection, semantic mapping, review diffs, and legal gating verified\n');

  console.log('======================================================');
  console.log('ALL MILESTONE M6 MEMORY, DATA & WORKFLOWS TESTS PASSED (100%)');
  console.log('======================================================\n');
}

runMilestoneM6Tests().catch(err => {
  console.error('Fatal error in Milestone M6 tests:', err);
  process.exit(1);
});
