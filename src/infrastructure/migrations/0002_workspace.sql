-- 0002_workspace: threads, messages, prompts, prompt versions, instructions, schedules, inbox (Issue #239)
-- Tables only; their product UIs are tracked in #241-#246.

CREATE TABLE threads (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  parent_id    TEXT REFERENCES threads(id) ON DELETE SET NULL,
  archived     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_threads_updated ON threads(updated_at DESC, id);

CREATE TABLE messages (
  thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
  ts         INTEGER NOT NULL,
  meta       TEXT,
  PRIMARY KEY (thread_id, seq)
) WITHOUT ROWID;

CREATE TABLE prompts (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL DEFAULT 'template',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE prompt_versions (
  prompt_id  TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  body       TEXT NOT NULL,
  variables  TEXT NOT NULL DEFAULT '[]',   -- JSON array
  created_at INTEGER NOT NULL,
  PRIMARY KEY (prompt_id, version)
) WITHOUT ROWID;

CREATE TABLE instructions (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,                -- global | domain | mission
  scope_key  TEXT,
  content    TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  priority   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_instructions_scope ON instructions(scope, scope_key);

CREATE TABLE schedules (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  cron        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER,
  last_run_at INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_schedules_due ON schedules(enabled, next_run_at);

CREATE TABLE inbox_items (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  read_at    INTEGER
);
CREATE INDEX idx_inbox_unread ON inbox_items(read_at, created_at DESC);
