/**
 * Project Aegis - Memory Store & Semantic Vector Search Engine
 * 
 * Implements:
 * - Issue #12: M6.2 Local Privacy-First Semantic Vector Memory & Browsing Recall
 * - Issue #46: MEM-01 SQLite FTS5 Full-Text Search Engine for Visited Page Content
 * - Issue #47: MEM-02 On-Device Local Embedding Generation Pipeline
 * - Issue #48: MEM-03 Vector Similarity Search & Hybrid RAG Retrieval Engine
 * - Issue #49: MEM-04 Automated Daily Browsing Activity Summarizer (OptMem Parity)
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

let DatabaseSyncClass: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqlite = (typeof require === 'function' ? require : undefined)?.('node:sqlite');
  DatabaseSyncClass = sqlite?.DatabaseSync;
} catch {
  // node:sqlite requires Node >= 22.5.0 (Electron 33 bundles Node 20.x - see Issue #110)
}

export interface PageRecord {
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

export interface PageSearchResult {
  page: PageRecord;
  score: number;
  matchType: 'fts' | 'vector' | 'hybrid';
}

export interface DailySummary {
  date: string; // YYYY-MM-DD
  summary: string;
  topDomains: string[];
  pageCount: number;
  createdAt: number;
}

/**
 * Calculates cosine similarity between two numeric vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Lightweight deterministic on-device feature embedding pipeline.
 * Computes a normalized 64-dimensional semantic frequency & n-gram feature vector
 * without requiring multi-gigabyte PyTorch/ONNX runtimes, with zero network leakage.
 */
export function generateLocalEmbedding(text: string, dimensions = 64): number[] {
  const vector = new Array(dimensions).fill(0);
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const words = normalized.split(/\s+/).filter(w => w.length > 2);

  if (words.length === 0) return vector;

  // Hash-based word & character bi-gram projection
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    let hash = 0;
    for (let c = 0; c < word.length; c++) {
      hash = ((hash << 5) - hash + word.charCodeAt(c)) | 0;
    }
    const idx = Math.abs(hash) % dimensions;
    vector[idx] += 1.0;

    // Word bigram
    if (i < words.length - 1) {
      const bigram = `${word}_${words[i + 1]}`;
      let bHash = 0;
      for (let c = 0; c < bigram.length; c++) {
        bHash = ((bHash << 5) - bHash + bigram.charCodeAt(c)) | 0;
      }
      const bIdx = Math.abs(bHash) % dimensions;
      vector[bIdx] += 1.5;
    }
  }

  // L2 Normalization
  let norm = 0;
  for (let i = 0; i < dimensions; i++) {
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dimensions; i++) {
      vector[i] /= norm;
    }
  }

  return vector;
}

export class MemoryStore {
  private db: any;
  private isClosed = false;

