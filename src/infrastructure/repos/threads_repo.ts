import * as crypto from 'node:crypto';
import type { AegisDb } from '../db.js';

export interface ThreadRow {
  id: string;
  title: string;
  parentId?: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MessageRow {
  threadId: string;
  seq: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  missionId?: string;
  ts: number;
  meta?: unknown;
}

const toThread = (r: any): ThreadRow => ({
  id: r.id,
  title: r.title,
  parentId: r.parent_id ?? undefined,
  archived: r.archived === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at
});

const toMessage = (r: any): MessageRow => ({
  threadId: r.thread_id,
  seq: r.seq,
  role: r.role,
  content: r.content,
  missionId: r.mission_id ?? undefined,
  ts: r.ts,
  meta: r.meta ? JSON.parse(r.meta) : undefined
});

/** Conversation threads and messages. UI/runtime wiring is tracked in #244. */
export class ThreadsRepo {
  constructor(private readonly db: AegisDb) {}

  create(title: string, opts: { id?: string; parentId?: string } = {}): ThreadRow {
    const now = Date.now();
    const id = opts.id ?? `t_${crypto.randomUUID()}`;
    this.db.guard(() => {
      this.db.handle.prepare('INSERT INTO threads (id, title, parent_id, archived, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)').run(id, title, opts.parentId ?? null, now, now);
    });
    return this.get(id)!;
  }

  get(id: string): ThreadRow | undefined {
    return this.db.guard(() => {
      const r = this.db.handle.prepare('SELECT * FROM threads WHERE id = ?').get(id);
      return r ? toThread(r) : undefined;
    });
  }

  list(opts: { includeArchived?: boolean; limit?: number } = {}): ThreadRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    return this.db.guard(() =>
      this.db.handle
        .prepare(`SELECT * FROM threads ${opts.includeArchived ? '' : 'WHERE archived = 0'} ORDER BY updated_at DESC, id DESC LIMIT ?`)
        .all(limit)
        .map(toThread)
    );
  }

  rename(id: string, title: string): void {
    this.db.guard(() => this.db.handle.prepare('UPDATE threads SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), id));
  }

  setArchived(id: string, archived: boolean): void {
    this.db.guard(() => this.db.handle.prepare('UPDATE threads SET archived = ?, updated_at = ? WHERE id = ?').run(archived ? 1 : 0, Date.now(), id));
  }

  appendMessage(threadId: string, msg: { role: MessageRow['role']; content: string; missionId?: string; meta?: unknown; ts?: number }): number {
    return this.db.tx(() => {
      const next = (this.db.handle.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM messages WHERE thread_id = ?').get(threadId) as { n: number }).n;
      const ts = msg.ts ?? Date.now();
      this.db.handle
        .prepare('INSERT INTO messages (thread_id, seq, role, content, mission_id, ts, meta) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(threadId, next, msg.role, msg.content, msg.missionId ?? null, ts, msg.meta === undefined ? null : JSON.stringify(msg.meta));
      this.db.handle.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(Date.now(), threadId);
      return next;
    });
  }

  listMessages(threadId: string, opts: { afterSeq?: number; limit?: number } = {}): MessageRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
    return this.db.guard(() =>
      this.db.handle.prepare('SELECT * FROM messages WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(threadId, opts.afterSeq ?? 0, limit).map(toMessage)
    );
  }

  /** Forks a thread: copies messages up to and including `uptoSeq` into a new thread. */
  fork(threadId: string, uptoSeq: number, title: string): ThreadRow {
    const forked = this.create(title, { parentId: threadId });
    this.db.tx(() => {
      this.db.handle
        .prepare('INSERT INTO messages (thread_id, seq, role, content, mission_id, ts, meta) SELECT ?, seq, role, content, mission_id, ts, meta FROM messages WHERE thread_id = ? AND seq <= ?')
        .run(forked.id, threadId, uptoSeq);
    });
    return forked;
  }

  delete(id: string): boolean {
    return this.db.guard(() => this.db.handle.prepare('DELETE FROM threads WHERE id = ?').run(id).changes > 0);
  }
}
