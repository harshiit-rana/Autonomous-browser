-- 0001_core: settings, missions, mission event log, evidence (Issue #239)

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,          -- JSON
  updated_at INTEGER NOT NULL
);

CREATE TABLE missions (
  id             TEXT PRIMARY KEY,
  prompt         TEXT NOT NULL,
  model          TEXT NOT NULL,
  state          TEXT NOT NULL,
  step_count     INTEGER NOT NULL DEFAULT 0,
  tab_id         TEXT,
  result         TEXT,
  error          TEXT,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  imported_from  TEXT                -- set when migrated from a legacy JSON checkpoint
);
CREATE INDEX idx_missions_created ON missions(created_at DESC, id);

-- seq is a per-mission monotonic counter and is the ordering key (wall clocks can go backwards).
CREATE TABLE mission_events (
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  json       TEXT NOT NULL,
  PRIMARY KEY (mission_id, seq)
) WITHOUT ROWID;
CREATE INDEX idx_mission_events_kind ON mission_events(mission_id, kind, seq);

CREATE TABLE evidence (
  id           TEXT PRIMARY KEY,
  mission_id   TEXT REFERENCES missions(id) ON DELETE SET NULL,
  entity       TEXT NOT NULL,
  attribute    TEXT NOT NULL,
  category     TEXT NOT NULL,
  value        TEXT NOT NULL,        -- JSON
  normalized   TEXT NOT NULL,        -- JSON
  source       TEXT NOT NULL,        -- JSON
  worker_id    TEXT NOT NULL,
  step_id      TEXT,
  confidence   REAL NOT NULL,
  supersedes_id TEXT,
  content_hash TEXT NOT NULL,
  timestamp    INTEGER NOT NULL
);
CREATE INDEX idx_evidence_mission ON evidence(mission_id, timestamp);
CREATE INDEX idx_evidence_cluster ON evidence(entity, attribute);
CREATE INDEX idx_evidence_hash ON evidence(content_hash);
