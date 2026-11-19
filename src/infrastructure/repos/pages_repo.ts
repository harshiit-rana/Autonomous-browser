import type { AegisDb } from '../db.js';

export interface PageRow {
  id?: number;
  url: string;
  domain: string;
  title: string;
  snippet: string;
  fullText: string;
  visitedAt?: number;
  visitCount?: number;
  embedding?: number[];
  metadata?: Record<string, any>;
}

export interface DailySummaryRow {
  date: string;
  summary: string;
  topDomains: string[];
  pageCount: number;
  createdAt: number;
}

const COLS = 'id, url, domain, title, snippet, full_text, visited_at, visit_count, embedding, metadata';

function toPage(r: any): PageRow {
  return {
    id: r.id,
    url: r.url,
    domain: r.domain,
    title: r.title,
    snippet: r.snippet,
    fullText: r.full_text,
    visitedAt: r.visited_at,
    visitCount: r.visit_count,
    embedding: r.embedding ? JSON.parse(r.embedding) : undefined,
    metadata: r.metadata ? JSON.parse(r.metadata) : undefined
  };
}

/** Visited-page store with FTS5 (used by MemoryStore). Retrieval quality work is #240. */
export class PagesRepo {
  constructor(private readonly db: AegisDb) {}

  upsert(p: PageRow & { visitedAt: number; embedding: number[] }): void {
    this.db.tx(() => {
      const existing = this.db.handle.prepare('SELECT id FROM pages WHERE url = ?').get(p.url) as { id: number } | undefined;
      const embeddingJson = JSON.stringify(p.embedding);
      const metadataJson = JSON.stringify(p.metadata ?? {});
      if (existing) {
        this.db.handle
          .prepare('UPDATE pages SET domain = ?, title = ?, snippet = ?, full_text = ?, visited_at = ?, visit_count = visit_count + 1, embedding = ?, metadata = ? WHERE id = ?')
          .run(p.domain, p.title, p.snippet, p.fullText, p.visitedAt, embeddingJson, metadataJson, existing.id);
      } else {
        this.db.handle
          .prepare('INSERT INTO pages (url, domain, title, snippet, full_text, visited_at, visit_count, embedding, metadata) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)')
          .run(p.url, p.domain, p.title, p.snippet, p.fullText, p.visitedAt, embeddingJson, metadataJson);
      }
    });
  }

  /** BM25-ranked full text search; `ftsQuery` must already be a valid FTS5 expression. */
  searchFts(ftsQuery: string, limit: number): Array<{ page: PageRow; rank: number }> {
    return this.db.guard(() =>
      (this.db.handle
        .prepare(`SELECT p.id, p.url, p.domain, p.title, p.snippet, p.full_text, p.visited_at, p.visit_count, p.embedding, p.metadata, bm25(pages_fts) AS rank
                  FROM pages_fts f JOIN pages p ON p.id = f.rowid
                  WHERE pages_fts MATCH ? ORDER BY rank LIMIT ?`)
        .all(ftsQuery, limit) as any[]).map(r => ({ page: toPage(r), rank: Number(r.rank) }))
    );
  }

  allWithEmbeddings(): PageRow[] {
    return this.db.guard(() => this.db.handle.prepare(`SELECT ${COLS} FROM pages WHERE embedding IS NOT NULL`).all().map(toPage));
  }

  getByUrl(url: string): PageRow | null {
    return this.db.guard(() => {
      const r = this.db.handle.prepare(`SELECT ${COLS} FROM pages WHERE url = ?`).get(url);
      return r ? toPage(r) : null;
    });
  }

  recent(limit: number): PageRow[] {
    return this.db.guard(() => this.db.handle.prepare(`SELECT ${COLS} FROM pages ORDER BY visited_at DESC LIMIT ?`).all(limit).map(toPage));
  }

  visitedBetween(start: number, end: number): PageRow[] {
    return this.db.guard(() => this.db.handle.prepare(`SELECT ${COLS} FROM pages WHERE visited_at >= ? AND visited_at < ? ORDER BY visited_at ASC`).all(start, end).map(toPage));
  }

  deleteByUrl(url: string): boolean {
    return this.db.guard(() => this.db.handle.prepare('DELETE FROM pages WHERE url = ?').run(url).changes > 0);
  }

  clearAll(): void {
    this.db.tx(() => {
      this.db.handle.prepare('DELETE FROM pages').run();
      this.db.handle.prepare('DELETE FROM daily_summaries').run();
    });
  }

  getSummary(date: string): DailySummaryRow | undefined {
    return this.db.guard(() => {
      const r = this.db.handle.prepare('SELECT date, summary, top_domains, page_count, created_at FROM daily_summaries WHERE date = ?').get(date) as any;
      return r ? { date: r.date, summary: r.summary, topDomains: JSON.parse(r.top_domains), pageCount: r.page_count, createdAt: r.created_at } : undefined;
    });
  }

  putSummary(s: DailySummaryRow): void {
    this.db.guard(() =>
      this.db.handle
        .prepare('INSERT OR REPLACE INTO daily_summaries (date, summary, top_domains, page_count, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(s.date, s.summary, JSON.stringify(s.topDomains), s.pageCount, s.createdAt)
    );
  }
}
