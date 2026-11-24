/**
 * Project Aegis - Shared Blackboard & Distributed Evidence Store
 * 
 * Implements Issue #150 [SWM-04]:
 * - Persistent SQLite (shared better-sqlite3 layer) / append-only store for typed claims and evidence
 * - Typed schema: claim, entity, attribute, typed value, source provenance, workerId
 * - Normalisation: currency, numbers, dates, units
 * - Semantic deduplication and clustering by (entity, attribute)
 * - Conflict adjudication: credibility weighting by source type, majority voting, verifier triggers
 * - Worker read APIs and real-time subscription events for UI
 */

import { EventEmitter } from 'node:events';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { logger } from '../infrastructure/logger.js';
import { hasDb } from '../infrastructure/db.js';
import { getRepos } from '../infrastructure/repos/index.js';
import type { EvidenceRepo } from '../infrastructure/repos/evidence_repo.js';
import { getAppPaths } from '../infrastructure/paths.js';
import {
  parseMoney, matchQuote, computeConfidence, verifyEvidence, MemoryEvidenceStore, FileEvidenceStore,
  type ConfidenceBasis, type EvidenceArtifactStore, type VerificationResult
} from './evidence_truth.js';

export type SourceType = 'official' | 'primary' | 'aggregator' | 'ugc';

/** Another independent page whose verified quote states the same value (counted once per domain). */
export interface CorroboratingSource {
  url: string;
  domain: string;
  quote: string;
  pageTextHash: string;
  snapshotRef: string;
  retrievedAt: number;
  sourceType: SourceType;
}

export interface EvidenceSource {
  url: string;
  domain: string;
  quote?: string;
  selector?: string;
  screenshotRef?: string;
  retrievedAt: number;
  sourceType: SourceType;
  /** Title of the page the quote was read on (shown to the verifier when claims conflict). */
  pageTitle?: string;
  /** Hash of the normalised page text the quote was verified against; the text itself is in the snapshot store. */
  pageTextHash?: string;
  snapshotRef?: string;
  /** The page's own language and an English rendering of the quote; the original quote is what is verified. */
  language?: string;
  translation?: string;
  corroboratedBy?: CorroboratingSource[];
  /** The signals `confidence` was computed from. */
  confidenceBasis?: ConfidenceBasis;
}

export interface NormalizedValue {
  type: 'currency' | 'number' | 'unit' | 'date' | 'boolean' | 'string' | 'json';
  raw: any;
  amount?: number;
  currency?: string;
  number?: number;
  unit?: string;
  dateIso?: string;
  boolean?: boolean;
  text?: string;
}

export interface EvidenceItem {
  id: string;
  entity: string;
  attribute: string;
  category: 'fact' | 'table' | 'price' | 'contact' | 'document' | 'spec' | 'availability' | 'raw';
  value: any;
  normalized: NormalizedValue;
  source: EvidenceSource;
  workerId: string;
  stepId?: string;
  confidence: number;
  supersedesId?: string;
  contentHash: string;
  timestamp: number;
}

export interface ConflictRecord {
  id: string;
  entity: string;
  attribute: string;
  items: EvidenceItem[];
  detectedAt: number;
  resolved: boolean;
  resolvedValue?: any;
  resolutionMethod?: 'majority' | 'verifier_adjudicated' | 'both_valid' | 'manual';
  verifierNeeded: boolean;
  /** The verifier's verdict, once there is one: a winning claim, both claims valid, or a human has to decide. */
  verdict?: 'winner' | 'both_valid' | 'needs_human';
  verdictReason?: string;
}

/**
 * Normalisation Engine for Evidence Values
 */
