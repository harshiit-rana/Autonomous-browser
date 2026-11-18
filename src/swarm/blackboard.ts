/**
 * Project Aegis - Shared Blackboard & Distributed Evidence Store
 * 
 * Implements Issue #150 [SWM-04]:
 * - Persistent SQLite / append-only store for typed claims and evidence
 * - Typed schema: claim, entity, attribute, typed value, source provenance, workerId
 * - Normalisation: currency, numbers, dates, units
 * - Semantic deduplication and clustering by (entity, attribute)
 * - Conflict adjudication: credibility weighting by source type, majority voting, verifier triggers
 * - Worker read APIs and real-time subscription events for UI
 */

import { EventEmitter } from 'node:events';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAppPaths } from '../infrastructure/paths.js';
import { logger } from '../infrastructure/logger.js';

export type SourceType = 'official' | 'primary' | 'aggregator' | 'ugc';

export interface EvidenceSource {
  url: string;
  domain: string;
  quote?: string;
  selector?: string;
  screenshotRef?: string;
  retrievedAt: number;
  sourceType: SourceType;
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
  resolutionMethod?: 'majority' | 'credibility' | 'verifier_adjudicated' | 'manual';
  verifierNeeded: boolean;
}

/**
 * Normalisation Engine for Evidence Values
 */
