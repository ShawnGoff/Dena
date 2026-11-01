import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Loading } from "../components/Bits";
import { timeOnly, when } from "../format";

const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString();

type Kind = "prompt" | "reply" | "edit" | "command" | "test" | "commit" | "note" | "read" | "search" | "browser" | "question" | "housekeeping" | "error" | "file" | "branch" | "session";
interface Entry { at: string; kind: Kind; who: string; text: string; detail?: string; status?: "ok" | "failed" | "unknown"; count: number; eventIds: number[] }
interface Stats { prompts: number; edits: number; commands: number; tests: number; testFailures: number; commits: number; notes: number; fileChanges: number }
interface SessionLite { id: string; startedAt: string; endedAt: string; stats: Stats; entryCount: number }
interface Session extends SessionLite { entries: Entry[] }

const FILTERS: { label: string; kinds: Kind[] }[] = [
  { label: "Your prompts", kinds: ["prompt"] },
  { label: "Edits", kinds: ["edit", "file"] },
  { label: "Commands", kinds: ["command"] },
  { label: "Tests", kinds: ["test"] },
  { label: "Commits", kinds: ["commit", "branch"] },
  { label: "AI notes", kinds: ["note"] },
  { label: "Looking things up", kinds: ["read", "search", "browser"] },
  { label: "Questions & errors", kinds: ["question", "error", "session"] },
  { label: "AI replies", kinds: ["reply"] },
  { label: "Bookkeeping", kinds: ["housekeeping"] },
];
const OFF_BY_DEFAULT = new Set(["AI replies", "Bookkeeping"]);
const ICON: Record<Kind, string> = { prompt: "›", reply: "·", edit: "✎", command: "$", test: "▣", commit: "◆", note: "✍", read: "⌕", search: "⌕",
  browser: "◳", question: "?", housekeeping: "·", error: "!", file: "~", branch: "⑂", session: "#" };
const WHO: Record<string, string> = { you: "You", ai: "AI", subagent: "Helper", tool: "Tool", unknown: "?" };

/**
 * What the AI did, session by session, in plain language. Built from captured events with no
 * model involved; every line opens the evidence behind it.
 */
export function Activity({ projectId, onEvent }: { projectId: string; onEvent: (id: number) => void }) {
  const [sessions, setSessions] = useState<SessionLite[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [s, setS] = useState<Session | null>(null);
  const [on, setOn] = useState<Set<string>>(new Set(FILTERS.map((f) => f.label).filter((l) => !OFF_BY_DEFAULT.has(l))));
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<SessionLite[]>(`projects/${projectId}/activity`).then((list) => {
      setSessions(list);
      setCurrent((c) => c ?? list[0]?.id ?? null);
    }, (e) => setErr(String(e.message)));
  }, [projectId]);
  const load = useCallback(() => {
    if (!current) return;
    setS(null);
    api<Session>(`projects/${projectId}/activity/session?id=${encodeURIComponent(current)}`).then(setS, (e) => setErr(String(e.message)));
  }, [projectId, current]);
  useEffect(() => {
    load();
  }, [load]);

  if (err) return <div className="error" style={{ margin: 24 }}>{err}</div>;
  if (!sessions) return <Loading />;
  if (!sessions.length) return <div className="empty"><b>No AI activity yet</b>Start recording, or import past Claude Code sessions.</div>;
  const kinds = new Set(FILTERS.filter((f) => on.has(f.label)).flatMap((f) => f.kinds));
  const visible = s?.entries.filter((x) => kinds.has(x.kind)) ?? [];
  // Busiest kinds first, so the filters read in order of how much of the session they cover.
  const tally = (f: (typeof FILTERS)[number]) => s?.entries.reduce((n, x) => n + (f.kinds.includes(x.kind) ? x.count : 0), 0) ?? 0;
  const ordered = [...FILTERS].sort((a, b) => tally(b) - tally(a));
  const toggle = (l: string) => setOn((prev) => {
    const n = new Set(prev);
    n.has(l) ? n.delete(l) : n.add(l);
    return n;
  });
  const exportMd = async () => {
    if (!s) return;
    const r = await api<{ filename: string; markdown: string }>(`projects/${projectId}/activity/export?id=${encodeURIComponent(s.id)}&kinds=${[...kinds].join(",")}`);
    const url = URL.createObjectURL(new Blob([r.markdown], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = r.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="guide">
      <nav className="toc" aria-label="Sessions">
        <div className="side-label">Sessions</div>
        {sessions.map((x) => (
          <button key={x.id} className={`toc-item ${x.id === current ? "active" : ""}`} onClick={() => setCurrent(x.id)} style={{ gridTemplateColumns: "1fr" }}>
            <span>
              <div>{x.id === "outside" ? "Outside Claude sessions" : when(x.startedAt)}</div>
              <div className="faint small">
                {x.id === "outside" ? `${x.stats.fileChanges} file changes · ${x.stats.commits} commits`
                  : `${x.stats.prompts} prompts · ${x.stats.edits + x.stats.fileChanges} changes · ${x.stats.tests} tests${x.stats.testFailures ? ` (${x.stats.testFailures} failed)` : ""} · ${x.stats.commits} commits`}
              </div>
            </span>
          </button>
        ))}
      </nav>
      <div className="guide-main">
        <div className="page" style={{ maxWidth: 900 }}>
          <div className="step-head" style={{ justifyContent: "space-between" }}>
            <div>
              <h2 className="step-title" style={{ margin: 0 }}>What the AI did</h2>
              {s && <span className="faint small">{s.id === "outside" ? "Changes made outside Claude Code sessions" : `${when(s.startedAt)} – ${sameDay(s.startedAt, s.endedAt) ? timeOnly(s.endedAt) : when(s.endedAt)}`} · built from captured events; no AI wrote this log</span>}
            </div>
            <button className="btn" disabled={!s} onClick={exportMd}>Export (.md)</button>
          </div>
          <div className="filters">
            {ordered.map((f) => (
              <button key={f.label} className={`chip ${on.has(f.label) ? "on" : ""}`} aria-pressed={on.has(f.label)} onClick={() => toggle(f.label)}>
                {f.label}{s && <span className="faint"> {tally(f)}</span>}</button>
            ))}
          </div>
          {!s && <Loading />}
          {s && visible.length === 0 && <div className="empty"><b>Nothing to show</b>Turn on more of the filters above.</div>}
          {s && (
            <ol className="activity">
              {visible.map((x, i) => (
                <li key={i} className={`act ${x.kind} ${x.who}`} onClick={() => x.eventIds[0] != null && onEvent(x.eventIds[0])} role="button" tabIndex={0}
                  onKeyDown={(k) => (k.key === "Enter" || k.key === " ") && x.eventIds[0] != null && onEvent(x.eventIds[0])}>
                  <span className="act-time mono">{sameDay(s.startedAt, x.at) ? timeOnly(x.at) : when(x.at)}</span>
                  <span className="act-icon" aria-hidden>{ICON[x.kind]}</span>
                  <span className="act-body">
                    <span className="act-who">{WHO[x.who] ?? x.who}</span> {x.text}
                    {x.status === "failed" && <Badge tone="bad">failed</Badge>}
                    {x.detail && <span className="act-detail">{x.detail}</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
