import assert from 'node:assert';
import { credentialVault, ROUTING_PRESETS } from '../src/infrastructure/credentials.js';

console.log('--- Testing Milestone M1: Credentials Vault & Role Routing (Issue #133) ---');

async function runTests() {
  // 1. In-memory / SafeStorage key persistence
  console.log('Testing CredentialVault storage and retrieval...');
  await credentialVault.setKey('anthropic', '  sk-ant-test-sample-key-12345  ');

  const retrieved = await credentialVault.getKey('anthropic');
  assert.strictEqual(retrieved, 'sk-ant-test-sample-key-12345', 'Retrieved key must be whitespace-trimmed');

  const retrievedSync = credentialVault.getKeySync('anthropic');
  assert.strictEqual(retrievedSync, 'sk-ant-test-sample-key-12345', 'Synchronous key lookup must match');

  await credentialVault.deleteKey('anthropic');
  const deleted = await credentialVault.getKey('anthropic');
  assert.strictEqual(deleted, undefined, 'Deleted key must return undefined');
  console.log('✓ CredentialVault setKey, getKey, and deleteKey verified');

  // 2. Test Presets
  console.log('Testing Routing Presets...');
  assert(ROUTING_PRESETS.fast_cheap.planner.provider === 'gemini');
  assert(ROUTING_PRESETS.balanced.planner.provider === 'anthropic');
  assert(ROUTING_PRESETS.max_quality.verifier.provider === 'openai');
  assert(ROUTING_PRESETS.local_only.planner.provider === 'ollama');
  console.log('✓ Routing Presets (fast_cheap, balanced, max_quality, local_only) verified');

  // 3. Test Probe Validation logic
  console.log('Testing Credential Verification error branches...');
  const emptyRes = await credentialVault.testCredentials('gemini', '   ');
  assert.strictEqual(emptyRes.valid, false);
  assert(emptyRes.message.includes('cannot be empty'));

  const badProvider = await credentialVault.testCredentials('nonexistent-cloud' as any, 'key');
  assert.strictEqual(badProvider.valid, false);
  assert(badProvider.message.includes('Unknown provider'));
  console.log('✓ Credential validation probe branches verified');

  console.log('✓ All Credential Vault & Role Routing tests passed!\n');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
