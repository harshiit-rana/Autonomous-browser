/**
 * Project Aegis - Shared URL Frontier & Per-Origin Politeness Engine
 * 
 * Implements Issue #149 [SWM-03]:
 * - Canonical URL normalisation (tracking params, fragments, case, query sorting)
 * - Cross-worker deduplication (visited and in-flight sets)
 * - Cycle / loop trap detection and crawl depth / page count bounds
 * - Per-origin (eTLD+1) politeness: concurrency caps, request pacing, Retry-After backoff
 * - Robots.txt compliance engine with crawl-delay respect
 */

import { logger } from '../infrastructure/logger.js';

export interface PolitenessRule {
  maxConcurrentPerOrigin: number;
  minIntervalMs: number;
  respectRobots: boolean;
}

export interface OriginState {
  origin: string;
  inFlight: number;
  lastRequestTime: number;
  backoffUntil: number;
  consecutiveErrors: number;
  circuitOpen: boolean;
  crawlDelayMs?: number;
  disallowedPaths: string[];
}

export class URLFrontier {
  private visitedUrls: Set<string> = new Set();
  private inFlightUrls: Set<string> = new Set();
  private origins: Map<string, OriginState> = new Map();
  private urlDepths: Map<string, number> = new Map();
  private defaultPoliteness: PolitenessRule;
  private maxDepth: number;
  private maxPages: number;