export class EvidenceNormalizer {
  public static normalize(value: any, attribute?: string): NormalizedValue {
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
    const currencyMatch = str.match(/^([$€£¥₹]|USD|EUR|GBP|JPY|INR)?\s*([\d,]+(?:\.\d+)?)\s*([$€£¥₹]|USD|EUR|GBP|JPY|INR)?$/i);
    if (currencyMatch && (currencyMatch[1] || currencyMatch[3] || (attribute && /price|cost|fee|charge/i.test(attribute)))) {
      const symbolOrCode = (currencyMatch[1] || currencyMatch[3] || '$').toUpperCase();
      let currency = 'USD';
      if (symbolOrCode === '$' || symbolOrCode === 'USD') currency = 'USD';
      else if (symbolOrCode === '€' || symbolOrCode === 'EUR') currency = 'EUR';
      else if (symbolOrCode === '£' || symbolOrCode === 'GBP') currency = 'GBP';
      else if (symbolOrCode === '¥' || symbolOrCode === 'JPY') currency = 'JPY';
      else if (symbolOrCode === '₹' || symbolOrCode === 'INR') currency = 'INR';

      const numericStr = currencyMatch[2].replace(/,/g, '');
      const amount = parseFloat(numericStr);
      if (!isNaN(amount)) {
        return {
          type: 'currency',
          raw: value,
          amount,
          currency,
          text: `${currency} ${amount.toFixed(2)}`
        };
      }
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
  private contentHashes: Set<string> = new Set();
  private conflicts: Map<string, ConflictRecord> = new Map(); // "entity::attribute" -> conflict
  private storagePath: string | null = null;
  private sqliteDb: any = null;

  constructor(options: { storageDir?: string; inMemory?: boolean } = {}) {
    super();
    if (!options.inMemory) {
      this.initPersistence(options.storageDir);
    }
  }

  private initPersistence(customDir?: string): void {
    try {
      const baseDir = customDir || getAppPaths().userData;
      this.storagePath = path.join(baseDir, 'evidence_blackboard.json');
      
      // Attempt node:sqlite if available
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const sqlite = require('node:sqlite');
        if (sqlite && sqlite.DatabaseSync) {
          const dbPath = path.join(baseDir, 'evidence_blackboard.sqlite');
          this.sqliteDb = new sqlite.DatabaseSync(dbPath);
          this.sqliteDb.exec(`
            CREATE TABLE IF NOT EXISTS evidence (
              id TEXT PRIMARY KEY,
              entity TEXT NOT NULL,
              attribute TEXT NOT NULL,
              category TEXT NOT NULL,
              value TEXT NOT NULL,
              normalized TEXT NOT NULL,
              source TEXT NOT NULL,
              worker_id TEXT NOT NULL,
              confidence REAL NOT NULL,
              content_hash TEXT NOT NULL,
              timestamp INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS conflicts (
              id TEXT PRIMARY KEY,
              entity TEXT NOT NULL,
              attribute TEXT NOT NULL,
              resolved INTEGER NOT NULL,
              resolved_value TEXT,
              resolution_method TEXT,
              detected_at INTEGER NOT NULL
            );
          `);
          logger.info('Blackboard SQLite persistence initialized', { dbPath });
          return;
        }
      } catch {
        // node:sqlite fallback to JSON file
      }

      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.evidence)) {
          for (const item of parsed.evidence) {
            this.evidence.set(item.id, item);
            this.contentHashes.add(item.contentHash);
            const clusterKey = `${item.entity.toLowerCase()}::${item.attribute.toLowerCase()}`;
            const ids = this.clusterIndex.get(clusterKey) || [];
            ids.push(item.id);
            this.clusterIndex.set(clusterKey, ids);
          }
        }
      }
    } catch (err: any) {
      logger.warn('Failed to load persistent blackboard state, continuing with in-memory', { error: err.message });
    }
  }

  private persistState(): void {
    if (this.sqliteDb) {
      // Already written in transaction/statement
      return;
    }
    if (!this.storagePath) return;

    try {
      const payload = {
        updatedAt: Date.now(),
        evidence: Array.from(this.evidence.values()),
        conflicts: Array.from(this.conflicts.values())
      };
      fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
      fs.writeFileSync(this.storagePath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err: any) {
      logger.warn('Failed to flush blackboard to disk', { error: err.message });
    }
  }

  /**
   * Post a structured claim / evidence item
   */
  public postEvidence(input: {
    entity: string;
    attribute: string;
    category: 'fact' | 'table' | 'price' | 'contact' | 'document' | 'spec' | 'availability' | 'raw';
    value: any;
    source: {
      url: string;
      quote?: string;
      selector?: string;
      screenshotRef?: string;
      sourceType?: SourceType;
    };
    workerId: string;
    stepId?: string;
    confidence?: number;
    supersedesId?: string;
  }): { posted: boolean; itemId?: string; conflict?: ConflictRecord } {
    const entity = input.entity.trim();
    const attribute = input.attribute.trim();
    const normalized = EvidenceNormalizer.normalize(input.value, attribute);

    // Domain extraction
    let domain = 'unknown';
    try {
      domain = new URL(input.source.url).hostname;
    } catch {}

    const source: EvidenceSource = {
      url: input.source.url,
      domain,
      quote: input.source.quote,
      selector: input.source.selector,
      screenshotRef: input.source.screenshotRef,
      retrievedAt: Date.now(),
      sourceType: input.source.sourceType || (domain.includes('official') ? 'official' : 'primary')
    };

    // Semantic content hash based on entity, attribute, and normalized equivalence
    const hashBasis = `${entity.toLowerCase()}::${attribute.toLowerCase()}::${normalized.type}::${normalized.text || normalized.number || normalized.amount || normalized.boolean}`;
    const contentHash = crypto.createHash('sha256').update(hashBasis).digest('hex');

    // Deduplication check: near identical semantic claim already recorded
    if (this.contentHashes.has(contentHash)) {
      return { posted: false };
    }

    const id = `ev_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const fullItem: EvidenceItem = {
      id,
      entity,
      attribute,
      category: input.category,
      value: input.value,
      normalized,
      source,
      workerId: input.workerId,
      stepId: input.stepId,
      confidence: Math.max(0.0, Math.min(1.0, input.confidence ?? 0.85)),
      supersedesId: input.supersedesId,
      contentHash,
      timestamp: Date.now()
    };

    this.evidence.set(id, fullItem);
    this.contentHashes.add(contentHash);

    // Save to SQLite if enabled
    if (this.sqliteDb) {
      try {
        const stmt = this.sqliteDb.prepare(`
          INSERT INTO evidence (id, entity, attribute, category, value, normalized, source, worker_id, confidence, content_hash, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          id,
          entity,
          attribute,
          input.category,
          JSON.stringify(input.value),
          JSON.stringify(normalized),
          JSON.stringify(source),
          input.workerId,
          fullItem.confidence,
          contentHash,
          fullItem.timestamp
        );
      } catch (err: any) {
        logger.warn('SQLite insert evidence error', { error: err.message });
      }
    }

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

        // Attempt automatic adjudication
        this.attemptAutoAdjudication(detectedConflict);
        this.conflicts.set(clusterKey, detectedConflict);
        this.emit('conflict', detectedConflict);
      }
    }

    clusterIds.push(id);
    this.clusterIndex.set(clusterKey, clusterIds);
    this.persistState();

    this.emit('evidence', fullItem);
    return { posted: true, itemId: id, conflict: detectedConflict };
  }

  /**
   * Automatic conflict adjudication:
   * 1. Official source priority
   * 2. Majority voting (if >= 3 sources and 1 option holds > 65% weight)
   * 3. Credibility scoring: sourceType weights (official=3, primary=2, aggregator=1.5, ugc=1.0) * confidence
   */
  private attemptAutoAdjudication(conflict: ConflictRecord): void {
    const items = conflict.items;
    if (items.length < 2) return;

    // Check for an official source first
    const officialItem = items.find(i => i.source.sourceType === 'official');
    if (officialItem) {
      conflict.resolved = true;
      conflict.resolvedValue = officialItem.value;
      conflict.resolutionMethod = 'credibility';
      conflict.verifierNeeded = false;
      return;
    }

    // Score candidates by weighted credibility
    const candidates: Map<string, { value: any; totalWeight: number; count: number }> = new Map();
    const sourceWeights: Record<SourceType, number> = {
      official: 3.0,
      primary: 2.0,
      aggregator: 1.5,
      ugc: 1.0
    };

    for (const item of items) {
      const key = item.normalized.text || String(item.normalized.number || item.normalized.amount || item.value);
      const weight = (sourceWeights[item.source.sourceType] || 1.0) * item.confidence;

      if (!candidates.has(key)) {
        candidates.set(key, { value: item.value, totalWeight: weight, count: 1 });
      } else {
        const c = candidates.get(key)!;
        c.totalWeight += weight;
        c.count += 1;
      }
    }

    let topCandidate: { value: any; totalWeight: number; count: number } | null = null;
    let totalAllWeights = 0;

    for (const c of candidates.values()) {
      totalAllWeights += c.totalWeight;
      if (!topCandidate || c.totalWeight > topCandidate.totalWeight) {
        topCandidate = c;
      }
    }

    // If top candidate holds >= 65% of total credibility weight and has >= 2 corroborating items, resolve
    if (topCandidate && (topCandidate.totalWeight / totalAllWeights) >= 0.65 && topCandidate.count >= 2) {
      conflict.resolved = true;
      conflict.resolvedValue = topCandidate.value;
      conflict.resolutionMethod = 'majority';
      conflict.verifierNeeded = false;
    } else {
      conflict.verifierNeeded = true;
    }
  }

  /**
   * Explicitly resolve conflict via verifier sub-agent or user input
   */
  public resolveConflict(entity: string, attribute: string, authoritativeValue: any, method: 'verifier_adjudicated' | 'manual' = 'verifier_adjudicated'): boolean {
    const clusterKey = `${entity.toLowerCase()}::${attribute.toLowerCase()}`;
    const conflict = this.conflicts.get(clusterKey);
    if (!conflict) return false;

    conflict.resolved = true;
    conflict.resolvedValue = authoritativeValue;
    conflict.resolutionMethod = method;
    conflict.verifierNeeded = false;

    // Post consensus claim
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
      workerId: `supervisor:${method}`,
      confidence: 1.0
    });

    this.persistState();
    this.emit('conflictResolved', conflict);
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
    if (this.storagePath && fs.existsSync(this.storagePath)) {
      try { fs.unlinkSync(this.storagePath); } catch {}
    }
  }
}