export class EvidenceNormalizer {
  public static normalize(value: any, attribute?: string, locale?: string): NormalizedValue {
    if (value === null || value === undefined) {
      return { type: 'string', raw: value, text: '' };
    }

    if (typeof value === 'boolean') {
      return { type: 'boolean', raw: value, boolean: value };
    }

    if (typeof value === 'number') {
      return { type: 'number', raw: value, number: value };
    }

    const str = String(value).trim();

    // 1. Boolean strings
    if (/^(true|yes|in\s*stock|available|in-stock)$/i.test(str)) {
      return { type: 'boolean', raw: value, boolean: true, text: 'true' };
    }
    if (/^(false|no|out\s*of\s*stock|unavailable|out-of-stock|sold\s*out)$/i.test(str)) {
      return { type: 'boolean', raw: value, boolean: false, text: 'false' };
    }

    // 2. Currency check: e.g. "$19.99", "USD 19.99", "19.99 €", "£ 1,299.00"
    // (one money normaliser for the whole product: evidence_truth.parseMoney, with locale support)
    const money = parseMoney(str, { locale });
    if (money && (money.currency || (attribute && /price|cost|fee|charge/i.test(attribute)))) {
      const currency = money.currency ?? 'USD';
      return {
        type: 'currency',
        raw: value,
        amount: money.amount,
        currency,
        text: `${currency} ${money.amount.toFixed(2)}`
      };
    }

    // 3. Units check: e.g. "16 GB", "512GB", "30 hours", "2.4 GHz", "250 g", "1.5 kg"
    const unitMatch = str.match(/^([\d,]+(?:\.\d+)?)\s*(gb|tb|mb|kb|ghz|mhz|hours?|hrs?|mins?|seconds?|secs?|kg|g|lbs?|oz|px|%|mAh)$/i);
    if (unitMatch) {
      const num = parseFloat(unitMatch[1].replace(/,/g, ''));
      const unit = unitMatch[2].toLowerCase();
      if (!isNaN(num)) {
        return {
          type: 'unit',
          raw: value,
          number: num,
          unit,
          text: `${num} ${unit}`
        };
      }
    }

    // 4. Plain numeric check
    const plainNum = Number(str.replace(/,/g, ''));
    if (!isNaN(plainNum) && !str.includes('/') && !str.includes('-')) {
      return { type: 'number', raw: value, number: plainNum, text: String(plainNum) };
    }

    // 5. Date check: e.g. "2026-11-19" or RFC dates
    const parsedDate = Date.parse(str);
    if (!isNaN(parsedDate) && (str.includes('-') || str.includes('/') || str.includes(',')) && str.length >= 8) {
      return {
        type: 'date',
        raw: value,
        dateIso: new Date(parsedDate).toISOString(),
        text: new Date(parsedDate).toISOString()
      };
    }

    // 6. JSON Object or Array
    if (typeof value === 'object') {
      return { type: 'json', raw: value, text: JSON.stringify(value) };
    }

    return { type: 'string', raw: value, text: str.toLowerCase() };
  }

  public static areEquivalent(a: NormalizedValue, b: NormalizedValue): boolean {
    if (a.type !== b.type) {
      // Loose type coercion for number vs currency
      if (a.type === 'currency' && b.type === 'number') {
        return a.amount === b.number;
      }
      if (a.type === 'number' && b.type === 'currency') {
        return a.number === b.amount;
      }
      return false;
    }

    switch (a.type) {
      case 'currency':
        return a.currency === b.currency && Math.abs((a.amount ?? 0) - (b.amount ?? 0)) < 0.001;
      case 'number':
        return Math.abs((a.number ?? 0) - (b.number ?? 0)) < 0.0001;
      case 'unit':
        return a.unit === b.unit && Math.abs((a.number ?? 0) - (b.number ?? 0)) < 0.0001;
      case 'date':
        return a.dateIso === b.dateIso;
      case 'boolean':
        return a.boolean === b.boolean;
      case 'string':
        return (a.text || '').trim().toLowerCase() === (b.text || '').trim().toLowerCase();
      case 'json':
        return JSON.stringify(a.raw) === JSON.stringify(b.raw);
      default:
        return false;
    }
  }
}

/**
 * Shared Blackboard Evidence Store
 */
export class SharedBlackboard extends EventEmitter {
  private evidence: Map<string, EvidenceItem> = new Map(); // id -> item
  private clusterIndex: Map<string, string[]> = new Map(); // "entity::attribute" -> item ids
  private contentHashes: Map<string, string> = new Map(); // content hash -> item id
  private conflicts: Map<string, ConflictRecord> = new Map(); // "entity::attribute" -> conflict
  private repo: EvidenceRepo | null = null;
  private missionId: string | null = null;
  private store: EvidenceArtifactStore;

