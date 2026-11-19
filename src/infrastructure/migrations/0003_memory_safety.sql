-- 0003_memory_safety: memories, memory chunks, approvals, action ledger (Issue #239)

CREATE TABLE memories (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  content    TEXT NOT NULL,
  source     TEXT,
  mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_memories_created ON memories(created_at DESC);

CREATE TABLE memory_chunks (
  memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  text        TEXT NOT NULL,
  embedding   TEXT,                       -- JSON array; real embeddings arrive with #240
  PRIMARY KEY (memory_id, chunk_index)
) WITHOUT ROWID;

CREATE TABLE approvals (
  id           TEXT PRIMARY KEY,
  mission_id   TEXT REFERENCES missions(id) ON DELETE CASCADE,
  action       TEXT NOT NULL,             -- JSON description of the gated action
  status       TEXT NOT NULL DEFAULT 'pending',
  reason       TEXT,
  requested_at INTEGER NOT NULL,
  decided_at   INTEGER
);
CREATE INDEX idx_approvals_status ON approvals(status, requested_at);

CREATE TABLE action_ledger (
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  action     TEXT NOT NULL,
  reversible INTEGER NOT NULL DEFAULT 0,
  undone     INTEGER NOT NULL DEFAULT 0,
  ts         INTEGER NOT NULL,
  json       TEXT NOT NULL,
  PRIMARY KEY (mission_id, seq)
) WITHOUT ROWID;
