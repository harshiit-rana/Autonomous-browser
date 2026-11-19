-- 0004_pages: browsing-recall store with FTS5, moved to the shared better-sqlite3 layer (Issue #239). Rework of retrieval is #240.

CREATE TABLE pages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  url         TEXT UNIQUE NOT NULL,
  domain      TEXT NOT NULL,
  title       TEXT NOT NULL,
  snippet     TEXT NOT NULL,
  full_text   TEXT NOT NULL,
  visited_at  INTEGER NOT NULL,
  visit_count INTEGER NOT NULL DEFAULT 1,
  embedding   TEXT,
  metadata    TEXT
);
CREATE INDEX idx_pages_domain ON pages(domain);
CREATE INDEX idx_pages_visited ON pages(visited_at DESC);

CREATE VIRTUAL TABLE pages_fts USING fts5(
  url, title, snippet, full_text,
  content='pages', content_rowid='id'
);

CREATE TRIGGER pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, url, title, snippet, full_text)
  VALUES (new.id, new.url, new.title, new.snippet, new.full_text);
END;

CREATE TRIGGER pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, url, title, snippet, full_text)
  VALUES ('delete', old.id, old.url, old.title, old.snippet, old.full_text);
END;

CREATE TRIGGER pages_au AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, url, title, snippet, full_text)
  VALUES ('delete', old.id, old.url, old.title, old.snippet, old.full_text);
  INSERT INTO pages_fts(rowid, url, title, snippet, full_text)
  VALUES (new.id, new.url, new.title, new.snippet, new.full_text);
END;

CREATE TABLE daily_summaries (
  date        TEXT PRIMARY KEY,
  summary     TEXT NOT NULL,
  top_domains TEXT NOT NULL,
  page_count  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
