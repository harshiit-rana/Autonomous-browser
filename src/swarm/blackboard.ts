/**
 * Project Aegis - Shared Blackboard State & Distributed Evidence Store
 * 
 * Implements:
 * - Issue #32: SWARM-02 Shared Blackboard State & Distributed Evidence Store
 */

import { EventEmitter } from 'node:events';
import * as crypto from 'node:crypto';

export interface EvidenceItem {
  id: string;
  workerId: string;
  sourceUrl: string;
  category: 'fact' | 'table' | 'price' | 'contact' | 'document' | 'raw';
  key: string;
  value: any;
  confidence: number;
  timestamp: number;
  contentHash: string;
}

export interface ConflictRecord {
  key: string;
  itemA: EvidenceItem;
  itemB: EvidenceItem;
  detectedAt: number;
  resolved: boolean;
  resolvedValue?: any;
}

export class SharedBlackboard extends EventEmitter {
  private evidence: Map<string, EvidenceItem> = new Map(); // id -> item
  private keyIndex: Map<string, string[]> = new Map(); // key -> item ids
  private contentHashes: Set<string> = new Set();
  private conflicts: ConflictRecord[] = [];

  constructor() {
    super();
  }

  /**
   * Posts an evidence item to the shared blackboard.
   * Performs deduplication and detects semantic conflicts across workers.
   */
  public postEvidence(item: Omit<EvidenceItem, 'id' | 'timestamp' | 'contentHash'>): { posted: boolean; itemId?: string; conflict?: ConflictRecord } {
    const rawContent = JSON.stringify({ key: item.key, val: item.value });
    const contentHash = crypto.createHash('sha256').update(rawContent).digest('hex');

    // Deduplication check: if exact same content was already posted, ignore
    if (this.contentHashes.has(contentHash)) {
      return { posted: false };
    }

    const id = `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const fullItem: EvidenceItem = {
      ...item,
      id,
      timestamp: Date.now(),
      contentHash
    };

    this.evidence.set(id, fullItem);
    this.contentHashes.add(contentHash);

    // Update key index
    const existingIds = this.keyIndex.get(item.key) || [];
    let detectedConflict: ConflictRecord | undefined;

    // Check for conflicting values on identical keys
    if (existingIds.length > 0) {
      const prevItem = this.evidence.get(existingIds[existingIds.length - 1]);
      if (prevItem && JSON.stringify(prevItem.value) !== JSON.stringify(item.value)) {
        detectedConflict = {
          key: item.key,
          itemA: prevItem,
          itemB: fullItem,
          detectedAt: Date.now(),
          resolved: false
        };
        this.conflicts.push(detectedConflict);
        this.emit('conflict', detectedConflict);
      }
    }

    existingIds.push(id);
    this.keyIndex.set(item.key, existingIds);

    this.emit('evidence', fullItem);
    return { posted: true, itemId: id, conflict: detectedConflict };
  }

  /**
   * Retrieves all evidence items associated with a key.
   */
  public getByKey(key: string): EvidenceItem[] {
    const ids = this.keyIndex.get(key) || [];
    return ids.map(id => this.evidence.get(id)!).filter(Boolean);
  }

  /**
   * Retrieves all evidence items gathered by all workers.
   */
  public getAllEvidence(): EvidenceItem[] {
    return Array.from(this.evidence.values());
  }

  /**
   * Retrieves all evidence items gathered by a specific worker.
   */
  public getByWorker(workerId: string): EvidenceItem[] {
    return Array.from(this.evidence.values()).filter(e => e.workerId === workerId);
  }

  /**
   * Resolves a recorded conflict by designating an authoritative value.
   */
  public resolveConflict(key: string, resolvedValue: any): boolean {
    const conflict = this.conflicts.find(c => c.key === key && !c.resolved);
    if (!conflict) return false;

    conflict.resolved = true;
    conflict.resolvedValue = resolvedValue;

    // Post an authoritative synthesized evidence entry
    this.postEvidence({
      workerId: 'coordinator:arbitration',
      sourceUrl: 'arbitration://consensus',
      category: conflict.itemA.category,
      key,
      value: resolvedValue,
      confidence: 1.0
    });

    this.emit('conflictResolved', conflict);
    return true;
  }

  public getUnresolvedConflicts(): ConflictRecord[] {
    return this.conflicts.filter(c => !c.resolved);
  }

  public clear(): void {
    this.evidence.clear();
    this.keyIndex.clear();
    this.contentHashes.clear();
    this.conflicts = [];
  }
}
