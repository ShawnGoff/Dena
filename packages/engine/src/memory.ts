import { createHash } from "node:crypto";
import { effectiveTest, TEST_RULES_VERSION, type StoredEvent, type Store } from "@dena/core";
import { loadEpisodes, rebuildEpisodes } from "./episodes.ts";
import { isStandingLimitationText } from "./packet.ts";
import { Step, type Claim } from "./schema.ts";

/**
 * L2 project memory: what the project is made of and what happened to it, distilled from
 * captured events (components, problems and fixes) and from explanations already written
 * (decisions, concepts, open questions). No model is called here.
 *
 * Everything is derived and rebuilt in place. Each entity lists the episodes and events it
 * rests on, and says how it knows: "observed" facts are counted from events; links such as
 * "these changes fixed that failure" are labeled inferred; statements taken from explanations
 * keep the claim kind they were written with.
 */

export type MemoryKind = "component" | "problem" | "decision" | "concept" | "question";

export interface MemorySource {
  unitId: string | null;
  eventId: number | null;
  basis: string;
}

export interface MemoryEntity {
  id: string;
  kind: MemoryKind;
  title: string;
  data: Record<string, unknown>;
  sortKey: number;
  sources: MemorySource[];
}

const t = (iso: string) => Date.parse(iso);
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const idFor = (kind: MemoryKind, key: string) => `${kind}_${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
const FILE_TYPES = new Set(["file_created", "file_modified", "file_deleted"]);

/** Groups a file into a component: its folder, two levels deep ("src/views/Guide.tsx" → "src/views"). */
export function componentOf(file: string): string {
  const parts = file.split("/").filter(Boolean);
  if (parts.length <= 1) return "(project root)";
  return parts.slice(0, Math.min(2, parts.length - 1)).join("/");
}

/** Test names a runner reported as failing, from its output (TAP, Jest/Vitest, pytest). */
export function failingTests(output: string): string[] {
  const names = new Set<string>();
  for (const m of output.matchAll(/^not ok \d+ - (.+)$/gm)) names.add(m[1]!.trim());
  for (const m of output.matchAll(/^\s*(?:FAIL|✗|×|✕)\s+(.+?)\s*$/gm)) if (!/^\d+ (tests?|failed)/i.test(m[1]!)) names.add(m[1]!.trim());
  for (const m of output.matchAll(/^FAILED (\S+)/gm)) names.add(m[1]!);
  return [...names].slice(0, 8);
}

interface Ctx {
  events: StoredEvent[];
  unitOf: Map<number, string>;
  position: Map<string, number>;
}

function components(ctx: Ctx): MemoryEntity[] {
  const byKey = new Map<string, { files: Map<string, { changes: number; last: string }>; changes: number; commits: Set<string>; added: number; removed: number;
    ai: number; unknown: number; units: Set<string>; first: string; last: string; eventIds: number[] }>();
  const touch = (file: string, e: StoredEvent) => {
    const key = componentOf(file);
    let c = byKey.get(key);
    if (!c) {
      c = { files: new Map(), changes: 0, commits: new Set(), added: 0, removed: 0, ai: 0, unknown: 0, units: new Set(), first: e.occurredAt, last: e.occurredAt, eventIds: [] };
      byKey.set(key, c);
    }
    const f = c.files.get(file) ?? { changes: 0, last: e.occurredAt };
    f.changes++;
    f.last = e.occurredAt > f.last ? e.occurredAt : f.last;
    c.files.set(file, f);
    if (e.occurredAt < c.first) c.first = e.occurredAt;
    if (e.occurredAt > c.last) c.last = e.occurredAt;
    const u = ctx.unitOf.get(e.id);
    if (u) c.units.add(u);
    if (c.eventIds.length < 200) c.eventIds.push(e.id);
    return c;
  };
  for (const e of ctx.events) {
    const p = e.payload as Record<string, any>;
    if (FILE_TYPES.has(e.eventType) && typeof p.file === "string" && !p.outsideRoot) {
      const c = touch(p.file, e);
      c.changes++;
      c.added += Number(p.linesAdded ?? 0) || 0;
      c.removed += Number(p.linesRemoved ?? 0) || 0;
      if (e.actor === "ai_agent") c.ai++;
      else c.unknown++;
    }
    if (e.eventType === "git_commit")
      for (const f of (p.files ?? []) as { path: string; added: number | null; removed: number | null }[]) {
        const c = touch(f.path, e);
        c.commits.add(String(p.sha));
        c.added += f.added ?? 0;
        c.removed += f.removed ?? 0;
      }
  }
  return [...byKey.entries()].map(([key, c]) => {
    const files = [...c.files.entries()].sort((a, b) => b[1].changes - a[1].changes);
    return {
      id: idFor("component", key), kind: "component" as const, title: key,
      sortKey: c.changes + c.commits.size * 2,
      data: {
        files: files.slice(0, 25).map(([path, f]) => ({ path, changes: f.changes, lastChanged: f.last })),
        fileCount: files.length, fileChanges: c.changes, commits: c.commits.size, linesAdded: c.added, linesRemoved: c.removed,
        changesByAi: c.ai, changesByUnknown: c.unknown, firstChanged: c.first, lastChanged: c.last,
        episodes: [...c.units].sort((a, b) => (ctx.position.get(a) ?? 0) - (ctx.position.get(b) ?? 0)),
        basis: "counted from captured file changes and commits (observed)",
      },
      sources: [...c.units].slice(0, 60).map((u) => ({ unitId: u, eventId: null, basis: "files in this component changed in this episode" })),
    };
  });
}

function problems(ctx: Ctx): MemoryEntity[] {
  const out: MemoryEntity[] = [];
  const tests = ctx.events.filter((e) => e.eventType === "test_result" && ["failed", "passed"].includes(effectiveTest(e).outcome ?? ""));
  let open: StoredEvent[] = [];
  const close = (fix: StoredEvent | null) => {
    if (!open.length) return;
    const first = open[0]!;
    const end = fix ? t(fix.occurredAt) : Infinity;
    const inWindow = (e: StoredEvent) => t(e.occurredAt) >= t(first.occurredAt) && t(e.occurredAt) <= end;
    const output = open.map((e) => [(e.payload as any).stdout, (e.payload as any).stderr].filter(Boolean).join("\n")).join("\n");
    const names = failingTests(output);
    const changes = ctx.events.filter((e) => inWindow(e) && FILE_TYPES.has(e.eventType) && !(e.payload as any).outsideRoot);
    const commits = ctx.events.filter((e) => inWindow(e) && e.eventType === "git_commit");
    // Agents often commit just after the passing run; that commit shows what the fix changed.
    const fixUnit = fix ? ctx.unitOf.get(fix.id) : undefined;
    const followUp = fix && !commits.length
      ? ctx.events.find((e) => e.eventType === "git_commit" && t(e.occurredAt) >= end && ctx.unitOf.get(e.id) === fixUnit)
      : undefined;
    const causes = ctx.events.filter((e) => e.eventType === "agent_note" && ["cause", "decision"].includes((e.payload as any).kind)
      && t(e.occurredAt) >= t(first.occurredAt) - 5 * 60_000 && t(e.occurredAt) <= (fix ? end : t(first.occurredAt) + 60 * 60_000));
    const ft = effectiveTest(first);
    const units = [...new Set([...open, ...(fix ? [fix] : [])].map((e) => ctx.unitOf.get(e.id)).filter(Boolean))] as string[];
    out.push({
      id: idFor("problem", `${first.source}|${first.sourceEventId}`), kind: "problem",
      title: names[0] ? `Failing test: ${names[0]}` : `Tests failed (${ft.failed ?? "?"} of ${(ft.passed ?? 0) + (ft.failed ?? 0) || "?"})`,
      sortKey: t(first.occurredAt),
      data: {
        status: fix ? "fixed" : "open",
        failedRuns: open.length, firstFailedAt: first.occurredAt, fixedAt: fix?.occurredAt ?? null,
        failingTests: names, failedCount: ft.failed ?? null,
        fixCounts: fix ? { passed: effectiveTest(fix).passed, failed: effectiveTest(fix).failed ?? 0 } : null,
        outcomeBasis: ft.basis,
        filesChangedBetween: [...new Set(changes.map((e) => (e.payload as any).file as string))].slice(0, 12),
        commitsBetween: commits.map((e) => ({ sha: String((e.payload as any).sha).slice(0, 7), message: String((e.payload as any).message ?? "").split("\n")[0], eventId: e.id })),
        commitAfterFix: followUp ? { sha: String((followUp.payload as any).sha).slice(0, 7), message: String((followUp.payload as any).message ?? "").split("\n")[0],
          files: ((followUp.payload as any).files ?? []).map((f: any) => f.path).slice(0, 12), eventId: followUp.id,
          basis: "inferred: the next commit in the same episode after the tests passed" } : null,
        causeNotes: causes.map((e) => ({ kind: (e.payload as any).kind, text: (e.payload as any).text, eventId: e.id })),
        episodes: units,
        basis: fix
          ? "observed: the runs failed, then a later run passed. Inferred: that the changes in between fixed it."
          : "observed: the runs failed, and no later passing run was captured.",
      },
      sources: [
        ...open.map((e) => ({ unitId: ctx.unitOf.get(e.id) ?? null, eventId: e.id, basis: "failing test run" })),
        ...(fix ? [{ unitId: ctx.unitOf.get(fix.id) ?? null, eventId: fix.id, basis: "first later passing run" }] : []),
        ...(followUp ? [{ unitId: fixUnit ?? null, eventId: followUp.id, basis: "commit made after the tests passed (inferred link)" }] : []),
        ...causes.map((e) => ({ unitId: ctx.unitOf.get(e.id) ?? null, eventId: e.id, basis: "agent's note about the cause (agent-stated)" })),
      ],
    });
    open = [];
  };
  for (const e of tests) {
    if (effectiveTest(e).outcome === "failed") open.push(e);
    else close(e);
  }
  close(null);
  return out;
}

export interface LatestExplanation {
  unitId: string;
  step: Step;
  evidence: Record<string, { eventIds: number[] }>;
  model: string | null;
}

/**
 * Each explained step as the owner sees it: its active revision (which may be restored or hold
 * their edits), or the stored explanation for a step written before revision history existed.
 * An AI rewrite still waiting for review is not used.
 */
export function latestExplanations(store: Store, projectId: string): LatestExplanation[] {
  const active = store.db
    .prepare(`SELECT doc_key unit_id, content_json, meta_json FROM doc_revision WHERE project_id = ? AND doc_type = 'step' AND status = 'active'`)
    .all(projectId) as { unit_id: string; content_json: string; meta_json: string }[];
  const fromRevisions = new Set(active.map((r) => r.unit_id));
  const legacy = (store.db
    .prepare(`SELECT unit_id, content_json, evidence_json, model FROM explanation e
              WHERE project_id = ? AND id = (SELECT MAX(id) FROM explanation x WHERE x.project_id = e.project_id AND x.unit_id = e.unit_id)`)
    .all(projectId) as { unit_id: string; content_json: string; evidence_json: string; model: string | null }[]).filter((r) => !fromRevisions.has(r.unit_id));
  const rows = [
    ...active.map((r) => {
      const meta = JSON.parse(r.meta_json);
      return { unitId: r.unit_id, content: r.content_json, evidence: meta.evidence ?? {}, model: meta.model ?? null };
    }),
    ...legacy.map((r) => ({ unitId: r.unit_id, content: r.content_json, evidence: JSON.parse(r.evidence_json), model: r.model })),
  ];
  return rows.flatMap((r) => {
    const parsed = Step.safeParse(JSON.parse(r.content));
    return parsed.success ? [{ unitId: r.unitId, step: parsed.data, evidence: r.evidence, model: r.model }] : [];
  });
}

/** E-references mentioned in a sentence, mapped to the events they meant in their explanation. */
function refsIn(text: string, x: LatestExplanation): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const m of text.matchAll(/\bE(\d+)\b/g)) {
    const ids = x.evidence[`E${m[1]}`]?.eventIds;
    if (ids?.length) out[`E${m[1]}`] = ids.slice(0, 10);
  }
  return out;
}

function claimEvents(c: Claim, x: LatestExplanation): number[] {
  return c.evidence.flatMap((ref) => x.evidence[ref]?.eventIds ?? []).slice(0, 10);
}

function decisions(ctx: Ctx, explained: LatestExplanation[]): MemoryEntity[] {
  const byText = new Map<string, MemoryEntity>();
  const add = (text: string, kind: string, unitId: string | null, eventIds: number[], basis: string, when: string | null, refs: Record<string, number[]> = {}) => {
    const key = norm(text);
    if (!key) return;
    const existing = byText.get(key);
    if (existing) {
      existing.sources.push(...eventIds.map((id) => ({ unitId, eventId: id, basis })));
      return;
    }
    byText.set(key, {
      id: idFor("decision", key), kind: "decision", title: text.length > 140 ? `${text.slice(0, 139)}…` : text,
      sortKey: when ? t(when) : 0,
      data: { text, claimKind: kind, episode: unitId, at: when, refs },
      sources: eventIds.length ? eventIds.map((id) => ({ unitId, eventId: id, basis })) : [{ unitId, eventId: null, basis }],
    });
  };
  for (const e of ctx.events)
    if (e.eventType === "agent_note" && (e.payload as any).kind === "decision")
      add(String((e.payload as any).text), "agent_stated", ctx.unitOf.get(e.id) ?? null, [e.id], "the agent's own note (agent-stated)", e.occurredAt);
  for (const x of explained)
    for (const c of x.step.decisions) {
      const ids = claimEvents(c, x);
      const when = ids.length ? ctx.events.find((e) => e.id === ids[0])?.occurredAt ?? null : null;
      add(c.text, c.kind, x.unitId, ids, `from the explanation of this episode (${c.kind.replace("_", "-")})`, when, refsIn(c.text, x));
    }
  return [...byText.values()];
}

function concepts(explained: LatestExplanation[], position: Map<string, number>): MemoryEntity[] {
  const byTerm = new Map<string, { term: string; uses: { unitId: string; explanation: string }[] }>();
  for (const x of explained)
    for (const c of x.step.concepts) {
      const key = norm(c.term);
      if (!key) continue;
      const cur = byTerm.get(key) ?? { term: c.term, uses: [] };
      cur.uses.push({ unitId: x.unitId, explanation: c.explanation });
      byTerm.set(key, cur);
    }
  return [...byTerm.entries()].map(([key, c]) => {
    const uses = c.uses.sort((a, b) => (position.get(a.unitId) ?? 0) - (position.get(b.unitId) ?? 0));
    return {
      id: idFor("concept", key), kind: "concept" as const, title: c.term, sortKey: uses.length,
      data: { term: c.term, explanation: uses.reduce((best, u) => (u.explanation.length > best.length ? u.explanation : best), ""), episodes: uses.map((u) => u.unitId),
        basis: "general background from the explanations; not a claim about this project" },
      sources: uses.map((u) => ({ unitId: u.unitId, eventId: null, basis: "defined in this episode's explanation" })),
    };
  });
}

function questions(ctx: Ctx, explained: LatestExplanation[]): MemoryEntity[] {
  const seen = new Map<string, MemoryEntity>();
  const add = (text: string, from: string, unitId: string | null, eventId: number | null, when: string | null, refs: Record<string, number[]> = {}) => {
    const key = norm(text.replace(/\bE\d+\b/g, ""));
    if (!key) return;
    const cur = seen.get(key);
    if (cur) {
      cur.sources.push({ unitId, eventId, basis: from });
      (cur.data.episodes as string[]).push(...(unitId ? [unitId] : []));
      return;
    }
    seen.set(key, { id: idFor("question", key), kind: "question", title: text.length > 160 ? `${text.slice(0, 159)}…` : text, sortKey: when ? t(when) : 0,
      data: { text, from, episodes: unitId ? [unitId] : [], at: when, refs }, sources: [{ unitId, eventId, basis: from }] });
  };
  for (const e of ctx.events)
    if (e.eventType === "agent_note" && ["todo", "assumption"].includes((e.payload as any).kind))
      add(String((e.payload as any).text), `agent's ${(e.payload as any).kind} note`, ctx.unitOf.get(e.id) ?? null, e.id, e.occurredAt);
  for (const x of explained) {
    const firstEvent = Object.values(x.evidence).flatMap((v) => v.eventIds)[0];
    const when = firstEvent != null ? ctx.events.find((e) => e.id === firstEvent)?.occurredAt ?? null : null;
    for (const u of x.step.uncertainty)
      if (!isStandingLimitationText(u)) add(u, "uncertainty in the explanation", x.unitId, null, when, refsIn(u, x)); // stated once, in About this guide
  }
  return [...seen.values()];
}

