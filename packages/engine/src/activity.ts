import { effectiveTest, likelyAuthors, type LikelyAuthor, type StoredEvent, type Store } from "@dena/core";

/**
 * The AI activity log: what the AI did, in order and in plain language, built only from captured
 * events (no model call). Each line keeps the event ids behind it so it can be checked, and runs
 * of similar small actions ("read 4 files") are folded into one line.
 */

export type ActivityKind =
  | "prompt" | "reply" | "edit" | "command" | "test" | "commit" | "note" | "read" | "search" | "browser"
  | "question" | "housekeeping" | "error" | "file" | "branch" | "session";

/** Shown unless the reader asks for everything: the AI's replies and its own bookkeeping are hidden. */
export const DEFAULT_KINDS: ActivityKind[] = ["prompt", "edit", "command", "test", "commit", "note", "read", "search", "browser", "question", "error", "file", "branch", "session"];

export interface ActivityEntry {
  at: string;
  kind: ActivityKind;
  /** "you", "ai", "subagent", "tool" — or "unknown" for changes no source attributed. */
  who: "you" | "ai" | "subagent" | "tool" | "unknown";
  text: string;
  /** Extra plain-language detail (exit code, duration, test counts, files). */
  detail?: string;
  /** "failed" / "passed" / "stopped" outcomes the reader should notice. */
  status?: "ok" | "failed" | "unknown";
  count: number;
  eventIds: number[];
  likelyAuthor?: LikelyAuthor | null;
}

export interface ActivitySession {
  id: string;
  startedAt: string;
  endedAt: string;
  stats: { prompts: number; edits: number; commands: number; tests: number; testFailures: number; commits: number; notes: number; fileChanges: number };
  entries: ActivityEntry[];
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const base = (p: string) => p.split("/").pop() ?? p;
const secs = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : ms >= 1_000 ? `${(ms / 1_000).toFixed(1)} s` : `${ms} ms`);

interface Ctx {
  byId: Map<number, StoredEvent>;
  linksIn: Map<number, { from: number; type: string }[]>;
  linksOut: Map<number, { to: number; type: string }[]>;
  likely: Map<number, LikelyAuthor>;
}

/** The result, file change, hook outcome or commit a tool call led to. */
function related(ctx: Ctx, callId: number) {
  const inc = (ctx.linksIn.get(callId) ?? []).map((l) => ({ ...l, e: ctx.byId.get(l.from) })).filter((x) => x.e);
  const result = inc.find((x) => x.type === "result_of" && x.e!.source === "claude_code.transcript")?.e;
  const hook = inc.find((x) => x.type === "result_of" && x.e!.source === "claude_code.hooks")?.e;
  const file = inc.find((x) => x.type === "modified_file")?.e;
  const commit = (ctx.linksOut.get(callId) ?? []).map((l) => (l.type === "created_commit" ? ctx.byId.get(l.to) : undefined)).find(Boolean);
  return { result, hook, file, commit };
}

