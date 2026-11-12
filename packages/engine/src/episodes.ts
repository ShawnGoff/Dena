import { createHash } from "node:crypto";
import { effectiveTest, type StoredEvent, type Store } from "@dena/core";

/**
 * L1 episodes: deterministic grouping of events into units of work worth explaining.
 *
 * 1. Prompt groups. Each human prompt starts a group. Activity from the same Claude Code
 *    session joins the latest prompt before it. Activity from other sources (watcher, git,
 *    hooks) joins the latest group if it happens within ATTACH_WINDOW of that group's last
 *    event; otherwise it forms a group of its own ("activity without a prompt").
 * 2. Episodes. Consecutive groups merge until a boundary: the previous group made a commit,
 *    the pause between groups exceeds IDLE_BREAK, or the episode reached MAX_PROMPTS.
 *    Groups with no changes (questions, discussion) never close an episode on their own.
 * No model is involved; the same events always give the same episodes.
 */

const ATTACH_WINDOW_MS = 10 * 60_000;
const IDLE_BREAK_MS = 45 * 60_000;
const MAX_PROMPTS = 6;
const CHANGE_TYPES = new Set(["file_created", "file_modified", "file_deleted", "git_commit"]);

export interface Episode {
  id: string;
  position: number;
  title: string;
  startedAt: string;
  endedAt: string;
  eventIds: number[];
  stats: { prompts: number; fileChanges: number; commits: number; tests: number; testFailures: number; notes: number; commands: number };
}

interface Group {
  prompt: StoredEvent | null;
  events: StoredEvent[];
  last: number;
  session: string | null;
}

const t = (e: StoredEvent) => Date.parse(e.occurredAt);
const isHumanPrompt = (e: StoredEvent) => e.eventType === "prompt_submitted" && e.actor === "user";

export function buildEpisodes(events: StoredEvent[]): Episode[] {
  const groups: Group[] = [];
  const latestBySession = new Map<string, Group>();
  let latest: Group | null = null;

  for (const e of events) {
    if (isHumanPrompt(e)) {
      const g: Group = { prompt: e, events: [e], last: t(e), session: e.sessionId };
      groups.push(g);
      if (e.sessionId) latestBySession.set(e.sessionId, g);
      latest = g;
      continue;
    }
    const sameSession = e.sessionId ? latestBySession.get(e.sessionId) : undefined;
    let target: Group | undefined = sameSession;
    if (!target && latest && t(e) - latest.last <= ATTACH_WINDOW_MS) target = latest;
    if (!target) {
      target = { prompt: null, events: [], last: t(e), session: e.sessionId };
      groups.push(target);
      latest = target;
    }
    target.events.push(e);
    target.last = Math.max(target.last, t(e));
  }

  // Groups are created in prompt order; keep them in time order of their first event.
  groups.sort((a, b) => t(a.events[0]!) - t(b.events[0]!));

  const episodes: Group[][] = [];
  let current: Group[] = [];
  let prevEnd = 0;
  for (const g of groups) {
    const prev = current[current.length - 1];
    const prompts = current.filter((x) => x.prompt).length;
    const boundary =
      prev &&
      (prev.events.some((e) => e.eventType === "git_commit") ||
        t(g.events[0]!) - prevEnd > IDLE_BREAK_MS ||
        (prompts >= MAX_PROMPTS && g.events.some((e) => CHANGE_TYPES.has(e.eventType))));
    if (boundary) {
      episodes.push(current);
      current = [];
    }
    current.push(g);
    prevEnd = Math.max(prevEnd, g.last);
  }
  if (current.length) episodes.push(current);

  return episodes.map((gs, i) => {
    const evs = gs.flatMap((g) => g.events).sort((a, b) => t(a) - t(b) || a.id - b.id);
    const firstPrompt = gs.find((g) => g.prompt)?.prompt;
    const stat = (f: (e: StoredEvent) => boolean) => evs.filter(f).length;
    return {
      id: `ep_${createHash("sha256").update(evs[0]!.source + "\n" + evs[0]!.sourceEventId).digest("hex").slice(0, 12)}`,
      position: i + 1,
      title: firstPrompt ? firstPrompt.summary : `Activity without a prompt: ${evs[0]!.summary}`,
      startedAt: evs[0]!.occurredAt,
      endedAt: evs[evs.length - 1]!.occurredAt,
      eventIds: evs.map((e) => e.id),
      stats: {
        prompts: gs.filter((g) => g.prompt).length,
        fileChanges: stat((e) => e.eventType.startsWith("file_")),
        commits: stat((e) => e.eventType === "git_commit"),
        tests: stat((e) => e.eventType === "test_result"),
        testFailures: stat((e) => e.eventType === "test_result" && effectiveTest(e).outcome === "failed"),
        notes: stat((e) => e.eventType === "agent_note"),
        commands: stat((e) => e.eventType === "command_executed"),
      },
    };
  });
}