  /**
   * Evidence is persisted to the shared SQLite `evidence` table (tagged with `missionId`) when the app database
   * is open or an explicit `evidenceRepo` is supplied; otherwise the blackboard is purely in-memory.
   * Only evidence of the same `missionId` is reloaded, so one mission never dedupes against another's claims.
   * The page text each quote was verified against and the mission's visited-URL log live in `artifactStore` (files under
   * the mission directory in the app; in memory for `inMemory`).
   */
  constructor(options: { inMemory?: boolean; missionId?: string; evidenceRepo?: EvidenceRepo; artifactStore?: EvidenceArtifactStore } = {}) {
    super();
    this.missionId = options.missionId ?? null;
    this.store = options.artifactStore ?? new MemoryEvidenceStore();
    if (options.inMemory) return;
    if (!options.artifactStore && this.missionId) {
      try {
        this.store = new FileEvidenceStore(path.join(getAppPaths().userData, 'missions', this.missionId, 'evidence'));
      } catch (err: any) {
        logger.warn('Evidence snapshots cannot be stored on disk; keeping them in memory', { error: err.message });
      }
    }
    try {
      this.repo = options.evidenceRepo ?? (hasDb() ? getRepos().evidence : null);
      if (this.repo && this.missionId) {
        for (const row of this.repo.listByMission(this.missionId)) {
          const item = row as unknown as EvidenceItem;
          this.evidence.set(item.id, item);
          this.contentHashes.set(item.contentHash, item.id);
          const clusterKey = `${item.entity.toLowerCase()}::${item.attribute.toLowerCase()}`;
          const ids = this.clusterIndex.get(clusterKey) || [];
          ids.push(item.id);
          this.clusterIndex.set(clusterKey, ids);
        }
      }
    } catch (err: any) {
      logger.warn('Failed to load persistent blackboard state, continuing with in-memory', { error: err.message });
      this.repo = null;
    }
  }

  private static isVerdictRow(url: string): boolean {
    return url.startsWith('consensus://');
  }

  private static key(url: string): string {
    try { return new URL(url).hostname.toLowerCase(); } catch { return url; }
  }

  /** Records that a worker was on this page. The report refuses to cite a URL that is not in this log. */
  public recordVisit(url: string, workerId?: string): void {
    try { this.store.addVisit(url, workerId); } catch (err: any) { logger.warn('Failed to record a visited URL', { error: err.message }); }
  }

  public getVisitedUrls(): string[] {
    return this.store.listVisits().map(v => v.url);
  }

  /** Re-checks one finding against the page snapshot stored when it was made. Fetches nothing. */
  public verifyEvidence(item: EvidenceItem, opts: { now?: number; maxAgeMs?: number; currentPageText?: string } = {}): VerificationResult {
    return verifyEvidence(item, this.store, opts);
  }