export function buildMemory(store: Store, projectId: string): MemoryEntity[] {
  let eps = loadEpisodes(store, projectId);
  if (!eps.length) {
    rebuildEpisodes(store, projectId);
    eps = loadEpisodes(store, projectId);
  }
  const unitOf = new Map<number, string>(
    (store.db.prepare("SELECT event_id, unit_id FROM work_unit_event WHERE project_id = ?").all(projectId) as { event_id: number; unit_id: string }[])
      .map((r) => [r.event_id, r.unit_id]),
  );
  const ctx: Ctx = { events: store.timeline(projectId), unitOf, position: new Map(eps.map((e) => [e.id, e.position])) };
  const explained = latestExplanations(store, projectId);
  return [...components(ctx), ...problems(ctx), ...decisions(ctx, explained), ...concepts(explained, ctx.position), ...questions(ctx, explained)];
}

/** Bump when the builder's logic changes, so memory built by older code is rebuilt. */
export const MEMORY_VERSION = 4;

function fingerprint(store: Store, projectId: string): string {
  const e = store.db.prepare("SELECT MAX(id) m, COUNT(*) n FROM event WHERE project_id = ?").get(projectId) as { m: number | null; n: number };
  const x = store.db.prepare("SELECT MAX(id) m FROM explanation WHERE project_id = ?").get(projectId) as { m: number | null };
  const u = store.db.prepare("SELECT COUNT(*) n FROM work_unit WHERE project_id = ?").get(projectId) as { n: number };
  // Restores and edits change what a step says without a new explanation.
  const r = store.db.prepare("SELECT MAX(id) m FROM doc_revision WHERE project_id = ? AND doc_type = 'step' AND status = 'active'").get(projectId) as { m: number | null };
  return `v${MEMORY_VERSION}.${TEST_RULES_VERSION}:${e.m ?? 0}:${e.n}:${x.m ?? 0}:${u.n}:${r.m ?? 0}`;
}