function toolEntry(ctx: Ctx, e: StoredEvent, who: ActivityEntry["who"]): ActivityEntry | null {
  const p = e.payload as Record<string, any>;
  const tool = String(p.tool ?? "");
  const input = (p.input ?? {}) as Record<string, any>;
  const { result, hook, file, commit } = related(ctx, e.id);
  const ids = [e.id, ...[result, hook, file, commit].filter(Boolean).map((x) => x!.id)];
  const hp = (hook?.payload ?? {}) as Record<string, any>;
  const failed = result?.eventType === "error_detected" || hook?.eventType === "error_detected" || (result?.payload as any)?.status === "error";
  const timing = hp.durationMs != null ? secs(hp.durationMs) : undefined;
  const mk = (kind: ActivityKind, text: string, extra: Partial<ActivityEntry> = {}): ActivityEntry =>
    ({ at: e.occurredAt, kind, who, text, count: 1, eventIds: ids, status: failed ? "failed" : "ok", ...extra });

  if (tool === "Bash" || tool === "bash") {
    const cmd = String(input.command ?? "");
    if (cmd.includes("dena-hook.mjs note")) return null; // the note itself is logged from its own event
    const label = input.description ? String(input.description) : clip(cmd.split("\n")[0] ?? cmd, 90);
    // One command can edit files, run tests and commit; the line keeps the AI's own description and
    // lists what the command did as details, rather than renaming the whole line after one of them.
    const details: string[] = [];
    let status: ActivityEntry["status"] = failed ? "failed" : "ok";
    if (result?.eventType === "test_result") {
      const t = effectiveTest(result);
      details.push(`tests: ${t.passed != null || t.failed ? `${t.passed ?? "?"} passed, ${t.failed ?? 0} failed` : t.outcome === "unknown" ? "outcome not captured" : t.outcome}`);
      status = t.outcome === "failed" ? "failed" : t.outcome === "passed" ? (failed ? "failed" : "ok") : "unknown";
    }
    if (commit) {
      const cp = commit.payload as Record<string, any>;
      details.push(`committed ${String(cp.sha).slice(0, 7)} “${clip(String(cp.message ?? "").split("\n")[0] ?? "", 60)}”`);
    }
    if (failed && result?.eventType !== "test_result") details.push(hp.exitCode != null ? `exit code ${hp.exitCode}` : "failed");
    if (timing) details.push(timing);
    const kind: ActivityKind = commit ? "commit" : result?.eventType === "test_result" ? "test" : "command";
    return mk(kind, `Ran: ${label}`, { detail: details.join(" · ") || undefined, status });
  }
  if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(tool)) {
    const fp = (file?.payload ?? {}) as Record<string, any>;
    const path = String(fp.file ?? input.file_path ?? input.notebook_path ?? "a file");
    const lines = fp.linesAdded || fp.linesRemoved ? ` (+${fp.linesAdded ?? 0} −${fp.linesRemoved ?? 0})` : ""; // a new file has no diff to count
    const verb = failed ? `Tried to ${tool === "Write" ? "write" : "edit"}` : file?.eventType === "file_created" ? "Created" : tool === "Write" ? "Rewrote" : "Edited";
    return mk("edit", `${verb} ${path}${lines}`, { detail: failed ? "the edit failed" : fp.userModifiedProposal ? "you adjusted the proposed change" : undefined });
  }
  if (tool === "Read") return mk("read", `Read ${base(String(input.file_path ?? "a file"))}`);
  if (tool === "Glob" || tool === "Grep") return mk("read", `Searched the code for “${clip(String(input.pattern ?? input.query ?? ""), 50)}”`);
  if (tool === "WebSearch") return mk("search", `Searched the web: “${clip(String(input.query ?? ""), 80)}”`);
  if (tool === "WebFetch") return mk("search", `Read a web page: ${clip(String(input.url ?? ""), 80)}`);
  if (tool === "AskUserQuestion") return mk("question", "Asked you a question");
  if (tool.startsWith("mcp__Claude_Browser__") || tool.startsWith("mcp__claude-in-chrome__")) return mk("browser", "Used the browser");
  if (tool.startsWith("mcp__computer-use__")) return mk("browser", "Used an app on your computer");
  if (tool.startsWith("mcp__terminal__")) return mk("command", tool.includes("run_in_terminal") ? `Started in the terminal panel: ${clip(String(input.command ?? ""), 80)}` : "Used the terminal panel");
  if (/^mcp__ccd_|^ToolSearch$|^Skill$|^TodoWrite$|^Task(Create|Update)/.test(tool)) return mk("housekeeping", "Kept its notes and tools in order", { status: undefined });
  if (tool === "Task" || tool === "Agent") return mk("command", `Started a helper agent: ${clip(String(input.description ?? input.prompt ?? ""), 80)}`);
  const server = tool.startsWith("mcp__") ? tool.split("__")[1] : null;
  return mk("command", server ? `Used ${server}: ${tool.split("__").slice(2).join(" ")}` : `Used ${tool || "a tool"}`);
}

/** Keys under which consecutive entries are folded into one line. */
const foldKey = (x: ActivityEntry) =>
  x.kind === "read" || x.kind === "browser" || x.kind === "housekeeping" || x.kind === "search" ? `${x.kind}|${x.who}` : null;

function fold(entries: ActivityEntry[]): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  for (const x of entries) {
    const prev = out[out.length - 1];
    const k = foldKey(x);
    if (prev && k && foldKey(prev) === k) {
      prev.count++;
      prev.eventIds.push(...x.eventIds);
      if (x.kind === "read") {
        const names = new Set([...(prev.detail ? prev.detail.split(", ") : [prev.text.replace(/^Read |^Searched the code for /, "")]), x.text.replace(/^Read |^Searched the code for /, "")]);
        prev.text = `Read and searched the code (${prev.count} times)`;
        prev.detail = [...names].slice(0, 6).join(", ") + (names.size > 6 ? ", …" : "");
      } else if (x.kind === "browser") prev.text = `Used the browser (${prev.count} actions)`;
      else if (x.kind === "housekeeping") prev.text = `Kept its notes and tools in order (${prev.count} times)`;
      else if (x.kind === "search") prev.text = `Looked things up on the web (${prev.count} times)`;
      continue;
    }
    out.push({ ...x, eventIds: [...x.eventIds] });
  }
  return out;
}