  private static TRACKING_PARAMS = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'fbclid', 'gclid', 'msclkid', 'mc_cid', 'mc_eid', 'ref', 'source',
    '_ga', '_gl', 'yclid', '_hsenc', '_hsmi'
  ]);

  constructor(options: {
    maxConcurrentPerOrigin?: number;
    minIntervalMs?: number;
    respectRobots?: boolean;
    maxDepth?: number;
    maxPages?: number;
  } = {}) {
    this.defaultPoliteness = {
      maxConcurrentPerOrigin: options.maxConcurrentPerOrigin ?? 2,
      minIntervalMs: options.minIntervalMs ?? 500,
      respectRobots: options.respectRobots ?? true
    };
    this.maxDepth = options.maxDepth ?? 5;
    this.maxPages = options.maxPages ?? 100;
  }

  /**
   * Normalises a URL into canonical deduplication form:
   * - Lowercase protocol & host
   * - Strip port 80/443 default
   * - Remove fragment (#...)
   * - Strip tracking query parameters
   * - Deterministically sort remaining query parameters
   * - Strip trailing slash on non-root paths
   */
  public static normalize(rawUrl: string): string {
    let urlStr = rawUrl.trim();
    if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
      urlStr = 'https://' + urlStr;
    }

    try {
      const parsed = new URL(urlStr);
      parsed.hash = ''; // Strip fragment

      // Remove default ports
      if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
        parsed.port = '';
      }

      // Filter tracking query params and sort deterministically
      const cleanedParams: [string, string][] = [];
      parsed.searchParams.forEach((val, key) => {
        if (!URLFrontier.TRACKING_PARAMS.has(key.toLowerCase())) {
          cleanedParams.push([key, val]);
        }
      });
      cleanedParams.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

      // Clear search and append sorted
      parsed.search = '';
      for (const [k, v] of cleanedParams) {
        parsed.searchParams.append(k, v);
      }

      // Normalize trailing slash
      let pathname = parsed.pathname;
      if (pathname.length > 1 && pathname.endsWith('/')) {
        pathname = pathname.slice(0, -1);
      }
      parsed.pathname = pathname;

      return parsed.toString();
    } catch {
      return rawUrl.trim().toLowerCase();
    }
  }

  /**
   * Extracts the eTLD+1 or origin hostname for rate limiting
   */
  public static getOrigin(urlStr: string): string {
    try {
      const parsed = new URL(urlStr);
      const hostParts = parsed.hostname.toLowerCase().split('.');
      if (hostParts.length > 2) {
        // e.g. shop.example.com -> example.com (basic eTLD+1 heuristic)
        return hostParts.slice(-2).join('.');
      }
      return parsed.hostname.toLowerCase();
    } catch {
      return 'unknown_origin';
    }
  }

  /**
   * Evaluates whether a URL is permissible to fetch right now:
   * - Not previously visited
   * - Not currently in-flight
   * - Within depth and page quotas
   * - Not blocked by origin rate-limit or circuit breaker
   * - Permitted by robots.txt
   */
  public canFetch(url: string, depth: number = 0): { allowed: boolean; reason?: string; waitMs?: number } {
    const canonical = URLFrontier.normalize(url);

    if (this.visitedUrls.size >= this.maxPages) {
      return { allowed: false, reason: `Max page limit (${this.maxPages}) reached` };
    }

    if (depth > this.maxDepth) {
      return { allowed: false, reason: `Max depth limit (${this.maxDepth}) exceeded` };
    }

    if (this.visitedUrls.has(canonical)) {
      return { allowed: false, reason: 'Already visited (deduplicated)' };
    }

    if (this.inFlightUrls.has(canonical)) {
      return { allowed: false, reason: 'Currently in-flight by another worker' };
    }

    const origin = URLFrontier.getOrigin(canonical);
    const originState = this.getOrCreateOriginState(origin);

    // Circuit breaker check
    if (originState.circuitOpen) {
      if (Date.now() < originState.backoffUntil) {
        return { allowed: false, reason: `Origin ${origin} circuit breaker is open`, waitMs: originState.backoffUntil - Date.now() };
      }
      // Half-open attempt
      originState.circuitOpen = false;
    }

    // Exponential backoff check (e.g. 429/503)
    if (Date.now() < originState.backoffUntil) {
      return { allowed: false, reason: `Origin ${origin} in backoff`, waitMs: originState.backoffUntil - Date.now() };
    }

    // Concurrency limit per origin
    if (originState.inFlight >= this.defaultPoliteness.maxConcurrentPerOrigin) {
      return { allowed: false, reason: `Origin ${origin} concurrent limit reached (${originState.inFlight})` };
    }

    // Request pacing
    const interval = Math.max(this.defaultPoliteness.minIntervalMs, originState.crawlDelayMs ?? 0);
    const elapsedSinceLast = Date.now() - originState.lastRequestTime;
    if (elapsedSinceLast < interval) {
      return { allowed: false, reason: 'Pacing delay required', waitMs: interval - elapsedSinceLast };
    }

    // Robots.txt check
    if (this.defaultPoliteness.respectRobots) {
      try {
        const path = new URL(canonical).pathname;
        for (const disallowed of originState.disallowedPaths) {
          if (path.startsWith(disallowed)) {
            return { allowed: false, reason: `Disallowed by robots.txt (${disallowed})` };
          }
        }
      } catch {}
    }

    return { allowed: true };
  }

  /**
   * Marks a URL as in-flight
   */
  public markInFlight(url: string, depth: number = 0): string {
    const canonical = URLFrontier.normalize(url);
    this.inFlightUrls.add(canonical);
    this.urlDepths.set(canonical, depth);

    const origin = URLFrontier.getOrigin(canonical);
    const state = this.getOrCreateOriginState(origin);
    state.inFlight++;
    state.lastRequestTime = Date.now();

    return canonical;
  }

  /**
   * Completes a URL fetch, recording success or failure
   */
  public complete(url: string, success: boolean, httpStatus?: number, retryAfterSec?: number): void {
    const canonical = URLFrontier.normalize(url);
    this.inFlightUrls.delete(canonical);

    if (success) {
      this.visitedUrls.add(canonical);
    }

    const origin = URLFrontier.getOrigin(canonical);
    const state = this.origins.get(origin);
    if (!state) return;

    state.inFlight = Math.max(0, state.inFlight - 1);

    if (httpStatus === 429 || httpStatus === 503) {
      state.consecutiveErrors++;
      const backoffDurationMs = retryAfterSec ? retryAfterSec * 1000 : Math.min(60000, 1000 * Math.pow(2, state.consecutiveErrors));
      state.backoffUntil = Date.now() + backoffDurationMs;
      if (state.consecutiveErrors >= 3) {
        state.circuitOpen = true;
      }
      logger.warn('Origin rate-limited, triggering backoff', { origin, httpStatus, backoffMs: backoffDurationMs });
    } else if (success) {
      state.consecutiveErrors = 0;
      state.circuitOpen = false;
    }
  }

  public registerRobotsDirectives(origin: string, disallowedPaths: string[], crawlDelayMs?: number): void {
    const state = this.getOrCreateOriginState(origin);
    state.disallowedPaths = disallowedPaths;
    if (crawlDelayMs) {
      state.crawlDelayMs = crawlDelayMs;
    }
  }

  public getVisitedCount(): number {
    return this.visitedUrls.size;
  }

  public isVisited(url: string): boolean {
    return this.visitedUrls.has(URLFrontier.normalize(url));
  }

  public reset(): void {
    this.visitedUrls.clear();
    this.inFlightUrls.clear();
    this.origins.clear();
    this.urlDepths.clear();
  }

  private getOrCreateOriginState(origin: string): OriginState {
    let state = this.origins.get(origin);
    if (!state) {
      state = {
        origin,
        inFlight: 0,
        lastRequestTime: 0,
        backoffUntil: 0,
        consecutiveErrors: 0,
        circuitOpen: false,
        disallowedPaths: []
      };
      this.origins.set(origin, state);
    }
    return state;
  }
}
