import * as crypto from 'node:crypto';
import type { AegisDb } from '../db.js';

export interface PromptRow {
  id: string;
  name: string;
  kind: string;
  createdAt: number;
  updatedAt: number;
}

export interface PromptVersionRow {
  promptId: string;
  version: number;
  body: string;
  variables: string[];
  createdAt: number;
}

const toPrompt = (r: any): PromptRow => ({ id: r.id, name: r.name, kind: r.kind, createdAt: r.created_at, updatedAt: r.updated_at });
const toVersion = (r: any): PromptVersionRow => ({
  promptId: r.prompt_id,
  version: r.version,
  body: r.body,
  variables: JSON.parse(r.variables),
  createdAt: r.created_at
});

/** Named prompts with immutable, numbered versions. UI is tracked in #241/#242/#245. */
export class PromptsRepo {
  constructor(private readonly db: AegisDb) {}

  create(name: string, kind = 'template'): PromptRow {
    const now = Date.now();
    const id = `p_${crypto.randomUUID()}`;
    this.db.guard(() => this.db.handle.prepare('INSERT INTO prompts (id, name, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, name, kind, now, now));
    return this.getByName(name)!;
  }

  getByName(name: string): PromptRow | undefined {
    return this.db.guard(() => {
      const r = this.db.handle.prepare('SELECT * FROM prompts WHERE name = ?').get(name);
      return r ? toPrompt(r) : undefined;
    });
  }

  list(): PromptRow[] {
    return this.db.guard(() => this.db.handle.prepare('SELECT * FROM prompts ORDER BY name').all().map(toPrompt));
  }

  addVersion(promptId: string, body: string, variables: string[] = []): number {
    return this.db.tx(() => {
      const v = (this.db.handle.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM prompt_versions WHERE prompt_id = ?').get(promptId) as { v: number }).v;
      const now = Date.now();
      this.db.handle.prepare('INSERT INTO prompt_versions (prompt_id, version, body, variables, created_at) VALUES (?, ?, ?, ?, ?)').run(promptId, v, body, JSON.stringify(variables), now);
      this.db.handle.prepare('UPDATE prompts SET updated_at = ? WHERE id = ?').run(now, promptId);
      return v;
    });
  }

  getVersion(promptId: string, version?: number): PromptVersionRow | undefined {
    return this.db.guard(() => {
      const r = version === undefined
        ? this.db.handle.prepare('SELECT * FROM prompt_versions WHERE prompt_id = ? ORDER BY version DESC LIMIT 1').get(promptId)
        : this.db.handle.prepare('SELECT * FROM prompt_versions WHERE prompt_id = ? AND version = ?').get(promptId, version);
      return r ? toVersion(r) : undefined;
    });
  }

  listVersions(promptId: string): PromptVersionRow[] {
    return this.db.guard(() => this.db.handle.prepare('SELECT * FROM prompt_versions WHERE prompt_id = ? ORDER BY version').all(promptId).map(toVersion));
  }
}