const NEAR_MS = 30 * 60_000;

export function buildActivityLog(store: Store, projectId: string, opts: { sessionId?: string } = {}): ActivitySession[] {
  const events = store.timeline(projectId);
  const byId = new Map(events.map((e) => [e.id, e]));
  const linksIn = new Map<number, { from: number; type: string }[]>();
  const linksOut = new Map<number, { to: number; type: string }[]>();
  for (const r of store.db.prepare(`SELECT l.from_event_id f, l.to_event_id t, l.link_type k FROM event_link l JOIN event e ON e.id = l.from_event_id WHERE e.project_id = ?`)
    .all(projectId) as { f: number; t: number; k: string }[]) {
    linksIn.set(r.t, [...(linksIn.get(r.t) ?? []), { from: r.f, type: r.k }]);
    linksOut.set(r.f, [...(linksOut.get(r.f) ?? []), { to: r.t, type: r.k }]);
  }
  const ctx: Ctx = { byId, linksIn, linksOut, likely: likelyAuthors(store, projectId) };

  // Claude sessions; watcher and git events join the session with a captured event nearest to them
  // (within NEAR_MS). A resumed session can span days, so its overall span would claim unrelated changes.
  const sessionsById = new Map<string, { events: StoredEvent[] }>();
  for (const e of events) {
    if (!e.sessionId || !e.source.startsWith("claude_code")) continue;
    const s = sessionsById.get(e.sessionId) ?? { events: [] };
    s.events.push(e);
    sessionsById.set(e.sessionId, s);
  }
  const sessionTimes = [...sessionsById.values()].map((s) => ({ s, ms: s.events.map((x) => Date.parse(x.occurredAt)).sort((a, b) => a - b) }));
  const distance = (ms: number[], t: number) => {
    let lo = 0, hi = ms.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ms[mid]! < t) lo = mid + 1; else hi = mid; }
    return Math.min(Math.abs(ms[lo]! - t), lo > 0 ? t - ms[lo - 1]! : Infinity);
  };
  const other: StoredEvent[] = [];
  for (const e of events) {
    if (e.sessionId && e.source.startsWith("claude_code")) continue;
    if (!["file_created", "file_modified", "file_deleted", "git_commit", "branch_changed"].includes(e.eventType)) continue;
    const t = Date.parse(e.occurredAt);
    let home: { events: StoredEvent[] } | null = null, best = NEAR_MS;
    for (const c of sessionTimes) { const d = distance(c.ms, t); if (d <= best) { best = d; home = c.s; } }
    (home ? home.events : other).push(e);
  }

  const accounted = new Set<number>(); // events already shown as part of a tool call's line
  const build = (id: string, evs: StoredEvent[]): ActivitySession => {
    evs.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id - b.id);
    const entries: ActivityEntry[] = [];
    for (const e of evs) {
      if (accounted.has(e.id)) continue;
      const p = e.payload as Record<string, any>;
      const who: ActivityEntry["who"] = e.actor === "user" ? "you" : p.sidechain ? "subagent" : e.actor === "ai_agent" ? "ai" : e.actor === "automated_tool" ? "tool" : "unknown";
      let entry: ActivityEntry | null = null;
      switch (e.eventType) {
        case "prompt_submitted":
          entry = { at: e.occurredAt, kind: "prompt", who: e.actor === "user" ? "you" : "subagent", text: e.actor === "user" ? `You asked: “${clip(String(p.text ?? e.summary), 160)}”` : `The AI asked a helper agent: “${clip(String(p.text ?? ""), 120)}”`, count: 1, eventIds: [e.id] };
          break;
        case "ai_response_received":
          entry = { at: e.occurredAt, kind: "reply", who, text: `Replied: “${clip(String(p.text ?? e.summary), 160)}”`, count: 1, eventIds: [e.id] };
          break;
        case "tool_invoked": {
          entry = toolEntry(ctx, e, who);
          const r = related(ctx, e.id);
          [r.result, r.hook, r.file, r.commit].forEach((x) => x && accounted.add(x.id));
          break;
        }
        case "agent_note":
          entry = { at: e.occurredAt, kind: "note", who, text: `Noted (${p.kind}): ${clip(String(p.text ?? ""), 200)}`, detail: "the AI's own account of its reasoning", count: 1, eventIds: [e.id] };
          break;
        case "error_detected":
          if (e.source === "claude_code.transcript" && !String(p.subtype ?? "").includes("api")) break; // tool failures are shown on their tool line
          entry = { at: e.occurredAt, kind: "error", who: "tool", text: e.summary, status: "failed", count: 1, eventIds: [e.id] };
          break;
        case "file_created":
        case "file_modified":
        case "file_deleted": {
          const verb = e.eventType === "file_created" ? "created" : e.eventType === "file_deleted" ? "deleted" : "changed";
          entry = { at: e.occurredAt, kind: "file", who: "unknown", text: `${String(p.file)} ${verb}${p.linesAdded || p.linesRemoved ? ` (+${p.linesAdded ?? 0} −${p.linesRemoved ?? 0})` : ""}`,
            detail: ctx.likely.get(e.id) ? `${ctx.likely.get(e.id)!.confidence === "likely" ? "likely" : "possibly"} the AI: ${ctx.likely.get(e.id)!.basis}` : "seen by the file watcher; author unknown",
            count: 1, eventIds: [e.id], likelyAuthor: ctx.likely.get(e.id) ?? null };
          break;
        }
        case "git_commit":
          entry = { at: e.occurredAt, kind: "commit", who: "unknown", text: `Commit ${String(p.sha).slice(0, 7)} “${clip(String(p.message ?? "").split("\n")[0] ?? "", 80)}”`,
            detail: `${(p.files ?? []).length} files${ctx.likely.get(e.id) ? " · likely made by the AI" : ""}`, count: 1, eventIds: [e.id], likelyAuthor: ctx.likely.get(e.id) ?? null };
          break;
        case "branch_changed":
          entry = { at: e.occurredAt, kind: "branch", who: "unknown", text: e.summary, count: 1, eventIds: [e.id] };
          break;
        case "session_marker":
          if (e.source === "claude_code.hooks" || /compacted/.test(e.summary)) entry = { at: e.occurredAt, kind: "session", who: "tool", text: e.summary, count: 1, eventIds: [e.id] };
          break;
      }
      if (entry) entries.push(entry);
    }
    const folded = fold(entries);
    const n = (k: ActivityKind) => folded.filter((x) => x.kind === k).length;
    return {
      id, startedAt: evs[0]?.occurredAt ?? "", endedAt: evs[evs.length - 1]?.occurredAt ?? "",
      stats: { prompts: entries.filter((x) => x.kind === "prompt" && x.who === "you").length, edits: n("edit"), commands: n("command"), tests: n("test"),
        testFailures: folded.filter((x) => x.kind === "test" && x.status === "failed").length, commits: n("commit"), notes: n("note"), fileChanges: n("file") },
      entries: folded,
    };
  };

  const sessions = [...sessionsById.entries()].filter(([id]) => !opts.sessionId || id === opts.sessionId).map(([id, s]) => build(id, s.events));
  if (!opts.sessionId && other.length) sessions.push(build("outside", other));
  return sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt)); // newest first
}

