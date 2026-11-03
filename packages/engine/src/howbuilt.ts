import path from "node:path";
import { effectiveTest, toPosix, type StoredEvent, type Store } from "@dena/core";
import { activityForEvents, DEFAULT_KINDS, type ActivityEntry } from "./activity.ts";
import { episodeEvents } from "./episodes.ts";

/**
 * "How the AI built this": the process behind a step or a page, told from captured events. Nothing
 * here is written by a model. A step gets its episode's plain-language log; a page gets the
 * requests, commits and AI notes for what it covers (one component, or the whole project), with
 * counts of the work in between.
 */

export interface HowBuilt {
  /** What the counts cover, in words ("this step", "files under src/", "the whole project"). */
  scope: string;
  stats: { sessions: number; prompts: number; aiEdits: number; commands: number; tests: number; testFailures: number; commits: number; notes: number };
  entries: ActivityEntry[];
  /** Entries left out to keep the list readable. */
  more: number;
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const MAX_ENTRIES = 40;

export function howBuiltStep(store: Store, projectId: string, unitId: string): HowBuilt {
  const events = episodeEvents(store, projectId, unitId);
  const log = activityForEvents(store, projectId, events, unitId);
  const entries = log.entries.filter((x) => DEFAULT_KINDS.includes(x.kind));
  return {
    scope: "this step",
    stats: { sessions: new Set(events.map((e) => e.sessionId).filter(Boolean)).size, prompts: log.stats.prompts, aiEdits: log.stats.edits, commands: log.stats.commands,
      tests: log.stats.tests, testFailures: log.stats.testFailures, commits: log.stats.commits, notes: log.stats.notes },
    entries: entries.slice(0, MAX_ENTRIES),
    more: Math.max(0, entries.length - MAX_ENTRIES),
  };
}

/** For a wiki page: `component:<folder>` covers files under that folder; other pages cover the project. */
export function howBuiltPage(store: Store, projectId: string, key: string): HowBuilt {
  const root = store.getProject(projectId)!.rootPath;
  const folder = key.startsWith("component:") ? key.slice("component:".length) : null;
  const inScope = (file: string) => {
    const rel = toPosix(path.isAbsolute(file) ? path.relative(root, file) : file);
    if (rel.startsWith("..")) return false;
    return !folder || (folder === "(project root)" ? !rel.includes("/") : rel.startsWith(`${folder}/`));
  };
  const all = store.timeline(projectId);
  const stats = { sessions: 0, prompts: 0, aiEdits: 0, commands: 0, tests: 0, testFailures: 0, commits: 0, notes: 0 };
  const sessions = new Set<string>();
  const picked: StoredEvent[] = [];
  const firstPromptOf = new Map<string, StoredEvent>(); // the request that started each session's work here
  const lastPrompt = new Map<string, StoredEvent>();
  for (const e of all) {
    const p = e.payload as Record<string, any>;
    if (e.eventType === "prompt_submitted" && e.actor === "user" && e.sessionId) lastPrompt.set(e.sessionId, e);
    if (e.eventType === "tool_invoked" && EDIT_TOOLS.has(String(p.tool))) {
      const f = String(p.input?.file_path ?? p.input?.notebook_path ?? "");
      if (!f || !inScope(f)) continue;
      stats.aiEdits++;
      if (e.sessionId) {
        sessions.add(e.sessionId);
        const pr = lastPrompt.get(e.sessionId);
        if (pr && !firstPromptOf.has(e.sessionId)) firstPromptOf.set(e.sessionId, pr);
      }
    } else if (e.eventType === "git_commit") {
      if (!(p.files ?? []).some((f: any) => inScope(String(f.path)))) continue;
      stats.commits++;
      picked.push(e);
    } else if (e.eventType === "agent_note") {
      if (folder && !String(p.text ?? "").includes(folder)) continue;
      stats.notes++;
      picked.push(e);
    } else if (!folder && e.eventType === "test_result") {
      stats.tests++;
      if (effectiveTest(e).outcome === "failed") stats.testFailures++; // read with today's rules, like everywhere else
    } else if (!folder && e.eventType === "command_executed") stats.commands++;
  }
  if (!folder) {
    // The whole project: every session, and each one's opening request.
    for (const e of all) if (e.sessionId && e.source.startsWith("claude_code")) sessions.add(e.sessionId);
    for (const e of all) if (e.eventType === "prompt_submitted" && e.actor === "user" && e.sessionId && !firstPromptOf.has(e.sessionId)) firstPromptOf.set(e.sessionId, e);
    stats.prompts = all.filter((e) => e.eventType === "prompt_submitted" && e.actor === "user").length;
  } else stats.prompts = firstPromptOf.size;
  stats.sessions = sessions.size;
  picked.push(...firstPromptOf.values());
  const log = activityForEvents(store, projectId, picked.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id - b.id), key);
  let entries = log.entries.filter((x) => x.kind === "prompt" || x.kind === "commit" || x.kind === "note");
  const total = entries.length;
  if (total > MAX_ENTRIES) entries = Array.from({ length: MAX_ENTRIES }, (_, i) => entries[Math.round((i * (total - 1)) / (MAX_ENTRIES - 1))]!); // spread across the whole period
  return { scope: folder ? `files under ${folder}/` : "the whole project", stats, entries, more: total - entries.length };
}
