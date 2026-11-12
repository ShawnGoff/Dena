import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store, type IngestBatch, type NewEvent } from "../src/index.ts";

let home: string;
let store: Store;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dena-store-"));
  store = new Store(home);
});
afterEach(() => {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const ev = (id: string, over: Partial<NewEvent> = {}): NewEvent => ({
  sessionId: "s1",
  source: "test",
  sourceEventId: id,
  eventType: "tool_invoked",
  occurredAt: "2026-10-01T10:00:00.000Z",
  actor: "ai_agent",
  summary: `event ${id}`,
  payload: { n: id },
  captureConfidence: "observed",
  ...over,
});

const batch = (over: Partial<IngestBatch> = {}): IngestBatch => ({
  sessions: [{ id: "s1", source: "test", startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T11:00:00.000Z" }],
  events: [ev("a"), ev("b", { occurredAt: "2026-10-01T10:05:00.000Z", eventType: "tool_completed" })],
  artifacts: [{ sourceEventId: "b", role: "stdout", artifactType: "command_output", content: "hello" }],
  links: [{ source: "test", fromSourceEventId: "b", toSourceEventId: "a", linkType: "result_of", strength: "observed", basis: "test" }],
  gaps: [{ sessionId: "s1", source: "test", fromTime: null, toTime: null, reason: "thinking not stored" }],
  ...over,
});

describe("Store", () => {
  it("ingests events, links, artifacts and gaps, and is idempotent", () => {
    const p = store.createProject("demo", "/tmp/demo");
    const first = store.ingest(p.id, batch());
    expect(first).toMatchObject({ eventsInserted: 2, linksInserted: 1, artifactsStored: 1, gapsRecorded: 1 });

    const second = store.ingest(p.id, batch());
    expect(second).toMatchObject({ eventsInserted: 0, eventsSkippedDuplicate: 2, linksInserted: 0, gapsRecorded: 0 });

    const tl = store.timeline(p.id);
    expect(tl.map((e) => e.sourceEventId)).toEqual(["a", "b"]);
    expect(store.linksFor(tl[1]!.id)[0]).toMatchObject({ direction: "out", linkType: "result_of", strength: "observed" });
    const [art] = store.artifactsFor(tl[1]!.id);
    expect(store.blobs.get(art!.contentHash)?.toString()).toBe("hello");
  });

  it("does not duplicate project-level gaps", () => {
    const p = store.createProject("demo", "/tmp/demo");
    const gap = { sessionId: null, source: "git", fromTime: null, toTime: null, reason: "reflog limit" };
    store.ingest(p.id, batch({ gaps: [gap] }));
    store.ingest(p.id, batch({ gaps: [gap] }));
    store.recordGap(p.id, gap);
    expect(store.gaps(p.id).filter((g) => g.reason === "reflog limit")).toHaveLength(1);
  });

  it("clears a 'no result' gap once the result arrives", () => {
    const p = store.createProject("demo", "/tmp/demo");
    const gap = { sessionId: "s1", source: "test", fromTime: null, toTime: null, reason: "No result recorded for Bash call tool:x1" };
    store.ingest(p.id, batch({ events: [ev("tool:x1")], artifacts: [], links: [], gaps: [gap] }));
    expect(store.gaps(p.id).some((g) => g.reason === gap.reason)).toBe(true);
    store.ingest(p.id, batch({ events: [ev("result:x1", { eventType: "command_executed" })], artifacts: [], links: [], gaps: [] }));
    expect(store.gaps(p.id).some((g) => g.reason === gap.reason)).toBe(false);
  });

  it("survives a restart", () => {
    const p = store.createProject("demo", "/tmp/demo");
    store.ingest(p.id, batch());
    store.close();
    store = new Store(home);
    expect(store.findProject("demo")?.id).toBe(p.id);
    expect(store.timeline(p.id)).toHaveLength(2);
  });

  it("rejects edits and deletes of accepted events", () => {
    const p = store.createProject("demo", "/tmp/demo");
    store.ingest(p.id, batch());
    expect(() => store.db.prepare("UPDATE event SET summary = 'rewritten'").run()).toThrow(/immutable/);
    expect(() => store.db.prepare("UPDATE event SET actor = 'user', redaction_version = 1").run()).toThrow(/immutable/);
    expect(() => store.db.prepare("DELETE FROM event").run()).toThrow(/cannot be deleted/);
  });

  it("allows a redaction pass that only touches content", () => {
    const p = store.createProject("demo", "/tmp/demo");
    store.ingest(p.id, batch());
    const n = store.db
      .prepare("UPDATE event SET payload_json = '{}', redaction_version = redaction_version + 1 WHERE source_event_id = 'a'")
      .run().changes;
    expect(n).toBe(1);
  });

  it("deletes a project and all of its events", () => {
    const p = store.createProject("demo", "/tmp/demo");
    store.ingest(p.id, batch());
    store.deleteProject(p.id);
    expect(store.listProjects()).toHaveLength(0);
    expect((store.db.prepare("SELECT COUNT(*) n FROM event").get() as { n: number }).n).toBe(0);
    // The delete switch is closed again afterwards.
    expect((store.db.prepare("SELECT allow_delete FROM maintenance").get() as { allow_delete: number }).allow_delete).toBe(0);
  });

  it("validates events against the schema", () => {
    const p = store.createProject("demo", "/tmp/demo");
    expect(() => store.ingest(p.id, batch({ events: [ev("x", { actor: "robot" as never })] }))).toThrow();
    expect(store.timeline(p.id)).toHaveLength(0); // whole batch rolled back
  });
});

describe("a Claude session shared by two projects", () => {
  it("is counted for both, and deleting one project keeps the other's events", () => {
    const a = store.createProject("a", "/tmp/shared-a");
    const b = store.createProject("b", "/tmp/shared-b");
    store.ingest(a.id, batch({ artifacts: [], links: [], gaps: [], events: [ev("a1")] }));
    store.ingest(b.id, batch({ artifacts: [], links: [], events: [ev("b1"), ev("b2")] }));
    expect(store.stats(b.id).sessions).toBe(1);
    store.deleteProject(a.id);
    expect(store.timeline(b.id).map((e) => e.sourceEventId)).toEqual(["b1", "b2"]);
    expect(store.gaps(b.id)).toHaveLength(1);
    store.deleteProject(b.id); // and the session goes with its last project
    expect(store.db.prepare("SELECT COUNT(*) n FROM session").get()).toEqual({ n: 0 });
  });
});
