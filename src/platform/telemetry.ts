/**
 * Project Aegis - Privacy-Preserving Telemetry & Failure Analytics (Issue #190 - [PLT-06])
 * 
 * Features:
 * - Strict Opt-In Gate (Default OFF in v1)
 * - Zero-leakage data collection policy:
 *   - Strictly ZERO URLs, page text, DOM elements, user prompts, credentials, or screenshots collected
 * - Only collects anonymized aggregate operational metrics:
 *   - App version, host OS platform
 *   - Mission outcome classification (success, failed, human_intervened)
 *   - Action taxonomy error codes (e.g. element_not_found, blocked_by_bot)
 *   - Token consumption and execution latency
 * - Local-first telemetry inspection view and instant one-click purge
 */

import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('telemetry');

export interface AnonymizedTelemetryEvent {
  id: string;
  timestamp: number;
  appVersion: string;
  osPlatform: string;
  outcome: 'success' | 'failed' | 'human_intervened';
  taxonomyErrorCode?: string;
  durationMs: number;
  totalTokens: number;
  estimatedCostUSD: number;
}

export class PrivacyTelemetryManager {
  private isOptedIn: boolean = false;
  private localEvents: AnonymizedTelemetryEvent[] = [];
  private appVersion: string;

  constructor(appVersion: string = '0.1.0', initialOptIn: boolean = false) {
    this.appVersion = appVersion;
    this.isOptedIn = initialOptIn; // Default strictly OFF
  }

  public setOptIn(optIn: boolean): void {
    this.isOptedIn = optIn;
    logger.info('Privacy telemetry opt-in state updated', { optedIn: optIn });
  }

  public isEnabled(): boolean {
    return this.isOptedIn;
  }

  /**
   * Records an anonymized mission event. If telemetry is disabled, drops immediately with zero disk write.
   */
  public recordMissionEvent(event: {
    outcome: AnonymizedTelemetryEvent['outcome'];
    durationMs: number;
    totalTokens: number;
    estimatedCostUSD: number;
    taxonomyErrorCode?: string;
  }): boolean {
    if (!this.isOptedIn) {
      return false; // Zero telemetry collected
    }

    const payload: AnonymizedTelemetryEvent = {
      id: `tel_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: Date.now(),
      appVersion: this.appVersion,
      osPlatform: process.platform,
      outcome: event.outcome,
      taxonomyErrorCode: event.taxonomyErrorCode,
      durationMs: event.durationMs,
      totalTokens: event.totalTokens,
      estimatedCostUSD: event.estimatedCostUSD
    };

    this.localEvents.push(payload);
    // Limit local event buffer to 1000 items
    if (this.localEvents.length > 1000) {
      this.localEvents.shift();
    }

    logger.info('Recorded anonymized telemetry event', { outcome: event.outcome, tokens: event.totalTokens });
    return true;
  }

  public getLocalEvents(): AnonymizedTelemetryEvent[] {
    return [...this.localEvents];
  }

  /**
   * One-click complete deletion of all local telemetry logs
   */
  public purgeLocalData(): void {
    this.localEvents = [];
    logger.info('Purged all local telemetry records');
  }

  /**
   * Computes local summary analytics (interventions per task, failure taxonomy counts)
   */
  public getLocalSummary(): {
    totalEvents: number;
    successRate: number;
    failureBreakdown: Record<string, number>;
  } {
    if (this.localEvents.length === 0) {
      return { totalEvents: 0, successRate: 100, failureBreakdown: {} };
    }

    const successes = this.localEvents.filter(e => e.outcome === 'success').length;
    const failureBreakdown: Record<string, number> = {};

    for (const e of this.localEvents) {
      if (e.taxonomyErrorCode) {
        failureBreakdown[e.taxonomyErrorCode] = (failureBreakdown[e.taxonomyErrorCode] || 0) + 1;
      }
    }

    return {
      totalEvents: this.localEvents.length,
      successRate: Math.round((successes / this.localEvents.length) * 100),
      failureBreakdown
    };
  }
}
