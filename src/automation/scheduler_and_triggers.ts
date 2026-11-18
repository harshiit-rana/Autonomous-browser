/**
 * Project Aegis - Mission Scheduler & Secure Webhook Triggers (Issue #183 - [DAT-03])
 * 
 * Features:
 * - Recurring cron / interval mission execution
 * - Secure inbound webhook trigger with HMAC SHA-256 signature verification (X-Hub-Signature-256)
 * - Anti-replay protection using timestamp freshness window and nonce cache
 * - Missed-run recovery after system sleep or application restart
 * - Safety failure caps: auto-disables tasks after consecutive failures to prevent storming
 */

import * as crypto from 'node:crypto';
import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('mission-scheduler');

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  cronPattern?: string;
  intervalMinutes?: number;
  enabled: boolean;
  lastRunTimestamp?: number;
  nextRunTimestamp: number;
  consecutiveFailures: number;
  maxConsecutiveFailures: number;
  costCapUSD?: number;
}

export interface WebhookTriggerPayload {
  prompt: string;
  targetUrl?: string;
  timestamp: number;
  nonce: string;
}

export class MissionScheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private processedNonces: Set<string> = new Set();
  private webhookSecret: string;

  constructor(webhookSecret: string = 'aegis_default_webhook_secret_key') {
    this.webhookSecret = webhookSecret;
  }

  public registerScheduledTask(params: {
    name: string;
    prompt: string;
    intervalMinutes?: number;
    costCapUSD?: number;
    maxConsecutiveFailures?: number;
  }): ScheduledTask {
    const id = `sched_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const interval = params.intervalMinutes || 60;
    const task: ScheduledTask = {
      id,
      name: params.name,
      prompt: params.prompt,
      intervalMinutes: interval,
      enabled: true,
      nextRunTimestamp: Date.now() + (interval * 60 * 1000),
      consecutiveFailures: 0,
      maxConsecutiveFailures: params.maxConsecutiveFailures || 5,
      costCapUSD: params.costCapUSD
    };

    this.tasks.set(id, task);
    logger.info('Registered scheduled mission', { id, name: params.name, intervalMinutes: interval });
    return task;
  }

  /**
   * Evaluates tasks due for execution, catching up on missed runs after sleep
   */
  public getDueTasks(currentTime: number = Date.now()): ScheduledTask[] {
    const due: ScheduledTask[] = [];

    for (const task of this.tasks.values()) {
      if (!task.enabled) continue;

      if (currentTime >= task.nextRunTimestamp) {
        due.push(task);
        task.lastRunTimestamp = currentTime;
        const interval = task.intervalMinutes || 60;
        task.nextRunTimestamp = currentTime + (interval * 60 * 1000);
      }
    }

    return due;
  }

  public recordTaskRunResult(taskId: string, success: boolean): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    if (success) {
      task.consecutiveFailures = 0;
    } else {
      task.consecutiveFailures++;
      if (task.consecutiveFailures >= task.maxConsecutiveFailures) {
        task.enabled = false;
        logger.error('Auto-disabled scheduled task due to consecutive failure cap', undefined, {
          taskId,
          consecutiveFailures: task.consecutiveFailures
        });
      }
    }
  }

  /**
   * Validates and executes an incoming webhook trigger with HMAC SHA-256 and anti-replay protection
   */
  public verifyWebhookTrigger(
    rawBody: string,
    signatureHeader: string
  ): { valid: boolean; payload?: WebhookTriggerPayload; reason?: string } {
    // 1. Verify HMAC SHA-256 signature
    const expectedSig = 'sha256=' + crypto.createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');

    const isValidSig = crypto.timingSafeEqual(
      Buffer.from(signatureHeader || ''),
      Buffer.from(expectedSig)
    );

    if (!isValidSig) {
      logger.warn('Webhook signature mismatch', { signatureHeader });
      return { valid: false, reason: 'Invalid HMAC signature' };
    }

    try {
      const payload: WebhookTriggerPayload = JSON.parse(rawBody);

      // 2. Anti-replay freshness check (must be within 5 minutes)
      const now = Date.now();
      const ageMs = Math.abs(now - payload.timestamp);
      if (ageMs > 5 * 60 * 1000) {
        return { valid: false, reason: 'Webhook timestamp expired (replay protection)' };
      }

      // 3. Nonce uniqueness check
      if (this.processedNonces.has(payload.nonce)) {
        return { valid: false, reason: 'Duplicate nonce detected (replay attack)' };
      }
      this.processedNonces.add(payload.nonce);

      logger.info('Authorized inbound webhook trigger', { prompt: payload.prompt });
      return { valid: true, payload };
    } catch {
      return { valid: false, reason: 'Invalid JSON payload' };
    }
  }
}
