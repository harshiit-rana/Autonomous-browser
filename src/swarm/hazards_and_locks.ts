/**
 * Project Aegis - Cross-Worker Hazards & Side-Effect Serialisation Engine
 * 
 * Implements Issue #151 [SWM-05]:
 * - Named resource locks per (account, site) and (cart, site)
 * - Side-effect serialisation: at most one actor holds a write lock
 * - Deadlock prevention with TTL auto-expiry
 * - Idempotency ledger with pre-action intent & post-action verification
 * - Cross-worker session interference detection & OTP/login throttling
 */

import { logger } from '../infrastructure/logger.js';

export type EffectClass = 'read' | 'write-idempotent' | 'write-non-idempotent' | 'financial';

export interface ResourceLock {
  resourceKey: string;
  workerId: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface IdempotencyRecord {
  idempotencyKey: string;
  resourceKey: string;
  actionName: string;
  intentRecordedAt: number;
  status: 'pending' | 'committed' | 'failed';
  resultEvidence?: string;
  committedAt?: number;
}

export class HazardLockManager {
  private locks: Map<string, ResourceLock> = new Map(); // resourceKey -> lock
  private idempotencyLedger: Map<string, IdempotencyRecord> = new Map();
  private loginAttempts: Map<string, number[]> = new Map(); // site -> timestamps

  /**
   * Generates a canonical resource key, e.g. "account:amazon.com:user_default" or "cart:store.com"
   */
  public static makeKey(type: 'account' | 'cart' | 'form', origin: string, id: string = 'default'): string {
    return `${type}:${origin.toLowerCase()}:${id.toLowerCase()}`;
  }

  /**
   * Attempts to acquire an exclusive lock for a side-effecting resource
   */
  public acquireLock(resourceKey: string, workerId: string, ttlMs: number = 30000): { acquired: boolean; reason?: string; lock?: ResourceLock } {
    const now = Date.now();
    const existing = this.locks.get(resourceKey);

    if (existing) {
      if (now < existing.expiresAt) {
        if (existing.workerId === workerId) {
          // Re-entrant lock extension
          existing.expiresAt = now + ttlMs;
          return { acquired: true, lock: existing };
        }
        return {
          acquired: false,
          reason: `Resource ${resourceKey} is locked by worker ${existing.workerId} until ${new Date(existing.expiresAt).toISOString()}`
        };
      }
      // Expired lock: force release
      logger.warn('Releasing expired resource lock', { resourceKey, previousHolder: existing.workerId });
      this.locks.delete(resourceKey);
    }

    const lock: ResourceLock = {
      resourceKey,
      workerId,
      acquiredAt: now,
      expiresAt: now + ttlMs
    };

    this.locks.set(resourceKey, lock);
    logger.info('Acquired exclusive resource lock', { resourceKey, workerId, ttlMs });
    return { acquired: true, lock };
  }

  /**
   * Releases an acquired resource lock
   */
  public releaseLock(resourceKey: string, workerId: string): boolean {
    const existing = this.locks.get(resourceKey);
    if (!existing) return true;

    if (existing.workerId !== workerId && Date.now() < existing.expiresAt) {
      logger.warn('Worker unauthorized to release lock', { resourceKey, actualWorker: existing.workerId, callerWorker: workerId });
      return false;
    }

    this.locks.delete(resourceKey);
    logger.info('Released resource lock', { resourceKey, workerId });
    return true;
  }

  /**
   * Records intent before executing a side-effecting action
   */
  public recordPreActionIntent(idempotencyKey: string, resourceKey: string, actionName: string): IdempotencyRecord {
    const existing = this.idempotencyLedger.get(idempotencyKey);
    if (existing) {
      return existing;
    }

    const record: IdempotencyRecord = {
      idempotencyKey,
      resourceKey,
      actionName,
      intentRecordedAt: Date.now(),
      status: 'pending'
    };

    this.idempotencyLedger.set(idempotencyKey, record);
    logger.info('Idempotency pre-action intent logged', { idempotencyKey, resourceKey, actionName });
    return record;
  }

  /**
   * Commits the outcome of a side-effecting action
   */
  public commitActionOutcome(idempotencyKey: string, success: boolean, evidence?: string): void {
    const record = this.idempotencyLedger.get(idempotencyKey);
    if (!record) return;

    record.status = success ? 'committed' : 'failed';
    record.resultEvidence = evidence;
    record.committedAt = Date.now();
    logger.info('Idempotency action committed', { idempotencyKey, status: record.status });
  }

  /**
   * Verifies whether an action was already successfully executed before retrying
   */
  public checkIdempotency(idempotencyKey: string): { isDuplicate: boolean; status?: string; evidence?: string } {
    const record = this.idempotencyLedger.get(idempotencyKey);
    if (record && record.status === 'committed') {
      return {
        isDuplicate: true,
        status: record.status,
        evidence: record.resultEvidence
      };
    }
    return { isDuplicate: false };
  }

  /**
   * Checks if login or OTP rate limits are exceeded for a target site across workers
   */
  public canAttemptAuth(site: string, maxPerWindow: number = 2, windowMs: number = 60000): boolean {
    const now = Date.now();
    const attempts = (this.loginAttempts.get(site) || []).filter(t => now - t < windowMs);

    if (attempts.length >= maxPerWindow) {
      logger.warn('Auth action throttled across workers for site', { site, attemptCount: attempts.length });
      return false;
    }

    attempts.push(now);
    this.loginAttempts.set(site, attempts);
    return true;
  }

  public clear(): void {
    this.locks.clear();
    this.idempotencyLedger.clear();
    this.loginAttempts.clear();
  }
}