  /**
   * Post a structured claim / evidence item.
   *
   * `pageText` is the text of the page the worker was looking at. With it, the quote is verified here (exact normalised
   * substring, otherwise the claim is rejected and nothing is recorded) and the text is stored as a snapshot. Without it the
   * claim is kept but `unverifiable`, and its confidence is 0. `input.confidence` is ignored: confidence is computed
   * from the source type, the verified quote and the independent agreeing and disagreeing domains (evidence_truth.ts).
   */
  public postEvidence(input: {
    entity?: string;
    attribute?: string;
    category?: 'fact' | 'table' | 'price' | 'contact' | 'document' | 'spec' | 'availability' | 'raw';
    value: any;
    source?: {
      url: string;
      quote?: string;
      selector?: string;
      screenshotRef?: string;
      sourceType?: SourceType;
      pageTitle?: string;
      language?: string;
      translation?: string;
    };
    pageText?: string;
    locale?: string;
    workerId: string;
    stepId?: string;
    /** Ignored; kept so older callers compile. */
    confidence?: number;
    supersedesId?: string;
    // Legacy compatibility fields
    key?: string;
    sourceUrl?: string;
    quote?: string;
    selector?: string;
  }): { posted: boolean; itemId?: string; conflict?: ConflictRecord; rejected?: string; corroborated?: boolean; duplicate?: boolean } {
    const anyInput = input as any;
    const entity = (input.entity || anyInput.key || 'unknown').trim();
    const attribute = (input.attribute || anyInput.category || 'value').trim();
    const normalized = EvidenceNormalizer.normalize(input.value, attribute, input.locale);

    const sourceUrl = input.source?.url || anyInput.sourceUrl || 'https://unknown';
    let domain = 'unknown';
    try {
      domain = new URL(sourceUrl).hostname;
    } catch {}

    const source: EvidenceSource = {
      url: sourceUrl,
      domain,
      quote: input.source?.quote || anyInput.quote,
      selector: input.source?.selector || anyInput.selector,
      screenshotRef: input.source?.screenshotRef || anyInput.screenshotRef,
      retrievedAt: Date.now(),
      sourceType: input.source?.sourceType || (domain.includes('official') ? 'official' : 'primary'),
      pageTitle: input.source?.pageTitle,
      language: input.source?.language,
      translation: input.source?.translation
    };
    const verdictRow = SharedBlackboard.isVerdictRow(sourceUrl);

    // Quote verification: a quote that is not on the page text the worker saw is rejected, nothing is recorded.
    if (input.pageText !== undefined && !verdictRow) {
      const m = source.quote ? matchQuote(source.quote, input.pageText) : { score: 0 as const, similarity: 0, reason: 'No quote was given.' };
      if (m.score !== 1) {
        return { posted: false, rejected: `${m.reason ?? 'The quote is not on the page.'} (closest page wording matches ${Math.round(m.similarity * 100)}% of its words; only an exact normalised substring is accepted)` };
      }
      const snap = this.store.putSnapshot(input.pageText);
      source.pageTextHash = snap.hash;
      source.snapshotRef = snap.ref;
      this.recordVisit(sourceUrl, input.workerId);
    }

    // Semantic content hash based on entity, attribute, and normalized equivalence
    const hashBasis = `${entity.toLowerCase()}::${attribute.toLowerCase()}::${normalized.type}::${normalized.text || normalized.number || normalized.amount || normalized.boolean}`;
    const contentHash = crypto.createHash('sha256').update(hashBasis).digest('hex');

    // Deduplication: the same claim already recorded. A second page from ANOTHER domain that states it too is
    // corroboration (counted once per domain); the same domain again is a duplicated source and adds nothing.
    const existingId = this.contentHashes.get(contentHash);
    if (existingId) {
      const existing = this.evidence.get(existingId);
      if (existing && !verdictRow && source.snapshotRef && source.pageTextHash) {
        const sameDomain = SharedBlackboard.key(existing.source.url) === domain
          || (existing.source.corroboratedBy ?? []).some(c => c.domain === domain);
        if (!sameDomain) {
          (existing.source.corroboratedBy ??= []).push({
            url: sourceUrl, domain, quote: source.quote!, pageTextHash: source.pageTextHash, snapshotRef: source.snapshotRef,
            retrievedAt: source.retrievedAt, sourceType: source.sourceType
          });
          this.recomputeCluster(`${entity.toLowerCase()}::${attribute.toLowerCase()}`);
          this.emit('corroborated', existing);
          return { posted: false, itemId: existing.id, corroborated: true };
        }
      }
      return { posted: false, itemId: existingId, duplicate: true };
    }

    const id = `ev_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const fullItem: EvidenceItem = {
      id,
      entity,
      attribute,
      category: input.category ?? 'raw',
      value: input.value,
      normalized,
      source,
      workerId: input.workerId,
      stepId: input.stepId,
      confidence: 0,
      supersedesId: input.supersedesId,
      contentHash,
      timestamp: Date.now()
    };

    this.evidence.set(id, fullItem);
    this.contentHashes.set(contentHash, id);

    // Cluster conflict detection
    const clusterKey = `${entity.toLowerCase()}::${attribute.toLowerCase()}`;
    const clusterIds = this.clusterIndex.get(clusterKey) || [];
    let detectedConflict: ConflictRecord | undefined;

    if (clusterIds.length > 0) {
      const existingItems = clusterIds.map(cid => this.evidence.get(cid)!).filter(Boolean);
      const conflictingItems = existingItems.filter(prev => !EvidenceNormalizer.areEquivalent(prev.normalized, normalized));

      if (conflictingItems.length > 0) {
        // A conflict exists between incoming evidence and recorded evidence
        const allInvolved = [...existingItems, fullItem];
        const conflictId = `conf_${clusterKey}`;

        detectedConflict = {
          id: conflictId,
          entity,
          attribute,
          items: allInvolved,
          detectedAt: Date.now(),
          resolved: false,
          verifierNeeded: true
        };
        this.conflicts.set(clusterKey, detectedConflict);
      }
    }

    clusterIds.push(id);
    this.clusterIndex.set(clusterKey, clusterIds);
    this.recomputeCluster(clusterKey); // confidence of every item of the cluster, and the row is persisted
    if (detectedConflict) {
      this.attemptAutoAdjudication(detectedConflict);
      this.emit('conflict', detectedConflict);
    }
    this.emit('evidence', fullItem);
    return { posted: true, itemId: id, conflict: detectedConflict };
  }

  /** Recomputes `confidence` (and its basis) of every item in an (entity, attribute) cluster, then persists the rows. */
  private recomputeCluster(clusterKey: string): void {
    const items = (this.clusterIndex.get(clusterKey) ?? []).map(id => this.evidence.get(id)!).filter(Boolean);
    const pages = items.filter(i => !SharedBlackboard.isVerdictRow(i.source.url));
    const domainsOf = (i: EvidenceItem): string[] => [
      ...(i.source.pageTextHash ? [SharedBlackboard.key(i.source.url)] : []),
      ...(i.source.corroboratedBy ?? []).map(c => c.domain)
    ];
    for (const item of items) {
      if (SharedBlackboard.isVerdictRow(item.source.url)) {
        // A verdict has no page of its own: it is as strong as the claim it settled on (0 when no claim carries that value).
        const basedOn = pages.filter(p => EvidenceNormalizer.areEquivalent(p.normalized, item.normalized)).sort((a, b) => b.confidence - a.confidence)[0];
        item.confidence = basedOn?.confidence ?? 0;
        item.source.confidenceBasis = basedOn?.source.confidenceBasis;
      } else {
        const mine = new Set(domainsOf(item));
        const dissenting = new Set<string>();
        for (const other of pages) {
          if (other === item || EvidenceNormalizer.areEquivalent(other.normalized, item.normalized)) continue;
          for (const d of domainsOf(other)) dissenting.add(d);
        }
        const { value, basis } = computeConfidence({
          sourceType: item.source.sourceType,
          quoteMatch: item.source.pageTextHash ? 1 : 0,
          independentSources: mine.size,
          disagreeingSources: [...dissenting].filter(d => !mine.has(d)).length
        });
        item.confidence = value;
        item.source.confidenceBasis = basis;
      }
      if (this.repo) {
        try { this.repo.insert(item as any, this.missionId); } catch (err: any) { logger.warn('Failed to persist evidence', { error: err.message }); }
      }
    }
  }

  /**
   * Automatic adjudication, deliberately narrow: a value wins on its own only when at least two independent domains state it
   * with verified quotes and it holds at least 65% of the verified domains. It is a head count of verified sources, never a
   * confidence comparison. Everything else goes to the verifier stage, which reads the quotes.
   */
  private attemptAutoAdjudication(conflict: ConflictRecord): void {
    const candidates = new Map<string, { value: any; domains: Set<string> }>();
    for (const item of conflict.items) {
      if (!item.source.pageTextHash) continue;
      const k = item.normalized.text || String(item.normalized.number ?? item.normalized.amount ?? item.value);
      const c = candidates.get(k) ?? { value: item.value, domains: new Set<string>() };
      c.domains.add(SharedBlackboard.key(item.source.url));
      for (const co of item.source.corroboratedBy ?? []) c.domains.add(co.domain);
      candidates.set(k, c);
    }
    const all = new Set<string>();
    for (const c of candidates.values()) for (const d of c.domains) all.add(d);
    const ranked = [...candidates.values()].sort((a, b) => b.domains.size - a.domains.size);
    const top = ranked[0];
    if (top && top.domains.size >= 2 && all.size > 0 && top.domains.size / all.size >= 0.65 && (!ranked[1] || ranked[1].domains.size < top.domains.size)) {
      conflict.resolved = true;
      conflict.resolvedValue = top.value;
      conflict.resolutionMethod = 'majority';
      conflict.verifierNeeded = false;
    } else {
      conflict.verifierNeeded = true;
    }
  }

  /**
   * Explicitly resolve conflict via verifier sub-agent or user input
   */
  public resolveConflict(
    entityOrKey: string,
    attributeOrValue: any,
    maybeAuthoritativeValue?: any,
    method: 'verifier_adjudicated' | 'manual' = 'verifier_adjudicated',
    reason?: string
  ): boolean {
    let entity = entityOrKey;
    let attribute = typeof attributeOrValue === 'string' ? attributeOrValue : 'price';
    let authoritativeValue = maybeAuthoritativeValue !== undefined ? maybeAuthoritativeValue : attributeOrValue;

    let clusterKey = `${entity.toLowerCase()}::${attribute.toLowerCase()}`;
    let conflict = this.conflicts.get(clusterKey);

    if (!conflict) {
      // Check if entity matches any conflict's entity or key
      const target = Array.from(this.conflicts.values()).find(
        c => c.entity.toLowerCase() === entityOrKey.toLowerCase() || c.id === entityOrKey
      );
      if (target) {
        conflict = target;
        entity = target.entity;
        attribute = target.attribute;
        clusterKey = `${entity.toLowerCase()}::${attribute.toLowerCase()}`;
      }
    }

    if (!conflict) return false;

    conflict.resolved = true;
    conflict.resolvedValue = authoritativeValue;
    conflict.resolutionMethod = method;
    conflict.verifierNeeded = false;
    conflict.verdict = 'winner';
    if (reason) conflict.verdictReason = reason;

    // Post the verdict row; its strength is that of the claim it settled on (recomputeCluster).
    this.postEvidence({
      entity,
      attribute,
      category: 'fact',
      value: authoritativeValue,
      source: {
        url: 'consensus://adjudicated',
        quote: `Authoritative resolution via ${method}`,
        sourceType: 'official'
      },
      workerId: `supervisor:${method}`
    });

    this.emit('conflictResolved', conflict);
    return true;
  }

  /** The verifier found that both claims are true (different variants, regions, dates...). Nothing is picked or dropped. */
  public markConflictBothValid(entity: string, attribute: string, reason: string): boolean {
    const conflict = this.conflicts.get(`${entity.toLowerCase()}::${attribute.toLowerCase()}`);
    if (!conflict) return false;
    conflict.resolved = true;
    conflict.resolutionMethod = 'both_valid';
    conflict.verifierNeeded = false;
    conflict.verdict = 'both_valid';
    conflict.verdictReason = reason;
    this.emit('conflictResolved', conflict);
    return true;
  }

  /** The verifier could not settle it: the conflict stays open and the report asks the user to decide. */
  public markConflictNeedsHuman(entity: string, attribute: string, reason: string): boolean {
    const conflict = this.conflicts.get(`${entity.toLowerCase()}::${attribute.toLowerCase()}`);
    if (!conflict) return false;
    conflict.verdict = 'needs_human';
    conflict.verdictReason = reason;
    conflict.verifierNeeded = false;
    return true;
  }

  /**
   * Query API for workers
   */
  public queryEvidence(filter: {
    entity?: string;
    attribute?: string;
    category?: string;
    minConfidence?: number;
  }): EvidenceItem[] {
    let items = Array.from(this.evidence.values());

    if (filter.entity) {
      const eTarget = filter.entity.toLowerCase();
      items = items.filter(i => i.entity.toLowerCase() === eTarget || i.entity.toLowerCase().includes(eTarget));
    }
    if (filter.attribute) {
      const aTarget = filter.attribute.toLowerCase();
      items = items.filter(i => i.attribute.toLowerCase() === aTarget);
    }
    if (filter.category) {
      items = items.filter(i => i.category === filter.category);
    }
    if (filter.minConfidence !== undefined) {
      items = items.filter(i => i.confidence >= filter.minConfidence!);
    }

    return items;
  }

  public getAllForEntity(entity: string): EvidenceItem[] {
    return this.queryEvidence({ entity });
  }

  public getAllEvidence(): EvidenceItem[] {
    return Array.from(this.evidence.values());
  }

  public getUnresolvedConflicts(): ConflictRecord[] {
    return Array.from(this.conflicts.values()).filter(c => !c.resolved);
  }

  public getConflicts(): ConflictRecord[] {
    return Array.from(this.conflicts.values());
  }

  public clear(): void {
    this.evidence.clear();
    this.clusterIndex.clear();
    this.contentHashes.clear();
    this.conflicts.clear();
  }
}
