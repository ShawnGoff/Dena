import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BlobStore, sha256 } from "./blobs.ts";
import { migrate } from "./migrations.ts";
import {
  EVENT_SCHEMA_VERSION,
  NewEvent,
  type NewGap,
  type NewLink,
  type StoredEvent,
} from "./model.ts";

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  recordingState: "recording" | "paused" | "stopped";
}

export interface IngestBatch {
  sessions: { id: string; source: string; startedAt: string | null; endedAt: string | null; summary?: string }[];
  events: NewEvent[];
  /** Artifact bodies keyed by the sourceEventId of the event they belong to. Already redacted. */
  artifacts: { sourceEventId: string; role: string; artifactType: string; uriOrPath?: string; content: string }[];
  links: NewLink[];
  gaps: NewGap[];
}

export interface IngestResult {
  eventsInserted: number;
  eventsSkippedDuplicate: number;
  linksInserted: number;
  artifactsStored: number;
  gapsRecorded: number;
}

/**
 * Local event store: one SQLite file plus a blob directory per Dena home.
 * Capture must never depend on AI, so nothing here calls out to a model.
 */
export class Store {
  readonly db: Database.Database;
  readonly blobs: BlobStore;

  constructor(home: string) {
    fs.mkdirSync(home, { recursive: true });
    this.db = new Database(path.join(home, "dena.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    migrate(this.db);
    this.blobs = new BlobStore(path.join(home, "blobs"));
  }

  close(): void {
    this.db.close();
  }

  createProject(name: string, rootPath: string): Project {
    const now = new Date().toISOString();
    const id = randomUUID();
    const root = path.resolve(rootPath);
    this.db
      .prepare("INSERT INTO project (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, name, root, now, now);
    return { id, name, rootPath: root, createdAt: now, recordingState: "stopped" };
  }

  listProjects(): Project[] {
    return (this.db.prepare("SELECT * FROM project ORDER BY created_at").all() as any[]).map(rowToProject);
  }

  findProject(idOrNameOrPath: string): Project | null {
    const resolved = path.resolve(idOrNameOrPath);
    const row = this.db
      .prepare("SELECT * FROM project WHERE id = ? OR name = ? OR root_path = ? LIMIT 1")
      .get(idOrNameOrPath, idOrNameOrPath, resolved);
    return row ? rowToProject(row) : null;
  }

  setRecordingState(projectId: string, state: Project["recordingState"]): void {
    this.db
      .prepare("UPDATE project SET recording_state = ?, updated_at = ? WHERE id = ?")
      .run(state, new Date().toISOString(), projectId);
  }

  /** Deletes a project and every event, artifact row and gap that belongs to it. */
  deleteProject(projectId: string): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE maintenance SET allow_delete = 1 WHERE id = 1").run();
      this.db.prepare("DELETE FROM project WHERE id = ?").run(projectId);
      this.db.prepare("UPDATE maintenance SET allow_delete = 0 WHERE id = 1").run();
    })();
    // Blobs are content-addressed and may be shared across projects; orphan GC is a later task.
  }

