import * as crypto from 'node:crypto';
import type { AegisDb } from '../db.js';

// ---- instructions -------------------------------------------------------------------------------------------

export interface InstructionRow {
  id: string;
  scope: 'global' | 'domain' | 'mission';
  scopeKey?: string;
  content: string;
  enabled: boolean;
  priority: number;
  updatedAt: number;
}

const toInstruction = (r: any): InstructionRow => ({
  id: r.id,
  scope: r.scope,
  scopeKey: r.scope_key ?? undefined,
  content: r.content,
  enabled: r.enabled === 1,
  priority: r.priority,
  updatedAt: r.updated_at
});

/** Layered custom instructions (compiled into prompts in #243). */
export class InstructionsRepo {
  constructor(private readonly db: AegisDb) {}

  upsert(i: Omit<InstructionRow, 'updatedAt' | 'id'> & { id?: string }): string {
    const id = i.id ?? `i_${crypto.randomUUID()}`;
    this.db.guard(() =>
      this.db.handle
        .prepare(`INSERT INTO instructions (id, scope, scope_key, content, enabled, priority, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, scope_key = excluded.scope_key, content = excluded.content,
                    enabled = excluded.enabled, priority = excluded.priority, updated_at = excluded.updated_at`)
        .run(id, i.scope, i.scopeKey ?? null, i.content, i.enabled ? 1 : 0, i.priority, Date.now())
    );
    return id;
  }

  list(scope?: InstructionRow['scope']): InstructionRow[] {
    return this.db.guard(() =>
      (scope
        ? this.db.handle.prepare('SELECT * FROM instructions WHERE scope = ? ORDER BY priority DESC, id').all(scope)
        : this.db.handle.prepare('SELECT * FROM instructions ORDER BY scope, priority DESC, id').all()
      ).map(toInstruction)
    );
  }

  delete(id: string): boolean {
    return this.db.guard(() => this.db.handle.prepare('DELETE FROM instructions WHERE id = ?').run(id).changes > 0);
  }
}

// ---- schedules ----------------------------------------------------------------------------------------------

export interface ScheduleRow {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  enabled: boolean;
  nextRunAt?: number;
  lastRunAt?: number;
  createdAt: number;
}

const toSchedule = (r: any): ScheduleRow => ({
  id: r.id,
  name: r.name,
  prompt: r.prompt,
  cron: r.cron,
  enabled: r.enabled === 1,
  nextRunAt: r.next_run_at ?? undefined,
  lastRunAt: r.last_run_at ?? undefined,
  createdAt: r.created_at
});

/** Standing tasks (run by the scheduler in #246). */
export class SchedulesRepo {
  constructor(private readonly db: AegisDb) {}

  create(s: { name: string; prompt: string; cron: string; nextRunAt?: number; enabled?: boolean }): string {
    const id = `s_${crypto.randomUUID()}`;
    this.db.guard(() =>
      this.db.handle
        .prepare('INSERT INTO schedules (id, name, prompt, cron, enabled, next_run_at, last_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
        .run(id, s.name, s.prompt, s.cron, s.enabled === false ? 0 : 1, s.nextRunAt ?? null, Date.now())
    );
    return id;
  }

  listDue(now: number = Date.now()): ScheduleRow[] {
    return this.db.guard(() =>
      this.db.handle.prepare('SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at').all(now).map(toSchedule)
    );
  }

  list(): ScheduleRow[] {
    return this.db.guard(() => this.db.handle.prepare('SELECT * FROM schedules ORDER BY created_at, id').all().map(toSchedule));
  }

  markRan(id: string, ranAt: number, nextRunAt: number | null): void {
    this.db.guard(() => this.db.handle.prepare('UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?').run(ranAt, nextRunAt, id));
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.guard(() => this.db.handle.prepare('UPDATE schedules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id));
  }

  delete(id: string): boolean {
    return this.db.guard(() => this.db.handle.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0);
  }
}

// ---- inbox --------------------------------------------------------------------------------------------------

export interface InboxItemRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  missionId?: string;
  createdAt: number;
  readAt?: number;
}

const toInbox = (r: any): InboxItemRow => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  body: r.body,
  missionId: r.mission_id ?? undefined,
  createdAt: r.created_at,
  readAt: r.read_at ?? undefined
});

/** Inbox for away digests and approval requests (#246). */
export class InboxRepo {
  constructor(private readonly db: AegisDb) {}

  add(i: { kind: string; title: string; body: string; missionId?: string }): string {
    const id = `n_${crypto.randomUUID()}`;
    this.db.guard(() =>
      this.db.handle
        .prepare('INSERT INTO inbox_items (id, kind, title, body, mission_id, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, NULL)')
        .run(id, i.kind, i.title, i.body, i.missionId ?? null, Date.now())
    );
    return id;
  }

  list(opts: { unreadOnly?: boolean; limit?: number } = {}): InboxItemRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    return this.db.guard(() =>
      this.db.handle
        .prepare(`SELECT * FROM inbox_items ${opts.unreadOnly ? 'WHERE read_at IS NULL' : ''} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(limit)
        .map(toInbox)
    );
  }

  markRead(id: string): void {
    this.db.guard(() => this.db.handle.prepare('UPDATE inbox_items SET read_at = ? WHERE id = ? AND read_at IS NULL').run(Date.now(), id));
  }

  unreadCount(): number {
    return this.db.guard(() => (this.db.handle.prepare('SELECT COUNT(*) AS c FROM inbox_items WHERE read_at IS NULL').get() as { c: number }).c);
  }
}