  constructor(dbPath: string = ':memory:') {
    if (!DatabaseSyncClass) {
      throw new Error(
        'node:sqlite DatabaseSync is not supported in the active Node runtime (requires Node >= 22.5.0). See Issue #110.'
      );
    }
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSyncClass(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    // Core pages table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT UNIQUE NOT NULL,
        domain TEXT NOT NULL,
        title TEXT NOT NULL,
        snippet TEXT NOT NULL,
        full_text TEXT NOT NULL,
        visited_at INTEGER NOT NULL,
        visit_count INTEGER NOT NULL DEFAULT 1,
        embedding TEXT,
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_pages_domain ON pages(domain);
      CREATE INDEX IF NOT EXISTS idx_pages_visited ON pages(visited_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
        url,
        title,
        snippet,
        full_text,
        content='pages',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
        INSERT INTO pages_fts(rowid, url, title, snippet, full_text)
        VALUES (new.id, new.url, new.title, new.snippet, new.full_text);
      END;

      CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
        INSERT INTO pages_fts(pages_fts, rowid, url, title, snippet, full_text)
        VALUES('delete', old.id, old.url, old.title, old.snippet, old.full_text);
      END;

      CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
        INSERT INTO pages_fts(pages_fts, rowid, url, title, snippet, full_text)
        VALUES('delete', old.id, old.url, old.title, old.snippet, old.full_text);
        INSERT INTO pages_fts(rowid, url, title, snippet, full_text)
        VALUES (new.id, new.url, new.title, new.snippet, new.full_text);
      END;

      CREATE TABLE IF NOT EXISTS daily_summaries (
        date TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        top_domains TEXT NOT NULL,
        page_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  /**
   * Records a visited page with automatic embedding calculation and FTS indexing.
   */
  public recordPage(record: PageRecord): void {
    this.ensureOpen();
    const visitedAt = record.visitedAt ?? Date.now();
    const embedding = record.embedding ?? generateLocalEmbedding(`${record.title} ${record.snippet} ${record.fullText.slice(0, 2000)}`);
    const embeddingJson = JSON.stringify(embedding);
    const metadataJson = JSON.stringify(record.metadata ?? {});

    const existingStmt = this.db.prepare('SELECT id, visit_count FROM pages WHERE url = ?');
    const existing = existingStmt.get(record.url) as { id: number; visit_count: number } | undefined;

    if (existing) {
      const updateStmt = this.db.prepare(`
        UPDATE pages SET
          domain = ?,
          title = ?,
          snippet = ?,
          full_text = ?,
          visited_at = ?,
          visit_count = visit_count + 1,
          embedding = ?,
          metadata = ?
        WHERE id = ?
      `);
      updateStmt.run(
        record.domain,
        record.title,
        record.snippet,
        record.fullText,
        visitedAt,
        embeddingJson,
        metadataJson,
        existing.id
      );
    } else {
      const insertStmt = this.db.prepare(`
        INSERT INTO pages (url, domain, title, snippet, full_text, visited_at, visit_count, embedding, metadata)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      `);
      insertStmt.run(
        record.url,
        record.domain,
        record.title,
        record.snippet,
        record.fullText,
        visitedAt,
        embeddingJson,
        metadataJson
      );
    }
  }

  /**
   * Full-Text Search using SQLite FTS5 BM25 ranking.
   */
  public searchFTS(query: string, limit = 10): PageSearchResult[] {
    this.ensureOpen();
    const sanitized = query.replace(/[^\w\s]/g, ' ').trim();
    if (!sanitized) return [];

    const tokens = sanitized.split(/\s+/).filter(t => t.length > 0);
    if (tokens.length === 0) return [];
    // Disjunctive prefix match: rank by number and frequency of matched terms
    const ftsQuery = tokens.map(t => `"${t}"*`).join(' OR ');

    // FTS5 MATCH with bm25 ranking
    const stmt = this.db.prepare(`
      SELECT p.id, p.url, p.domain, p.title, p.snippet, p.full_text, p.visited_at, p.visit_count, p.embedding, p.metadata,
             bm25(pages_fts) as rank
      FROM pages_fts f
      JOIN pages p ON p.id = f.rowid
      WHERE pages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    // In FTS5, bm25 returns negative score where lower (more negative) is better.
    // We normalize to positive score: score = 1 / (1 + abs(rank))
    const rows = stmt.all(ftsQuery, limit) as any[];
    return rows.map(r => ({
      page: this.rowToPageRecord(r),
      score: 1 / (1 + Math.abs(Number(r.rank))),
      matchType: 'fts'
    }));
  }

  /**
   * Vector semantic similarity search across stored embeddings.
   */
  public searchVector(queryEmbedding: number[], topK = 10): PageSearchResult[] {
    this.ensureOpen();
    const stmt = this.db.prepare('SELECT id, url, domain, title, snippet, full_text, visited_at, visit_count, embedding, metadata FROM pages WHERE embedding IS NOT NULL');
    const rows = stmt.all() as any[];

    const scored: PageSearchResult[] = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      try {
        const emb = JSON.parse(row.embedding) as number[];
        const score = cosineSimilarity(queryEmbedding, emb);
        scored.push({
          page: this.rowToPageRecord(row),
          score,
          matchType: 'vector'
        });
      } catch {
        continue;
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * Hybrid RAG Retrieval: Merges BM25 full-text search with vector cosine similarity
   * using Reciprocal Rank Fusion (RRF).
   */
  public searchHybrid(query: string, topK = 10, alpha = 0.5): PageSearchResult[] {
    this.ensureOpen();
    const queryEmbedding = generateLocalEmbedding(query);
    const ftsResults = this.searchFTS(query, topK * 2);
    const vectorResults = this.searchVector(queryEmbedding, topK * 2);

    // Map by URL to aggregate reciprocal rank
    const scoreMap = new Map<string, { page: PageRecord; rrfScore: number; ftsScore: number; vecScore: number }>();
    const k = 60; // Standard RRF smoothing constant

    ftsResults.forEach((res, rank) => {
      const url = res.page.url;
      const rrf = 1 / (k + rank + 1);
      scoreMap.set(url, {
        page: res.page,
        rrfScore: rrf * (1 - alpha),
        ftsScore: res.score,
        vecScore: 0
      });
    });

    vectorResults.forEach((res, rank) => {
      const url = res.page.url;
      const rrf = 1 / (k + rank + 1);
      const existing = scoreMap.get(url);
      if (existing) {
        existing.rrfScore += rrf * alpha;
        existing.vecScore = res.score;
      } else {
        scoreMap.set(url, {
          page: res.page,
          rrfScore: rrf * alpha,
          ftsScore: 0,
          vecScore: res.score
        });
      }
    });

    const combined = Array.from(scoreMap.values())
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, topK);

    return combined.map(item => ({
      page: item.page,
      score: item.rrfScore,
      matchType: 'hybrid'
    }));
  }

  /**
   * Generates or fetches daily browsing activity summary (OptMem parity).
   */
  public async generateDailySummary(
    dateStr: string,
    summarizerFn?: (pages: PageRecord[]) => Promise<string>
  ): Promise<DailySummary> {
    this.ensureOpen();
    const existingStmt = this.db.prepare('SELECT date, summary, top_domains, page_count, created_at FROM daily_summaries WHERE date = ?');
    const existing = existingStmt.get(dateStr) as any;
    if (existing) {
      return {
        date: existing.date,
        summary: existing.summary,
        topDomains: JSON.parse(existing.top_domains),
        pageCount: existing.page_count,
        createdAt: existing.created_at
      };
    }

    // Get pages visited on this calendar day
    const dayStart = new Date(`${dateStr}T00:00:00Z`).getTime();
    const dayEnd = dayStart + 86400000;

    const pagesStmt = this.db.prepare(`
      SELECT id, url, domain, title, snippet, full_text, visited_at, visit_count, metadata
      FROM pages
      WHERE visited_at >= ? AND visited_at < ?
      ORDER BY visited_at ASC
    `);
    const rows = pagesStmt.all(dayStart, dayEnd) as any[];
    const pages = rows.map(r => this.rowToPageRecord(r));

    // Top domains calculation
    const domainCounts = new Map<string, number>();
    for (const p of pages) {
      domainCounts.set(p.domain, (domainCounts.get(p.domain) || 0) + 1);
    }
    const topDomains = Array.from(domainCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(e => e[0]);

    let summaryText = '';
    if (pages.length === 0) {
      summaryText = `No browsing activity recorded for ${dateStr}.`;
    } else if (summarizerFn) {
      summaryText = await summarizerFn(pages);
    } else {
      // Deterministic fallback summary
      const uniqueTitles = Array.from(new Set(pages.map(p => p.title))).slice(0, 8);
      summaryText = `Browsed ${pages.length} pages across ${domainCounts.size} domains (${topDomains.join(', ')}). Explored topics: ${uniqueTitles.join('; ')}.`;
    }

    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO daily_summaries (date, summary, top_domains, page_count, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    insertStmt.run(dateStr, summaryText, JSON.stringify(topDomains), pages.length, now);

    return {
      date: dateStr,
      summary: summaryText,
      topDomains,
      pageCount: pages.length,
      createdAt: now
    };
  }

  public getPageByUrl(url: string): PageRecord | null {
    this.ensureOpen();
    const stmt = this.db.prepare('SELECT id, url, domain, title, snippet, full_text, visited_at, visit_count, embedding, metadata FROM pages WHERE url = ?');
    const row = stmt.get(url) as any;
    return row ? this.rowToPageRecord(row) : null;
  }

  public getRecentPages(limit = 20): PageRecord[] {
    this.ensureOpen();
    const stmt = this.db.prepare('SELECT id, url, domain, title, snippet, full_text, visited_at, visit_count, embedding, metadata FROM pages ORDER BY visited_at DESC LIMIT ?');
    const rows = stmt.all(limit) as any[];
    return rows.map(r => this.rowToPageRecord(r));
  }

  public deletePage(url: string): boolean {
    this.ensureOpen();
    const stmt = this.db.prepare('DELETE FROM pages WHERE url = ?');
    const info = stmt.run(url) as any;
    return (info?.changes ?? 0) > 0;
  }

  public clearHistory(): void {
    this.ensureOpen();
    this.db.exec('DELETE FROM pages; DELETE FROM daily_summaries;');
  }

  public close(): void {
    if (!this.isClosed) {
      this.db.close();
      this.isClosed = true;
    }
  }

  private ensureOpen(): void {
    if (this.isClosed) {
      throw new Error('MemoryStore is closed.');
    }
  }

  private rowToPageRecord(row: any): PageRecord {
    return {
      id: row.id,
      url: row.url,
      domain: row.domain,
      title: row.title,
      snippet: row.snippet,
      fullText: row.full_text,
      visitedAt: row.visited_at,
      visitCount: row.visit_count,
      embedding: row.embedding ? JSON.parse(row.embedding) : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined
    };
  }
}
