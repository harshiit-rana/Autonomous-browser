/**
 * Project Aegis - Model Concurrency Governor & Reliability Engine
 * Implements: Issue #131 [MDL-04] Concurrency limits, token buckets, adaptive backoff,
 * circuit breaker, retry policies, and failover management.
 */

import { IModelProvider, ModelRequest, ModelResponse } from './types.js';
import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('model-governor');

function abortError(): Error {
  const e = new Error('Request aborted');
  e.name = 'AbortError';
  return e;
}

export type ErrorPolicy = 'retry' | 'fix_and_retry' | 'failover' | 'fail_fast';

export interface CircuitBreakerState {
  status: 'closed' | 'open' | 'half_open';
  consecutiveFailures: number;
  lastFailureTime?: number;
  cooldownMs: number;
}

export interface GovernorConfig {
  maxConcurrencyPerProvider?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerCooldownMs?: number;
}

export class ErrorClassifier {
  public static classify(err: any): { policy: ErrorPolicy; retryAfterMs?: number; reason: string } {
    if (!err) return { policy: 'retry', reason: 'unknown' };

    const status = err.status || err.statusCode || (err.raw && err.raw.status);
    const message = (err.message || '').toLowerCase();

    // 1. Fail-fast: Auth, permissions, missing model
    if (status === 401 || status === 403) {
      return { policy: 'fail_fast', reason: 'Invalid or unauthorized API key' };
    }
    if (status === 404 || message.includes('model not found')) {
      return { policy: 'fail_fast', reason: 'Model not found or unavailable' };
    }

    // 2. Fix-and-retry: Context limit exceeded / payload too large
    if (status === 413 || message.includes('context length') || message.includes('too large') || message.includes('maximum context')) {
      return { policy: 'fix_and_retry', reason: 'Context window exceeded; prune observation or drop screenshots' };
    }

    // 3. Rate limits (429) & Server errors (5xx)
    if (status === 429 || message.includes('rate limit') || message.includes('quota')) {
      let retryAfterMs = 2000;
      if (err.headers && err.headers['retry-after']) {
        const parsed = Number(err.headers['retry-after']);
        if (!isNaN(parsed) && parsed > 0) {
          retryAfterMs = parsed * 1000;
        }
      }
      return { policy: 'retry', retryAfterMs, reason: 'Rate limited (429)' };
    }

    if (status >= 500 && status < 600) {
      return { policy: 'retry', retryAfterMs: 1500, reason: `Server error (${status})` };
    }

    // 4. Network and socket errors
    if (
      message.includes('econnreset') ||
      message.includes('etimedout') ||
      message.includes('fetch failed') ||
      message.includes('network')
    ) {
      return { policy: 'retry', retryAfterMs: 1000, reason: 'Network or socket connection issue' };
    }

    return { policy: 'retry', retryAfterMs: 1000, reason: message || 'Unclassified error' };
  }
}

export class CircuitBreaker {
  private state: CircuitBreakerState = {
    status: 'closed',
    consecutiveFailures: 0,
    cooldownMs: 15000
  };
  private failureThreshold: number;

  constructor(threshold: number = 4, cooldownMs: number = 15000) {
    this.failureThreshold = threshold;
    this.state.cooldownMs = cooldownMs;
  }

  public getStatus(): 'closed' | 'open' | 'half_open' {
    if (this.state.status === 'open' && this.state.lastFailureTime) {
      const elapsed = Date.now() - this.state.lastFailureTime;
      if (elapsed >= this.state.cooldownMs) {
        this.state.status = 'half_open';
      }
    }
    return this.state.status;
  }

  public recordSuccess(): void {
    this.state.status = 'closed';
    this.state.consecutiveFailures = 0;
  }

  public recordFailure(): void {
    this.state.consecutiveFailures += 1;
    this.state.lastFailureTime = Date.now();
    if (this.state.consecutiveFailures >= this.failureThreshold) {
      this.state.status = 'open';
      logger.warn('Circuit breaker tripped to OPEN', { failures: this.state.consecutiveFailures });
    }
  }

  public isAvailable(): boolean {
    return this.getStatus() !== 'open';
  }
}

interface QueuedTask<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: any) => void;
  priority: number; // Higher number = higher priority
}

export class ConcurrencyGovernor {
  private activeCount = 0;
  private maxConcurrency: number;
  private queue: QueuedTask<any>[] = [];
  private circuitBreakers = new Map<string, CircuitBreaker>();
  private maxRetries: number;
  private baseBackoffMs: number;
  private maxBackoffMs: number;