/** One session's log as Markdown, for sharing or keeping. */
export function renderActivityMarkdown(projectName: string, s: ActivitySession, kinds: ActivityKind[] = DEFAULT_KINDS): string {
  const WHO: Record<string, string> = { you: "You", ai: "AI", subagent: "Helper agent", tool: "Tool", unknown: "?" };
  const multiDay = s.startedAt.slice(0, 10) !== s.endedAt.slice(0, 10);
  const stamp = (at: string) => (multiDay ? at.slice(5, 16).replace("T", " ") : at.slice(11, 16));
  const lines = s.entries.filter((x) => kinds.includes(x.kind)).map((x) =>
    `- \`${stamp(x.at)}\` **${WHO[x.who]}** — ${x.text}${x.detail ? ` *(${x.detail})*` : ""}${x.status === "failed" ? " ⚠️" : ""}`);
  return [
    `# ${projectName}: what the AI did`, "",
    `*Session ${s.id === "outside" ? "outside Claude Code" : s.id.slice(0, 8)} · ${s.startedAt.slice(0, 16).replace("T", " ")} – ${multiDay ? s.endedAt.slice(0, 16).replace("T", " ") : s.endedAt.slice(11, 16)} UTC · built from captured events, no AI involved in writing this log*`, "",
    `${s.stats.prompts} prompts · ${s.stats.edits} edits · ${s.stats.commands} commands · ${s.stats.tests} test runs (${s.stats.testFailures} failed) · ${s.stats.commits} commits · ${s.stats.notes} notes · ${s.stats.fileChanges} other file changes`, "",
    ...lines, "",
  ].join("\n");
}
