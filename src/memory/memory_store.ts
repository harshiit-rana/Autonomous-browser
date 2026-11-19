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

import { AegisDb } from '../infrastructure/db.js';
import { PagesRepo } from '../infrastructure/repos/pages_repo.js';

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
  private readonly pages: PagesRepo;
  private readonly db: AegisDb;
  private readonly ownsDb: boolean;
  private isClosed = false;

  /**
   * Backed by the shared SQLite layer (better-sqlite3 + migrations, works in Electron 33).
   * Pass a path/':memory:' to open a private database, or an existing AegisDb to share the app database.
   */
  constructor(dbOrPath: string | AegisDb = ':memory:') {
    if (typeof dbOrPath === 'string') {
      this.db = AegisDb.open(dbOrPath);
      this.ownsDb = true;
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }
    this.pages = new PagesRepo(this.db);
  }

  /**
   * Records a visited page with automatic embedding calculation and FTS indexing.
   */
  public recordPage(record: PageRecord): void {
    this.ensureOpen();
    const visitedAt = record.visitedAt ?? Date.now();
    const embedding = record.embedding ?? generateLocalEmbedding(`${record.title} ${record.snippet} ${record.fullText.slice(0, 2000)}`);
    this.pages.upsert({ ...record, visitedAt, embedding });
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

    // In FTS5, bm25 returns negative score where lower (more negative) is better.
    // We normalize to positive score: score = 1 / (1 + abs(rank))
    return this.pages.searchFts(ftsQuery, limit).map(r => ({
      page: r.page,
      score: 1 / (1 + Math.abs(r.rank)),
      matchType: 'fts' as const
    }));
  }

  /**
   * Vector semantic similarity search across stored embeddings.
   */
  public searchVector(queryEmbedding: number[], topK = 10): PageSearchResult[] {
    this.ensureOpen();
    const scored: PageSearchResult[] = [];
    for (const page of this.pages.allWithEmbeddings()) {
      if (!page.embedding) continue;
      scored.push({
        page,
        score: cosineSimilarity(queryEmbedding, page.embedding),
        matchType: 'vector'
      });
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
    const existing = this.pages.getSummary(dateStr);
    if (existing) return existing;

    // Get pages visited on this calendar day
    const dayStart = new Date(`${dateStr}T00:00:00Z`).getTime();
    const dayEnd = dayStart + 86400000;
    const pages: PageRecord[] = this.pages.visitedBetween(dayStart, dayEnd);

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

    const now = Date.now();
    this.pages.putSummary({ date: dateStr, summary: summaryText, topDomains, pageCount: pages.length, createdAt: now });

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
    return this.pages.getByUrl(url);
  }

  public getRecentPages(limit = 20): PageRecord[] {
    this.ensureOpen();
    return this.pages.recent(limit);
  }

  public deletePage(url: string): boolean {
    this.ensureOpen();
    return this.pages.deleteByUrl(url);
  }

  public clearHistory(): void {
    this.ensureOpen();
    this.pages.clearAll();
  }

  public close(): void {
    if (!this.isClosed) {
      if (this.ownsDb) this.db.close();
      this.isClosed = true;
    }
  }

  private ensureOpen(): void {
    if (this.isClosed) {
      throw new Error('MemoryStore is closed.');
    }
  }
}
