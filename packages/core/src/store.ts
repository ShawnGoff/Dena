import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BlobStore, sha256 } from "./blobs.ts";
import { labelTestRun } from "./labels.ts";
import { migrate } from "./migrations.ts";
import { TEST_RULES_VERSION } from "./tests.ts";
import {
  EVENT_SCHEMA_VERSION,
  NewEvent,
  type LinkStrength,
  type LinkType,
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

export interface FsFileState {
  hash: string;
  size: number;
  mtimeMs: number;
  snapshotHash: string | null;
}

export interface ProjectSettings {
  /** Extra excluded paths, relative to the project root. A trailing "/" means a directory; "*" matches within a segment. */
  exclude: string[];
  /** Model for explanations; any Claude Code model name or alias ("haiku", "sonnet", "claude-haiku-5-5"). Unset = the user's Claude Code default. */
  model?: string;
  /** "concise" asks for fewer, shorter claims from smaller packets; "thorough" teaches in more depth. */
  depth: "concise" | "thorough";
  /** Claude Code effort level for Dena's calls (low…max). Lower spends fewer hidden reasoning tokens. Unset = Claude Code's default. */
  effort?: "low" | "medium" | "high";
  /** How explanations sign in to Claude: "account" (subscription, default) or "api-key" (billed API credits). */
  auth?: "account" | "api-key";
  /** Optional ceiling on estimated spend for one batch run, in USD as reported by Claude Code. */
  maxUsdPerRun?: number;
  /** Most tokens one batch run may use (explaining many steps, a folder, the update queue); the rest waits for the next run. */
  maxTokensPerRun?: number;
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

  constructor(readonly home: string) {
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
    this.publishRecordingState();
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
    this.publishRecordingState();
  }

  /**
   * Mirrors recording state into <home>/recording.json for the Claude Code hook, which must
   * decide in milliseconds, without loading SQLite, whether to capture anything at all.
   */
  publishRecordingState(): void {
    const projects = this.listProjects().map((p) => ({ id: p.id, root: p.rootPath, state: p.recordingState }));
    const file = path.join(this.home, "recording.json");
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ projects }, null, 2));
    fs.renameSync(tmp, file);
  }

  /** Deletes a project and every event, artifact row and gap that belongs to it. */
  deleteProject(projectId: string): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE maintenance SET allow_delete = 1 WHERE id = 1").run();
      this.db.prepare("DELETE FROM event_fts WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM project WHERE id = ?").run(projectId);
      this.db.prepare("UPDATE maintenance SET allow_delete = 0 WHERE id = 1").run();
    })();
    this.publishRecordingState();
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
          // Sources mix offsets (git: -07:00, Claude: Z); store UTC so ordering by string is correct.
          occurredAt: new Date(e.occurredAt).toISOString(),
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
        const to = idOf(l.toSource ?? l.source, l.toSourceEventId);
        if (!from || !to) continue;
        if (insertLink.run(from, to, l.linkType, l.strength, l.basis).changes) result.linksInserted++;
      }
      for (const g of batch.gaps) {
        if (insertGap.run(projectId, g.sessionId, g.source, g.fromTime, g.toTime, g.reason).changes)
          result.gapsRecorded++;
      }
      this.db.prepare("UPDATE project SET updated_at = ? WHERE id = ?").run(now, projectId);
      // A tool call imported mid-run has no result yet; once the result arrives, that gap was never real.
      this.db
        .prepare(`DELETE FROM capture_gap WHERE project_id = ? AND reason LIKE 'No result recorded for % call tool:%'
                  AND EXISTS (SELECT 1 FROM event e WHERE e.project_id = capture_gap.project_id
                              AND e.source_event_id = 'result:' || substr(capture_gap.reason, instr(capture_gap.reason, 'call tool:') + 10))`)
        .run(projectId);
    })();
    return result;
  }

  fsState(projectId: string): Map<string, FsFileState> {
    const rows = this.db.prepare("SELECT * FROM fs_state WHERE project_id = ?").all(projectId) as any[];
    return new Map(rows.map((r) => [r.path, { hash: r.content_hash, size: r.size_bytes, mtimeMs: r.mtime_ms, snapshotHash: r.snapshot_hash }]));
  }

  setFsState(projectId: string, p: string, s: FsFileState | null): void {
    if (!s) {
      this.db.prepare("DELETE FROM fs_state WHERE project_id = ? AND path = ?").run(projectId, p);
      return;
    }
    this.db
      .prepare(`INSERT INTO fs_state (project_id, path, content_hash, size_bytes, mtime_ms, snapshot_hash) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (project_id, path) DO UPDATE SET content_hash = excluded.content_hash, size_bytes = excluded.size_bytes,
                mtime_ms = excluded.mtime_ms, snapshot_hash = excluded.snapshot_hash`)
      .run(projectId, p, s.hash, s.size, s.mtimeMs, s.snapshotHash);
  }

  getCursor(projectId: string, source: string, key: string): string | null {
    const r = this.db.prepare("SELECT value FROM capture_cursor WHERE project_id = ? AND source = ? AND key = ?").get(projectId, source, key) as
      | { value: string }
      | undefined;
    return r?.value ?? null;
  }

  setCursor(projectId: string, source: string, key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO capture_cursor (project_id, source, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (project_id, source, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(projectId, source, key, value, new Date().toISOString());
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare("SELECT * FROM project WHERE id = ?").get(id);
    return row ? rowToProject(row) : null;
  }

  projectSettings(id: string): ProjectSettings {
    const r = this.db.prepare("SELECT settings_json FROM project WHERE id = ?").get(id) as { settings_json: string } | undefined;
    return { exclude: [], depth: "concise", ...(r ? JSON.parse(r.settings_json) : {}) }; // concise unless chosen: it uses far fewer tokens
  }

  updateProjectSettings(id: string, patch: Partial<ProjectSettings>): ProjectSettings {
    const next = { ...this.projectSettings(id), ...patch };
    this.db.prepare("UPDATE project SET settings_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), new Date().toISOString(), id);
    return next;
  }

  /**
   * Brings derived labels up to date: labels new events, and relabels everything when the rules
   * version changed. Cheap when nothing is new, so readers call it before reading.
   */
  ensureLabels(projectId: string): number {
    const version = String(TEST_RULES_VERSION);
    let last = Number(this.getCursor(projectId, "labels", "last_event_id") ?? 0);
    if (this.getCursor(projectId, "labels", "rules_version") !== version) {
      this.db.prepare("DELETE FROM event_label WHERE project_id = ?").run(projectId);
      last = 0;
    }
    const max = (this.db.prepare("SELECT MAX(id) m FROM event WHERE project_id = ?").get(projectId) as { m: number | null }).m ?? 0;
    if (max <= last && this.getCursor(projectId, "labels", "rules_version") === version) return 0;
    const rows = this.db
      .prepare("SELECT id, payload_json FROM event WHERE project_id = ? AND id > ? AND event_type = 'test_result' ORDER BY id")
      .all(projectId, last) as { id: number; payload_json: string }[];
    const full = this.db.prepare(`SELECT a.content_hash FROM event_artifact ea JOIN artifact a ON a.id = ea.artifact_id
                                  WHERE ea.event_id = ? AND ea.role = 'output' LIMIT 1`);
    const ins = this.db.prepare("INSERT OR REPLACE INTO event_label (project_id, event_id, key, value_json) VALUES (?, ?, 'test', ?)");
    this.db.transaction(() => {
      for (const r of rows) {
        const p = JSON.parse(r.payload_json);
        const art = full.get(r.id) as { content_hash: string } | undefined;
        // The full output when it was stored separately; the inline excerpt otherwise.
        const output = (art && this.blobs.get(art.content_hash)?.toString("utf8")) || [p.stdout, p.stderr].filter(Boolean).join("\n");
        const label = labelTestRun({ command: String(p.command ?? ""), output, isError: p.status === "error", interrupted: !!p.interrupted },
          { outcome: p.outcome, passed: p.testsPassed ?? undefined, failed: p.testsFailed ?? undefined, basis: p.outcomeBasis });
        ins.run(projectId, r.id, JSON.stringify(label));
      }
    })();
    this.setCursor(projectId, "labels", "last_event_id", String(max));
    this.setCursor(projectId, "labels", "rules_version", version);
    return rows.length;
  }

  private attachLabels(projectId: string, events: StoredEvent[]): StoredEvent[] {
    if (!events.length) return events;
    const rows = (events.length > 500
      ? this.db.prepare("SELECT event_id, key, value_json FROM event_label WHERE project_id = ?").all(projectId)
      : this.db.prepare(`SELECT event_id, key, value_json FROM event_label WHERE event_id IN (${events.map(() => "?").join(",")})`).all(...events.map((e) => e.id))) as
      { event_id: number; key: string; value_json: string }[];
    const by = new Map<number, Record<string, any>>();
    for (const r of rows) {
      const m = by.get(r.event_id) ?? {};
      m[r.key] = JSON.parse(r.value_json);
      by.set(r.event_id, m);
    }
    for (const e of events) if (by.has(e.id)) e.labels = by.get(e.id);
    return events;
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
    this.ensureLabels(projectId);
    return this.attachLabels(projectId, rows.map(rowToEvent));
  }

  /** Adds links between already-stored events (used by deterministic correlation). Idempotent. */
  linkEvents(links: { from: number; to: number; linkType: LinkType; strength: LinkStrength; basis: string }[]): number {
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO event_link (from_event_id, to_event_id, link_type, strength, basis) VALUES (?, ?, ?, ?, ?)",
    );
    let n = 0;
    this.db.transaction(() => {
      for (const l of links) n += ins.run(l.from, l.to, l.linkType, l.strength, l.basis).changes;
    })();
    return n;
  }

  recordGap(projectId: string, gap: NewGap): void {
    this.db
      .prepare("INSERT OR IGNORE INTO capture_gap (project_id, session_id, source, from_time, to_time, reason) VALUES (?, ?, ?, ?, ?, ?)")
      .run(projectId, gap.sessionId, gap.source, gap.fromTime, gap.toTime, gap.reason);
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

  /** Adds events stored since the last call to the search index. Cheap when nothing is new. */
  indexForSearch(projectId: string): number {
    const last = Number(this.getCursor(projectId, "search", "last_event_id") ?? 0);
    const rows = this.db
      .prepare("SELECT id, summary, payload_json FROM event WHERE project_id = ? AND id > ? ORDER BY id")
      .all(projectId, last) as { id: number; summary: string; payload_json: string }[];
    if (!rows.length) return 0;
    const ins = this.db.prepare("INSERT INTO event_fts (summary, body, project_id, event_id) VALUES (?, ?, ?, ?)");
    this.db.transaction(() => {
      for (const r of rows) {
        const p = JSON.parse(r.payload_json);
        const body = [p.text, p.input?.command, p.command, p.message, p.file, p.input?.file_path, p.stdout, p.output]
          .filter((x) => typeof x === "string").join("\n").slice(0, 8_000);
        ins.run(r.summary, body, projectId, r.id);
      }
    })();
    this.setCursor(projectId, "search", "last_event_id", String(rows[rows.length - 1]!.id));
    return rows.length;
  }

  search(projectId: string, query: string, limit = 50): { event: StoredEvent; snippet: string }[] {
    this.indexForSearch(projectId);
    // Treat the user's words as plain terms (quoted), so punctuation cannot become FTS syntax.
    const terms = query.match(/[\p{L}\p{N}_.-]+/gu)?.map((t) => `"${t.replace(/"/g, "")}"`) ?? [];
    if (!terms.length) return [];
    const hits = this.db
      .prepare(`SELECT event_id, snippet(event_fts, 1, '[', ']', '…', 12) AS snip FROM event_fts
                WHERE event_fts MATCH ? AND project_id = ? ORDER BY rank LIMIT ?`)
      .all(terms.join(" "), projectId, limit) as { event_id: number; snip: string }[];
    const byId = new Map(this.eventsById(projectId, hits.map((h) => h.event_id)).map((e) => [e.id, e]));
    return hits.flatMap((h) => (byId.has(h.event_id) ? [{ event: byId.get(h.event_id)!, snippet: h.snip }] : []));
  }

  eventsById(projectId: string, ids: number[]): StoredEvent[] {
    if (!ids.length) return [];
    const rows = this.db
      .prepare(`SELECT * FROM event WHERE project_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
      .all(projectId, ...ids) as any[];
    this.ensureLabels(projectId);
    return this.attachLabels(projectId, rows.map(rowToEvent));
  }

  hasEvent(projectId: string, source: string, sourceEventId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM event WHERE project_id = ? AND source = ? AND source_event_id = ?").get(projectId, source, sourceEventId);
  }

  hasSessionEvents(projectId: string, sessionId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM event WHERE project_id = ? AND session_id = ? LIMIT 1").get(projectId, sessionId);
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