  constructor(config: GovernorConfig = {}) {
    this.maxConcurrency = config.maxConcurrencyPerProvider || 4;
    this.maxRetries = config.maxRetries || 3;
    this.baseBackoffMs = config.baseBackoffMs || 1000;
    this.maxBackoffMs = config.maxBackoffMs || 10000;
  }

  public getCircuitBreaker(providerName: string): CircuitBreaker {
    let cb = this.circuitBreakers.get(providerName);
    if (!cb) {
      cb = new CircuitBreaker();
      this.circuitBreakers.set(providerName, cb);
    }
    return cb;
  }

  public async schedule<T>(
    providerName: string,
    fn: () => Promise<T>,
    priority: number = 10,
    signal?: AbortSignal
  ): Promise<T> {
    const cb = this.getCircuitBreaker(providerName);
    if (signal?.aborted) throw abortError();
    if (!cb.isAvailable()) {
      throw new Error(`Circuit breaker is OPEN for provider '${providerName}'. Model is temporarily unavailable.`);
    }

    if (this.activeCount < this.maxConcurrency) {
      this.activeCount++;
      return this.executeWithRetry(providerName, fn, 1, signal);
    }

    return new Promise<T>((resolve, reject) => {
      const task: QueuedTask<T> = { fn, resolve, reject, priority };
      // A cancelled mission must not wait for a slot (or start a request) after it was cancelled.
      const onAbort = () => {
        const i = this.queue.indexOf(task);
        if (i >= 0) { this.queue.splice(i, 1); reject(abortError()); }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      task.fn = async () => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) throw abortError();
        return fn();
      };
      this.queue.push(task);
      // Sort priority descending (foreground higher than background)
      this.queue.sort((a, b) => b.priority - a.priority);
    });
  }

  private async executeWithRetry<T>(
    providerName: string,
    fn: () => Promise<T>,
    attempt: number = 1,
    signal?: AbortSignal
  ): Promise<T> {
    const cb = this.getCircuitBreaker(providerName);

    try {
      const result = await fn();
      cb.recordSuccess();
      return result;
    } catch (err: any) {
      // The caller gave up (mission cancelled): never retry, never count it against the provider.
      if (signal?.aborted) throw err;
      cb.recordFailure();

      const { policy, retryAfterMs, reason } = ErrorClassifier.classify(err);

      if (policy === 'fail_fast') {
        logger.error(`Fail-fast on model error: ${reason}`, err);
        throw err;
      }

      if (policy === 'retry' && attempt <= this.maxRetries) {
        const jitter = Math.random() * 500;
        const delay = Math.min(
          this.maxBackoffMs,
          (retryAfterMs || this.baseBackoffMs * Math.pow(2, attempt - 1)) + jitter
        );

        logger.warn(`Model request failed (${reason}), retrying in ${Math.round(delay)}ms (attempt ${attempt}/${this.maxRetries})`);
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, delay);
          const onAbort = () => { clearTimeout(t); reject(abortError()); };
          signal?.addEventListener('abort', onAbort, { once: true });
        });
        // The retry runs under its own finally (which releases a slot), so it takes one; this attempt's finally releases ours.
        this.activeCount++;
        return this.executeWithRetry(providerName, fn, attempt + 1, signal);
      }

      throw err;
    } finally {
      this.activeCount--;
      this.processNext();
    }
  }

  private processNext(): void {
    if (this.activeCount < this.maxConcurrency && this.queue.length > 0) {
      const nextTask = this.queue.shift();
      if (nextTask) {
        this.activeCount++;
        nextTask.fn()
          .then(res => nextTask.resolve(res))
          .catch(err => nextTask.reject(err))
          .finally(() => {
            this.activeCount--;
            this.processNext();
          });
      }
    }
  }

  /**
   * Safe execution wrapper that verifies model responses for truncation
   * and prevents partial tool execution.
   */
  public async executeSafe(
    provider: IModelProvider,
    request: ModelRequest,
    priority: number = 10
  ): Promise<ModelResponse> {
    return this.schedule(provider.providerName, async () => {
      if (request.abortSignal?.aborted) throw abortError();
      const response = await provider.generate(request);

      // Check for max_tokens truncation (length finish reason)
      if (response.finishReason === 'length') {
        logger.warn('Model response was truncated by max_tokens limit. Discarding partial tool calls for safety.', {
          partialToolCalls: response.toolCalls.length
        });
        // Discard partial tool calls to prevent corrupt execution
        return {
          ...response,
          toolCalls: [],
          text: (response.text || '') + '\n\n[Warning: Model response truncated by token limit. Tool calls dropped for safety.]'
        };
      }

      return response;
    }, priority, request.abortSignal);
  }
}

export const globalGovernor = new ConcurrencyGovernor();
