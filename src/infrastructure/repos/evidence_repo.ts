import type { AegisDb } from '../db.js';

export interface EvidenceRow {
  id: string;
  entity: string;
  attribute: string;
  category: string;
  value: unknown;
  normalized: unknown;
  source: unknown;
  workerId: string;
  stepId?: string;
  confidence: number;
  supersedesId?: string;
  contentHash: string;
  timestamp: number;
}

function toRow(r: any): EvidenceRow {
  return {
    id: r.id,
    entity: r.entity,
    attribute: r.attribute,
    category: r.category,
    value: JSON.parse(r.value),
    normalized: JSON.parse(r.normalized),
    source: JSON.parse(r.source),
    workerId: r.worker_id,
    stepId: r.step_id ?? undefined,
    confidence: r.confidence,
    supersedesId: r.supersedes_id ?? undefined,
    contentHash: r.content_hash,
    timestamp: r.timestamp
  };
}

/** Typed claims posted to the shared blackboard. */
export class EvidenceRepo {
  constructor(private readonly db: AegisDb) {}

  insert(e: EvidenceRow, missionId?: string | null): void {
    this.db.guard(() => {
      this.db.handle
        .prepare(`INSERT OR REPLACE INTO evidence (id, mission_id, entity, attribute, category, value, normalized, source, worker_id, step_id, confidence, supersedes_id, content_hash, timestamp)
                  VALUES (@id, @missionId, @entity, @attribute, @category, @value, @normalized, @source, @workerId, @stepId, @confidence, @supersedesId, @contentHash, @timestamp)`)
        .run({
          id: e.id,
          missionId: missionId ?? null,
          entity: e.entity,
          attribute: e.attribute,
          category: e.category,
          value: JSON.stringify(e.value ?? null),
          normalized: JSON.stringify(e.normalized ?? null),
          source: JSON.stringify(e.source ?? null),
          workerId: e.workerId,
          stepId: e.stepId ?? null,
          confidence: e.confidence,
          supersedesId: e.supersedesId ?? null,
          contentHash: e.contentHash,
          timestamp: e.timestamp
        });
    });
  }

  listByMission(missionId: string): EvidenceRow[] {
    return this.db.guard(() => this.db.handle.prepare('SELECT * FROM evidence WHERE mission_id = ? ORDER BY timestamp, id').all(missionId).map(toRow));
  }

  listAll(limit = 10000): EvidenceRow[] {
    return this.db.guard(() => this.db.handle.prepare('SELECT * FROM evidence ORDER BY timestamp, id LIMIT ?').all(limit).map(toRow));
  }

  countByMission(missionId: string): number {
    return this.db.guard(() => (this.db.handle.prepare('SELECT COUNT(*) AS c FROM evidence WHERE mission_id = ?').get(missionId) as { c: number }).c);
  }
}
