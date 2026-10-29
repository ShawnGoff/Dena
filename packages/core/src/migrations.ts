import type Database from "better-sqlite3";

/**
 * Ordered, append-only migrations. Never edit a shipped migration; add a new one.
 * Later layers (episodes, project memory, wiki sections, revisions) arrive as
 * their own migrations when those milestones land.
 */
const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "l0_events",
    sql: `
CREATE TABLE project (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  root_path       TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  settings_json   TEXT NOT NULL DEFAULT '{}',
  recording_state TEXT NOT NULL DEFAULT 'stopped'
                  CHECK (recording_state IN ('recording','paused','stopped'))
);

-- A session groups events; it is not proof that its events belong to one task.
CREATE TABLE session (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  source         TEXT NOT NULL,
  started_at     TEXT,
  ended_at       TEXT,
  source_summary TEXT,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))
);
CREATE INDEX session_project ON session(project_id, started_at);

CREATE TABLE event (
  id                 INTEGER PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  session_id         TEXT REFERENCES session(id) ON DELETE CASCADE,
  source             TEXT NOT NULL,
  source_event_id    TEXT NOT NULL,
  event_type         TEXT NOT NULL,
  occurred_at        TEXT NOT NULL,
  observed_at        TEXT NOT NULL,
  actor              TEXT NOT NULL CHECK (actor IN ('user','ai_agent','automated_tool','unknown')),
  summary            TEXT NOT NULL,
  payload_json       TEXT NOT NULL,
  capture_confidence TEXT NOT NULL CHECK (capture_confidence IN ('observed','derived','partial')),
  content_hash       TEXT NOT NULL,
  raw_ref            TEXT,
  schema_version     INTEGER NOT NULL,
  redaction_version  INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  UNIQUE (project_id, source, source_event_id)
);
CREATE INDEX event_timeline ON event(project_id, occurred_at, id);
CREATE INDEX event_session ON event(session_id, occurred_at);
CREATE INDEX event_type ON event(project_id, event_type);

-- Large or binary content lives in the content-addressed blob store; this row describes it.
CREATE TABLE artifact (
  id                 INTEGER PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  artifact_type      TEXT NOT NULL,
  uri_or_path        TEXT,
  content_hash       TEXT NOT NULL,
  size_bytes         INTEGER NOT NULL,
  metadata_json      TEXT NOT NULL DEFAULT '{}',
  captured_at        TEXT NOT NULL,
  sensitivity_status TEXT NOT NULL DEFAULT 'redacted'
                     CHECK (sensitivity_status IN ('redacted','clean','excluded')),
  UNIQUE (project_id, content_hash, artifact_type)
);

CREATE TABLE event_artifact (
  event_id    INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  artifact_id INTEGER NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  role        TEXT NOT NULL, -- e.g. 'diff', 'stdout', 'full_input'
  PRIMARY KEY (event_id, artifact_id, role)
);

CREATE TABLE event_link (
  id            INTEGER PRIMARY KEY,
  from_event_id INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  to_event_id   INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  link_type     TEXT NOT NULL,
  strength      TEXT NOT NULL CHECK (strength IN ('observed','inferred','weak')),
  basis         TEXT NOT NULL,
  UNIQUE (from_event_id, to_event_id, link_type)
);

-- Known holes in coverage. Surfacing these is a product requirement, not an error path.
CREATE TABLE capture_gap (
  id         INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES session(id) ON DELETE CASCADE,
  source     TEXT NOT NULL,
  from_time  TEXT,
  to_time    TEXT,
  reason     TEXT NOT NULL,
  UNIQUE (project_id, source, session_id, reason)
);

-- Single-row switch that lets the store perform sanctioned deletes (project deletion).
CREATE TABLE maintenance (id INTEGER PRIMARY KEY CHECK (id = 1), allow_delete INTEGER NOT NULL DEFAULT 0);
INSERT INTO maintenance (id, allow_delete) VALUES (1, 0);

-- Accepted events are immutable. The only permitted update is a redaction pass that
-- bumps redaction_version and leaves identity, timing and attribution untouched.
CREATE TRIGGER event_immutable BEFORE UPDATE ON event
WHEN NOT (
  NEW.redaction_version > OLD.redaction_version
  AND NEW.id = OLD.id AND NEW.project_id = OLD.project_id
  AND NEW.source = OLD.source AND NEW.source_event_id = OLD.source_event_id
  AND NEW.event_type = OLD.event_type AND NEW.occurred_at = OLD.occurred_at
  AND NEW.actor = OLD.actor AND NEW.capture_confidence = OLD.capture_confidence
)
BEGIN
  SELECT RAISE(ABORT, 'events are immutable; only redaction updates are allowed');
END;

CREATE TRIGGER event_no_delete BEFORE DELETE ON event
WHEN (SELECT allow_delete FROM maintenance WHERE id = 1) = 0
BEGIN
  SELECT RAISE(ABORT, 'events cannot be deleted outside project deletion');
END;
`,
  },
];

export function migrate(db: Database.Database): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const current =
    (db.prepare("SELECT MAX(version) AS v FROM schema_migration").get() as { v: number | null }).v ?? 0;
  const pending = MIGRATIONS.filter((m) => m.version > current);
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    })();
  }
  return pending.length;
}

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
