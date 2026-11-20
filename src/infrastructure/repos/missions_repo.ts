import type { AegisDb } from '../db.js';

export type PersistedMissionState = 'idle' | 'planning' | 'running' | 'paused' | 'waiting_user' | 'completed' | 'completed_unverified' | 'failed' | 'cancelled';

export interface MissionRow {
  id: string;
  prompt: string;
  model: string;
  state: PersistedMissionState;
  stepCount: number;
  tabId?: string;
  result?: string;
  error?: string;
  evidenceCount: number;
  createdAt: number;
  updatedAt: number;
  importedFrom?: string;
}

export interface MissionEventRow {
  missionId: string;
  seq: number;
  ts: number;
  kind: string;
  data: unknown;
}

export interface EventPage {
  events: MissionEventRow[];
  /** Pass as `afterSeq` to fetch the next page; null when exhausted. */
  nextAfterSeq: number | null;
}

function toMission(r: any): MissionRow {
  return {
    id: r.id,
    prompt: r.prompt,
    model: r.model,
    state: r.state,
    stepCount: r.step_count,
    tabId: r.tab_id ?? undefined,
    result: r.result ?? undefined,
    error: r.error ?? undefined,
    evidenceCount: r.evidence_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    importedFrom: r.imported_from ?? undefined
  };
}

/** Missions and their append-only event log (`mission_events`). */
export class MissionsRepo {
  constructor(private readonly db: AegisDb) {}

  upsertMission(m: Omit<MissionRow, 'createdAt' | 'updatedAt' | 'evidenceCount'> & { createdAt?: number; updatedAt?: number; evidenceCount?: number }): void {
    const now = Date.now();
    this.db.guard(() => {
      this.db.handle
        .prepare(`INSERT INTO missions (id, prompt, model, state, step_count, tab_id, result, error, evidence_count, created_at, updated_at, imported_from)
                  VALUES (@id, @prompt, @model, @state, @stepCount, @tabId, @result, @error, @evidenceCount, @createdAt, @updatedAt, @importedFrom)
                  ON CONFLICT(id) DO UPDATE SET
                    prompt = excluded.prompt, model = excluded.model, state = excluded.state, step_count = excluded.step_count,
                    tab_id = excluded.tab_id, result = excluded.result, error = excluded.error,
                    evidence_count = excluded.evidence_count, updated_at = excluded.updated_at`)
        .run({
          id: m.id,
          prompt: m.prompt,
          model: m.model,
          state: m.state,
          stepCount: m.stepCount,
          tabId: m.tabId ?? null,
          result: m.result ?? null,
          error: m.error ?? null,
          evidenceCount: m.evidenceCount ?? 0,
          createdAt: m.createdAt ?? now,
          updatedAt: m.updatedAt ?? now,
          importedFrom: m.importedFrom ?? null
        });
    });
  }

  getMission(id: string): MissionRow | undefined {
    return this.db.guard(() => {
      const r = this.db.handle.prepare('SELECT * FROM missions WHERE id = ?').get(id);
      return r ? toMission(r) : undefined;
    });
  }

  /** Newest first. Keyset pagination: pass the last row's (createdAt, id) as `before`. */
  listMissions(opts: { limit?: number; before?: { createdAt: number; id: string } } = {}): MissionRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    return this.db.guard(() => {
      const rows = opts.before
        ? this.db.handle
            .prepare('SELECT * FROM missions WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?')
            .all(opts.before.createdAt, opts.before.id, limit)
        : this.db.handle.prepare('SELECT * FROM missions ORDER BY created_at DESC, id DESC LIMIT ?').all(limit);
      return rows.map(toMission);
    });
  }

  countMissions(): number {
    return this.db.guard(() => (this.db.handle.prepare('SELECT COUNT(*) AS c FROM missions').get() as { c: number }).c);
  }

  deleteMission(id: string): boolean {
    return this.db.guard(() => this.db.handle.prepare('DELETE FROM missions WHERE id = ?').run(id).changes > 0);
  }

  /**
   * Appends an event. `seq` is allocated inside an IMMEDIATE transaction so it is strictly increasing per mission
   * even with several writers; `ts` is informational only and may go backwards if the system clock changes.
   */
  appendEvent(missionId: string, kind: string, data: unknown, ts: number = Date.now()): number {
    return this.db.tx(() => {
      const row = this.db.handle.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM mission_events WHERE mission_id = ?').get(missionId) as { next: number };
      this.db.handle
        .prepare('INSERT INTO mission_events (mission_id, seq, ts, kind, json) VALUES (?, ?, ?, ?, ?)')
        .run(missionId, row.next, ts, kind, JSON.stringify(data ?? null));
      return row.next;
    });
  }

  /** Keyset pagination over (mission_id, seq): cheap for very large logs. */
  listEvents(missionId: string, opts: { afterSeq?: number; limit?: number; kind?: string } = {}): EventPage {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 5000);
    const after = opts.afterSeq ?? 0;
    return this.db.guard(() => {
      const rows = (opts.kind
        ? this.db.handle.prepare('SELECT mission_id, seq, ts, kind, json FROM mission_events WHERE mission_id = ? AND kind = ? AND seq > ? ORDER BY seq LIMIT ?').all(missionId, opts.kind, after, limit + 1)
        : this.db.handle.prepare('SELECT mission_id, seq, ts, kind, json FROM mission_events WHERE mission_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(missionId, after, limit + 1)) as any[];
      const more = rows.length > limit;
      const page = more ? rows.slice(0, limit) : rows;
      const events = page.map(r => ({ missionId: r.mission_id, seq: r.seq, ts: r.ts, kind: r.kind, data: JSON.parse(r.json) }));
      return { events, nextAfterSeq: more ? events[events.length - 1].seq : null };
    });
  }

  countEvents(missionId: string): number {
    return this.db.guard(() => (this.db.handle.prepare('SELECT COUNT(*) AS c FROM mission_events WHERE mission_id = ?').get(missionId) as { c: number }).c);
  }

  /** Query-plan text for diagnostics/tests (proves pagination uses the primary key, not a scan). */
  explainListEvents(missionId: string): string {
    return this.db.guard(() =>
      (this.db.handle.prepare('EXPLAIN QUERY PLAN SELECT mission_id, seq, ts, kind, json FROM mission_events WHERE mission_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(missionId, 0, 10) as any[])
        .map(r => r.detail)
        .join('; ')
    );
  }

  /** Missions that were still running/planning/paused when the process stopped (crash or kill). */
  listInterrupted(): MissionRow[] {
    return this.db.guard(() =>
      this.db.handle.prepare("SELECT * FROM missions WHERE state IN ('planning','running','paused','waiting_user') ORDER BY created_at").all().map(toMission)
    );
  }
}