/** Rebuilds memory if events, explanations or episodes changed since the last build. */
export function ensureMemory(store: Store, projectId: string, opts: { force?: boolean } = {}): boolean {
  const fp = fingerprint(store, projectId);
  if (!opts.force && store.getCursor(projectId, "memory", "fingerprint") === fp) return false;
  const entities = buildMemory(store, projectId);
  const insE = store.db.prepare("INSERT OR REPLACE INTO memory_entity (project_id, id, kind, title, data_json, sort_key) VALUES (?, ?, ?, ?, ?, ?)");
  const insS = store.db.prepare("INSERT INTO memory_source (project_id, entity_id, unit_id, event_id, basis) VALUES (?, ?, ?, ?, ?)");
  store.db.transaction(() => {
    store.db.prepare("DELETE FROM memory_entity WHERE project_id = ?").run(projectId);
    for (const m of entities) {
      insE.run(projectId, m.id, m.kind, m.title, JSON.stringify(m.data), m.sortKey);
      for (const s of m.sources) insS.run(projectId, m.id, s.unitId, s.eventId, s.basis);
    }
  })();
  store.setCursor(projectId, "memory", "fingerprint", fingerprint(store, projectId));
  return true;
}

export function loadMemory(store: Store, projectId: string, kind?: MemoryKind): MemoryEntity[] {
  const rows = store.db
    .prepare(`SELECT * FROM memory_entity WHERE project_id = ? ${kind ? "AND kind = ?" : ""} ORDER BY kind, sort_key DESC`)
    .all(...(kind ? [projectId, kind] : [projectId])) as any[];
  const sources = store.db.prepare("SELECT unit_id, event_id, basis FROM memory_source WHERE project_id = ? AND entity_id = ?");
  return rows.map((r) => ({
    id: r.id, kind: r.kind, title: r.title, data: JSON.parse(r.data_json), sortKey: r.sort_key,
    sources: (sources.all(projectId, r.id) as any[]).map((s) => ({ unitId: s.unit_id, eventId: s.event_id, basis: s.basis })),
  }));
}