/** Rebuilds a project's episodes in place. Explanations keep their own copy of what they cited. */
export function rebuildEpisodes(store: Store, projectId: string): Episode[] {
  const events = store.timeline(projectId);
  const episodes = buildEpisodes(events);
  const insUnit = store.db.prepare(
    "INSERT INTO work_unit (id, project_id, position, title, started_at, ended_at, stats_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insEv = store.db.prepare("INSERT OR IGNORE INTO work_unit_event (project_id, unit_id, event_id) VALUES (?, ?, ?)");
  store.db.transaction(() => {
    store.db.prepare("DELETE FROM work_unit WHERE project_id = ?").run(projectId);
    for (const ep of episodes) {
      insUnit.run(ep.id, projectId, ep.position, ep.title, ep.startedAt, ep.endedAt, JSON.stringify(ep.stats));
      for (const id of ep.eventIds) insEv.run(projectId, ep.id, id);
    }
    store.setCursor(projectId, "episodes", "last_event_id", String(events.reduce((m, e) => Math.max(m, e.id), 0)));
  })();
  return episodes;
}

/**
 * The project's episodes, rebuilt first when events arrived since they were last built, so every
 * reader (the Guide, updates, wiki pages, the command line) sees new work as soon as it is captured.
 */
export function loadEpisodes(store: Store, projectId: string): Omit<Episode, "eventIds">[] {
  const newest = (store.db.prepare("SELECT MAX(id) n FROM event WHERE project_id = ?").get(projectId) as { n: number | null }).n ?? 0;
  if (newest > Number(store.getCursor(projectId, "episodes", "last_event_id") ?? 0)) rebuildEpisodes(store, projectId);
  return (store.db.prepare("SELECT * FROM work_unit WHERE project_id = ? ORDER BY position").all(projectId) as any[]).map((r) => ({
    id: r.id, position: r.position, title: r.title, startedAt: r.started_at, endedAt: r.ended_at, stats: JSON.parse(r.stats_json),
  }));
}

export function episodeEvents(store: Store, projectId: string, unitId: string): StoredEvent[] {
  const ids = (store.db.prepare("SELECT event_id FROM work_unit_event WHERE project_id = ? AND unit_id = ?").all(projectId, unitId) as { event_id: number }[]).map(
    (r) => r.event_id,
  );
  // Only this episode's rows, in timeline order. Loading the whole project for every episode made
  // lists of steps slow down with the square of the project's size.
  const out: StoredEvent[] = [];
  for (let i = 0; i < ids.length; i += 5_000) out.push(...store.eventsById(projectId, ids.slice(i, i + 5_000)));
  return out.sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.id - b.id));
}

export interface Chapter {
  key: string;
  /** The parts of the project the chapter's episodes changed, busiest first (folders, two levels deep). */
  areas: string[];
  startedAt: string;
}

/**
 * Chapters for the walkthrough: one per Claude Code session (a sitting of work), so the list reads
 * as a table of contents rather than a run of prompts. Episodes outside any session join the one
 * before them. Each chapter names the folders its work touched.
 */
export function episodeChapters(store: Store, projectId: string, eps: Omit<Episode, "eventIds">[]): Map<string, Chapter> {
  const root = store.getProject(projectId)!.rootPath;
  const area = (file: string) => {
    const rel = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
    if (rel.startsWith("/") || rel.startsWith("..")) return null;
    const parts = rel.split("/");
    return parts.length >= 3 ? parts.slice(0, 2).join("/") : parts.length === 2 ? parts[0]! : "(project root)";
  };
  const out = new Map<string, Chapter>();
  let current: Chapter | null = null;
  let currentSession: string | null = null;
  const counts = new Map<Chapter, Map<string, number>>();
  for (const ep of eps) {
    const events = episodeEvents(store, projectId, ep.id);
    const session = events.find((e) => e.sessionId && e.source.startsWith("claude_code"))?.sessionId ?? null;
    if (!current || (session && session !== currentSession)) {
      current = { key: session ?? ep.id, areas: [], startedAt: ep.startedAt };
      currentSession = session;
      counts.set(current, new Map());
    }
    const c = counts.get(current)!;
    for (const e of events) {
      const p = e.payload as Record<string, any>;
      const f = e.eventType.startsWith("file_") ? p.file : e.eventType === "tool_invoked" && ["Edit", "MultiEdit", "Write"].includes(p.tool) ? p.input?.file_path : null;
      const a = f ? area(String(f)) : null;
      if (a) c.set(a, (c.get(a) ?? 0) + 1);
    }
    out.set(ep.id, current);
  }
  for (const [ch, c] of counts) ch.areas = [...c.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a);
  return out;
}
