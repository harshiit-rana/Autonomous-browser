import assert from 'node:assert';
import {
  ErrorClassifier,
  CircuitBreaker,
  ConcurrencyGovernor
} from '../src/models/governor.js';
import { IModelProvider, ModelRequest, ModelResponse } from '../src/models/types.js';

console.log('--- Testing Milestone M1: Model Reliability & Concurrency Governor (Issue #131) ---');

async function runTests() {
  // 1. Test ErrorClassifier
  console.log('Testing ErrorClassifier...');
  const authErr = { status: 401, message: 'Unauthorized' };
  assert.strictEqual(ErrorClassifier.classify(authErr).policy, 'fail_fast');

  const modelNotFound = { status: 404, message: 'Model claude-99 not found' };
  assert.strictEqual(ErrorClassifier.classify(modelNotFound).policy, 'fail_fast');

  const contextOverflow = { status: 413, message: 'Context window exceeded maximum length' };
  assert.strictEqual(ErrorClassifier.classify(contextOverflow).policy, 'fix_and_retry');

  const rateLimit = {
    status: 429,
    message: 'Rate limit exceeded',
    headers: { 'retry-after': '3' }
  };
  const rateLimitClass = ErrorClassifier.classify(rateLimit);
  assert.strictEqual(rateLimitClass.policy, 'retry');
  assert.strictEqual(rateLimitClass.retryAfterMs, 3000);

  const serverErr = { status: 503, message: 'Service Unavailable' };
  assert.strictEqual(ErrorClassifier.classify(serverErr).policy, 'retry');

  const netErr = { message: 'read ECONNRESET' };
  assert.strictEqual(ErrorClassifier.classify(netErr).policy, 'retry');
  console.log('✓ ErrorClassifier classification policies verified');

  // 2. Test CircuitBreaker
  console.log('Testing CircuitBreaker...');
  const cb = new CircuitBreaker(3, 100); // 3 failures threshold, 100ms cooldown
  assert.strictEqual(cb.getStatus(), 'closed');
  assert.strictEqual(cb.isAvailable(), true);

  cb.recordFailure();
  cb.recordFailure();
  assert.strictEqual(cb.getStatus(), 'closed');

  cb.recordFailure(); // 3rd failure trips the breaker
  assert.strictEqual(cb.getStatus(), 'open');
  assert.strictEqual(cb.isAvailable(), false);

  // Wait for cooldown
  await new Promise(r => setTimeout(r, 120));
  assert.strictEqual(cb.getStatus(), 'half_open');

  cb.recordSuccess();
  assert.strictEqual(cb.getStatus(), 'closed');
  console.log('✓ CircuitBreaker state transitions (closed -> open -> half_open -> closed) verified');

  // 3. Test Concurrency Governor Priority Queue
  console.log('Testing ConcurrencyGovernor priority queue & concurrency limiting...');
  const governor = new ConcurrencyGovernor({
    maxConcurrencyPerProvider: 1,
    maxRetries: 1,
    baseBackoffMs: 10
  });

  const executionOrder: string[] = [];

  // Launch low-priority task 1 (occupies the single slot)
  const p1 = governor.schedule('test-provider', async () => {
    await new Promise(r => setTimeout(r, 50));
    executionOrder.push('task-low-1');
    return 'done1';
  }, 1);

  // Queue low-priority task 2
  const p2 = governor.schedule('test-provider', async () => {
    executionOrder.push('task-low-2');
    return 'done2';
  }, 1);

  // Queue high-priority task 3 (should jump ahead of task-low-2)
  const p3 = governor.schedule('test-provider', async () => {
    executionOrder.push('task-high-3');
    return 'done3';
  }, 100);

  await Promise.all([p1, p2, p3]);
  assert.deepStrictEqual(executionOrder, ['task-low-1', 'task-high-3', 'task-low-2']);
  console.log('✓ ConcurrencyGovernor priority ordering verified');

  // 4. Test Truncation Protection in executeSafe
  console.log('Testing Truncation Protection in executeSafe...');
  const mockTruncatedProvider: IModelProvider = {
    providerName: 'mock',
    modelName: 'mock-model',
    async generate(req: ModelRequest): Promise<ModelResponse> {
      return {
        text: '{"result": "incom',
        toolCalls: [
          {
            id: 'call_cut',
            name: 'click',
            arguments: { ref: 'e1' }
          }
        ],
        finishReason: 'length'
      };
    }
  };

  const safeGov = new ConcurrencyGovernor();
  const safeRes = await safeGov.executeSafe(mockTruncatedProvider, { messages: [] });
  assert.strictEqual(safeRes.finishReason, 'length');
  assert.strictEqual(safeRes.toolCalls.length, 0, 'Truncated tool calls must be discarded for safety');
  assert(safeRes.text.includes('Warning: Model response truncated by token limit'));
  console.log('✓ Truncation protection (dropping partial tool calls) verified');

  console.log('✓ All Model Reliability & Concurrency Governor tests passed!\n');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