  /** Writes a batch atomically. Re-ingesting the same records is a no-op thanks to source ids. */
  ingest(projectId: string, batch: IngestBatch): IngestResult {
    const result: IngestResult = {
      eventsInserted: 0,
      eventsSkippedDuplicate: 0,
      linksInserted: 0,
      artifactsStored: 0,
      gapsRecorded: 0,
    };
    const now = new Date().toISOString();

    const upsertSession = this.db.prepare(`
      INSERT INTO session (id, project_id, source, started_at, ended_at, source_summary)
      VALUES (@id, @projectId, @source, @startedAt, @endedAt, @summary)
      ON CONFLICT (id) DO UPDATE SET
        started_at = MIN(COALESCE(session.started_at, excluded.started_at), COALESCE(excluded.started_at, session.started_at)),
        ended_at   = MAX(COALESCE(session.ended_at, excluded.ended_at), COALESCE(excluded.ended_at, session.ended_at)),
        source_summary = COALESCE(excluded.source_summary, session.source_summary)`);
    const insertEvent = this.db.prepare(`
      INSERT INTO event (project_id, session_id, source, source_event_id, event_type, occurred_at, observed_at,
                         actor, summary, payload_json, capture_confidence, content_hash, raw_ref, schema_version, created_at)
      VALUES (@projectId, @sessionId, @source, @sourceEventId, @eventType, @occurredAt, @observedAt,
              @actor, @summary, @payload, @captureConfidence, @contentHash, @rawRef, @schemaVersion, @createdAt)
      ON CONFLICT (project_id, source, source_event_id) DO NOTHING`);
    const eventIdBySource = this.db.prepare(
      "SELECT id FROM event WHERE project_id = ? AND source = ? AND source_event_id = ?",
    );
    const upsertArtifact = this.db.prepare(`
      INSERT INTO artifact (project_id, artifact_type, uri_or_path, content_hash, size_bytes, captured_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_id, content_hash, artifact_type) DO NOTHING`);
    const artifactId = this.db.prepare(
      "SELECT id FROM artifact WHERE project_id = ? AND content_hash = ? AND artifact_type = ?",
    );
    const linkArtifact = this.db.prepare(
      "INSERT OR IGNORE INTO event_artifact (event_id, artifact_id, role) VALUES (?, ?, ?)",
    );
    const insertLink = this.db.prepare(`
      INSERT OR IGNORE INTO event_link (from_event_id, to_event_id, link_type, strength, basis)
      VALUES (?, ?, ?, ?, ?)`);
    const insertGap = this.db.prepare(`
      INSERT OR IGNORE INTO capture_gap (project_id, session_id, source, from_time, to_time, reason)
      VALUES (?, ?, ?, ?, ?, ?)`);

    // Blob writes happen outside the transaction; they are idempotent and harmless if the txn rolls back.
    const blobRefs = batch.artifacts.map((a) => ({ ...a, ...this.blobs.put(a.content) }));

    this.db.transaction(() => {
      for (const s of batch.sessions) {
        upsertSession.run({ projectId, summary: s.summary ?? null, ...s });
      }
      for (const raw of batch.events) {
        const e = NewEvent.parse(raw);
        const payload = JSON.stringify(e.payload);
        const info = insertEvent.run({
          projectId,
          sessionId: e.sessionId,
          source: e.source,
          sourceEventId: e.sourceEventId,
          eventType: e.eventType,
          occurredAt: e.occurredAt,
          observedAt: now,
          actor: e.actor,
          summary: e.summary,
          payload,
          captureConfidence: e.captureConfidence,
          contentHash: sha256(`${e.eventType}\n${e.summary}\n${payload}`),
          rawRef: e.rawRef ?? null,
          schemaVersion: EVENT_SCHEMA_VERSION,
          createdAt: now,
        });
        if (info.changes) result.eventsInserted++;
        else result.eventsSkippedDuplicate++;
      }
      const idOf = (source: string, sid: string) =>
        (eventIdBySource.get(projectId, source, sid) as { id: number } | undefined)?.id;

      const sourceOf = new Map(batch.events.map((e) => [e.sourceEventId, e.source]));
      for (const a of blobRefs) {
        const evSource = sourceOf.get(a.sourceEventId);
        const evId = evSource ? idOf(evSource, a.sourceEventId) : undefined;
        if (!evId) continue;
        const ins = upsertArtifact.run(projectId, a.artifactType, a.uriOrPath ?? null, a.hash, a.size, now);
        if (ins.changes) result.artifactsStored++;
        const art = artifactId.get(projectId, a.hash, a.artifactType) as { id: number };
        linkArtifact.run(evId, art.id, a.role);
      }
      for (const l of batch.links) {
        const from = idOf(l.source, l.fromSourceEventId);
        const to = idOf(l.source, l.toSourceEventId);
        if (!from || !to) continue;
        if (insertLink.run(from, to, l.linkType, l.strength, l.basis).changes) result.linksInserted++;
      }
      for (const g of batch.gaps) {
        if (insertGap.run(projectId, g.sessionId, g.source, g.fromTime, g.toTime, g.reason).changes)
          result.gapsRecorded++;
      }
      this.db.prepare("UPDATE project SET updated_at = ? WHERE id = ?").run(now, projectId);
    })();
    return result;
  }

