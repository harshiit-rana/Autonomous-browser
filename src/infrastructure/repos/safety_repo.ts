import * as crypto from 'node:crypto';
import type { AegisDb } from '../db.js';

// ---- memories -----------------------------------------------------------------------------------------------

export interface MemoryRow {
  id: string;
  kind: string;
  content: string;
  source?: string;
  missionId?: string;
  createdAt: number;
}

export interface MemoryChunkRow {
  memoryId: string;
  chunkIndex: number;
  text: string;
  embedding?: number[];
}

const toMemory = (r: any): MemoryRow => ({
  id: r.id,
  kind: r.kind,
  content: r.content,
  source: r.source ?? undefined,
  missionId: r.mission_id ?? undefined,
  createdAt: r.created_at
});

/** Long-term memories and their chunks. Real embeddings/retrieval are #240. */
export class MemoriesRepo {
  constructor(private readonly db: AegisDb) {}

  add(m: { kind: string; content: string; source?: string; missionId?: string; chunks?: Array<{ text: string; embedding?: number[] }> }): string {
    const id = `mem_${crypto.randomUUID()}`;
    this.db.tx(() => {
      this.db.handle
        .prepare('INSERT INTO memories (id, kind, content, source, mission_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, m.kind, m.content, m.source ?? null, m.missionId ?? null, Date.now());
      (m.chunks ?? []).forEach((c, i) => {
        this.db.handle
          .prepare('INSERT INTO memory_chunks (memory_id, chunk_index, text, embedding) VALUES (?, ?, ?, ?)')
          .run(id, i, c.text, c.embedding ? JSON.stringify(c.embedding) : null);
      });
    });
    return id;
  }

  get(id: string): MemoryRow | undefined {
    return this.db.guard(() => {
      const r = this.db.handle.prepare('SELECT * FROM memories WHERE id = ?').get(id);
      return r ? toMemory(r) : undefined;
    });
  }

  list(limit = 100): MemoryRow[] {
    return this.db.guard(() => this.db.handle.prepare('SELECT * FROM memories ORDER BY created_at DESC, id DESC LIMIT ?').all(limit).map(toMemory));
  }

  chunks(memoryId: string): MemoryChunkRow[] {
    return this.db.guard(() =>
      (this.db.handle.prepare('SELECT * FROM memory_chunks WHERE memory_id = ? ORDER BY chunk_index').all(memoryId) as any[]).map(r => ({
        memoryId: r.memory_id,
        chunkIndex: r.chunk_index,
        text: r.text,
        embedding: r.embedding ? JSON.parse(r.embedding) : undefined
      }))
    );
  }

  delete(id: string): boolean {
    return this.db.guard(() => this.db.handle.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0);
  }
}

// ---- approvals ----------------------------------------------------------------------------------------------

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalRow {
  id: string;
  missionId?: string;
  action: unknown;
  status: ApprovalStatus;
  reason?: string;
  requestedAt: number;
  decidedAt?: number;
}

const toApproval = (r: any): ApprovalRow => ({
  id: r.id,
  missionId: r.mission_id ?? undefined,
  action: JSON.parse(r.action),
  status: r.status,
  reason: r.reason ?? undefined,
  requestedAt: r.requested_at,
  decidedAt: r.decided_at ?? undefined
});

/** Approval requests for gated actions (inbox + screenshots in #238). */
export class ApprovalsRepo {
  constructor(private readonly db: AegisDb) {}

  request(missionId: string | null, action: unknown): string {
    const id = `ap_${crypto.randomUUID()}`;
    this.db.guard(() =>
      this.db.handle.prepare('INSERT INTO approvals (id, mission_id, action, status, requested_at) VALUES (?, ?, ?, ?, ?)').run(id, missionId, JSON.stringify(action), 'pending', Date.now())
    );
    return id;
  }

  decide(id: string, status: Exclude<ApprovalStatus, 'pending'>, reason?: string): boolean {
    return this.db.guard(
      () => this.db.handle.prepare("UPDATE approvals SET status = ?, reason = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(status, reason ?? null, Date.now(), id).changes > 0
    );
  }

  listPending(): ApprovalRow[] {
    return this.db.guard(() => this.db.handle.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at").all().map(toApproval));
  }

  get(id: string): ApprovalRow | undefined {
    return this.db.guard(() => {
      const r = this.db.handle.prepare('SELECT * FROM approvals WHERE id = ?').get(id);
      return r ? toApproval(r) : undefined;
    });
  }
}

// ---- action ledger ------------------------------------------------------------------------------------------

export interface LedgerRow {
  missionId: string;
  seq: number;
  action: string;
  reversible: boolean;
  undone: boolean;
  ts: number;
  data: unknown;
}

/** Durable mirror of the agent action ledger (undo state survives restart). */
export class ActionLedgerRepo {
  constructor(private readonly db: AegisDb) {}

  append(missionId: string, action: string, data: unknown, reversible: boolean): number {
    return this.db.tx(() => {
      const next = (this.db.handle.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM action_ledger WHERE mission_id = ?').get(missionId) as { n: number }).n;
      this.db.handle
        .prepare('INSERT INTO action_ledger (mission_id, seq, action, reversible, undone, ts, json) VALUES (?, ?, ?, ?, 0, ?, ?)')
        .run(missionId, next, action, reversible ? 1 : 0, Date.now(), JSON.stringify(data ?? null));
      return next;
    });
  }

  markUndone(missionId: string, seq: number): boolean {
    return this.db.guard(() => this.db.handle.prepare('UPDATE action_ledger SET undone = 1 WHERE mission_id = ? AND seq = ?').run(missionId, seq).changes > 0);
  }

  list(missionId: string): LedgerRow[] {
    return this.db.guard(() =>
      (this.db.handle.prepare('SELECT * FROM action_ledger WHERE mission_id = ? ORDER BY seq').all(missionId) as any[]).map(r => ({
        missionId: r.mission_id,
        seq: r.seq,
        action: r.action,
        reversible: r.reversible === 1,
        undone: r.undone === 1,
        ts: r.ts,
        data: JSON.parse(r.json)
      }))
    );
  }
}
