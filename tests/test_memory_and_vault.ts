import { MemoryStore, generateLocalEmbedding, cosineSimilarity } from '../src/memory/memory_store.js';
import { EncryptedVault } from '../src/memory/vault.js';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

async function runTests() {
  console.log('--- Testing MemoryStore & Vector Search ---');
  const store = new MemoryStore(':memory:');

  store.recordPage({
    url: 'https://news.ycombinator.com',
    domain: 'news.ycombinator.com',
    title: 'Hacker News',
    snippet: 'Technology news, startups, and developer discussions.',
    fullText: 'Show HN: Project Aegis, an autonomous multi-agent browser with MCTS planning and prompt injection defenses.'
  });

  store.recordPage({
    url: 'https://github.com/features/actions',
    domain: 'github.com',
    title: 'GitHub Actions - Automated CI/CD Pipelines',
    snippet: 'Automate, customize, and execute software development workflows right in your repository.',
    fullText: 'Build, test, and deploy code with world-class CI/CD. Matrix builds, Docker integration, and secrets management.'
  });

  store.recordPage({
    url: 'https://anthropic.com/claude',
    domain: 'anthropic.com',
    title: 'Claude 3.5 Sonnet - Next-Gen Intelligence',
    snippet: 'State of the art reasoning, coding, and computer use model.',
    fullText: 'Anthropic introduces Claude 3.5 Sonnet with enhanced tool use, artifacts, and multi-modal understanding.'
  });

  // 1. Test FTS Search
  const ftsResults = store.searchFTS('Aegis multi-agent');
  console.log(`[FTS] Query 'Aegis multi-agent' returned ${ftsResults.length} hits:`, ftsResults.map(r => r.page.title));
  assert.strictEqual(ftsResults.length >= 1, true);
  assert.strictEqual(ftsResults[0].page.domain, 'news.ycombinator.com');

  // 2. Test Vector Embedding & Cosine Similarity
  const v1 = generateLocalEmbedding('Autonomous AI agent browser planning');
  const v2 = generateLocalEmbedding('Autonomous agent browsing web tool');
  const v3 = generateLocalEmbedding('Cooking delicious Italian pasta recipes');
  const simRelated = cosineSimilarity(v1, v2);
  const simUnrelated = cosineSimilarity(v1, v3);
  console.log(`[Vector] Related Similarity: ${simRelated.toFixed(3)}, Unrelated: ${simUnrelated.toFixed(3)}`);
  assert.strictEqual(simRelated > simUnrelated, true);

  // 3. Test Hybrid Search
  const hybridResults = store.searchHybrid('CI/CD developer workflow', 5);
  console.log(`[Hybrid] Query 'CI/CD developer workflow' top hit: ${hybridResults[0]?.page.title} (score: ${hybridResults[0]?.score.toFixed(4)})`);
  assert.strictEqual(hybridResults.length >= 1, true);
  assert.strictEqual(hybridResults[0].page.domain, 'github.com');

  // 4. Test Daily Summary (OptMem Parity)
  const today = new Date().toISOString().slice(0, 10);
  const summary = await store.generateDailySummary(today);
  console.log(`[DailySummary] Date: ${summary.date}, Top Domains: ${summary.topDomains.join(', ')}, Page Count: ${summary.pageCount}`);
  assert.strictEqual(summary.pageCount, 3);
  assert.strictEqual(summary.topDomains.includes('news.ycombinator.com'), true);

  store.close();
  console.log('✓ MemoryStore tests passed!\n');

  console.log('--- Testing EncryptedVault ---');
  const tempVaultPath = path.join(process.cwd(), 'temp_test_vault.enc');
  if (fs.existsSync(tempVaultPath)) fs.unlinkSync(tempVaultPath);

  const vault = new EncryptedVault(tempVaultPath);
  assert.strictEqual(vault.unlock('master_secret_passphrase_123!'), true);

  vault.setSecret({
    id: 'openai_api_key',
    category: 'api_key',
    key: 'OPENAI_API_KEY',
    value: 'sk-proj-test1234567890abcdef'
  });

  vault.setSecret({
    id: 'github_session',
    category: 'cookie',
    key: 'user_session',
    value: 'gh_session_token_xyz987',
    domain: 'github.com'
  });

  assert.strictEqual(vault.getSecret('openai_api_key'), 'sk-proj-test1234567890abcdef');
  const cookies = vault.getSecretsByDomain('github.com');
  assert.strictEqual(cookies.length, 1);
  assert.strictEqual(cookies[0].value, 'gh_session_token_xyz987');

  vault.lock();
  assert.strictEqual(vault.getUnlocked(), false);

  // Re-open with wrong passphrase -> must fail
  const wrongVault = new EncryptedVault(tempVaultPath);
  assert.strictEqual(wrongVault.unlock('wrong_passphrase'), false);

  // Re-open with correct passphrase -> must succeed and decrypt entries
  const correctVault = new EncryptedVault(tempVaultPath);
  assert.strictEqual(correctVault.unlock('master_secret_passphrase_123!'), true);
  assert.strictEqual(correctVault.getSecret('openai_api_key'), 'sk-proj-test1234567890abcdef');

  if (fs.existsSync(tempVaultPath)) fs.unlinkSync(tempVaultPath);
  console.log('✓ EncryptedVault tests passed!\n');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