  timeline(projectId: string, opts: { limit?: number; sessionId?: string; types?: string[] } = {}): StoredEvent[] {
    const where = ["project_id = @projectId"];
    if (opts.sessionId) where.push("session_id = @sessionId");
    if (opts.types?.length) where.push(`event_type IN (${opts.types.map((_, i) => `@t${i}`).join(",")})`);
    const params: Record<string, unknown> = { projectId, sessionId: opts.sessionId, limit: opts.limit ?? -1 };
    opts.types?.forEach((t, i) => (params[`t${i}`] = t));
    const rows = this.db
      .prepare(`SELECT * FROM event WHERE ${where.join(" AND ")} ORDER BY occurred_at, id LIMIT @limit`)
      .all(params) as any[];
    return rows.map(rowToEvent);
  }

  linksFor(eventId: number): { direction: "out" | "in"; otherId: number; linkType: string; strength: string; basis: string }[] {
    const out = this.db
      .prepare("SELECT to_event_id AS other, link_type, strength, basis FROM event_link WHERE from_event_id = ?")
      .all(eventId) as any[];
    const inc = this.db
      .prepare("SELECT from_event_id AS other, link_type, strength, basis FROM event_link WHERE to_event_id = ?")
      .all(eventId) as any[];
    return [
      ...out.map((r) => ({ direction: "out" as const, otherId: r.other, linkType: r.link_type, strength: r.strength, basis: r.basis })),
      ...inc.map((r) => ({ direction: "in" as const, otherId: r.other, linkType: r.link_type, strength: r.strength, basis: r.basis })),
    ];
  }

  artifactsFor(eventId: number): { role: string; artifactType: string; uriOrPath: string | null; contentHash: string; sizeBytes: number }[] {
    return (
      this.db
        .prepare(`SELECT ea.role, a.artifact_type, a.uri_or_path, a.content_hash, a.size_bytes
                  FROM event_artifact ea JOIN artifact a ON a.id = ea.artifact_id WHERE ea.event_id = ?`)
        .all(eventId) as any[]
    ).map((r) => ({
      role: r.role,
      artifactType: r.artifact_type,
      uriOrPath: r.uri_or_path,
      contentHash: r.content_hash,
      sizeBytes: r.size_bytes,
    }));
  }

  gaps(projectId: string): (NewGap & { id: number })[] {
    return (this.db.prepare("SELECT * FROM capture_gap WHERE project_id = ? ORDER BY from_time").all(projectId) as any[]).map(
      (r) => ({ id: r.id, sessionId: r.session_id, source: r.source, fromTime: r.from_time, toTime: r.to_time, reason: r.reason }),
    );
  }

  stats(projectId: string) {
    const byType = this.db
      .prepare("SELECT event_type AS type, COUNT(*) AS n FROM event WHERE project_id = ? GROUP BY event_type ORDER BY n DESC")
      .all(projectId) as { type: string; n: number }[];
    const byActor = this.db
      .prepare("SELECT actor, COUNT(*) AS n FROM event WHERE project_id = ? GROUP BY actor ORDER BY n DESC")
      .all(projectId) as { actor: string; n: number }[];
    const sessions = (this.db.prepare("SELECT COUNT(*) AS n FROM session WHERE project_id = ?").get(projectId) as { n: number }).n;
    const links = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM event_link l JOIN event e ON e.id = l.from_event_id WHERE e.project_id = ?")
        .get(projectId) as { n: number }
    ).n;
    const artifacts = (this.db.prepare("SELECT COUNT(*) AS n FROM artifact WHERE project_id = ?").get(projectId) as { n: number }).n;
    return { sessions, byType, byActor, links, artifacts, gaps: this.gaps(projectId).length };
  }
}

function rowToProject(r: any): Project {
  return { id: r.id, name: r.name, rootPath: r.root_path, createdAt: r.created_at, recordingState: r.recording_state };
}

function rowToEvent(r: any): StoredEvent {
  return {
    id: r.id,
    projectId: r.project_id,
    sessionId: r.session_id,
    source: r.source,
    sourceEventId: r.source_event_id,
    eventType: r.event_type,
    occurredAt: r.occurred_at,
    observedAt: r.observed_at,
    actor: r.actor,
    summary: r.summary,
    payload: JSON.parse(r.payload_json),
    captureConfidence: r.capture_confidence,
    contentHash: r.content_hash,
    rawRef: r.raw_ref,
  };
}
