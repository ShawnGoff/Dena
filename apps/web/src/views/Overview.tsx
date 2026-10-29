import { useEffect, useState } from "react";
import { api, type Overview as O } from "../api";
import { Badge, EventRow, Loading } from "../components/Bits";
import { SOURCE_LABEL, when } from "../format";
import { GuideUpdates } from "../components/GuideUpdates";

export function Overview({ projectId, refresh, onEvent, onEpisode }: { projectId: string; refresh: number; onEvent: (id: number) => void; onEpisode: (id: string) => void }) {
  const [o, setO] = useState<O | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<O>(`projects/${projectId}/overview`).then(setO, (e) => setErr(String(e.message)));
  }, [projectId, refresh]);
  if (err) return <div className="error">{err}</div>;
  if (!o) return <Loading />;

  const count = (t: string) => o.stats.byType.find((x) => x.type === t)?.n ?? 0;
  const total = o.stats.byType.reduce((n, x) => n + x.n, 0);
  const unknown = o.stats.byActor.find((a) => a.actor === "unknown")?.n ?? 0;
  const live = o.project.recorderRunning && o.project.recordingState === "recording";
  // The same limitation recorded once per session reads better as one line with a count.
  const groups = [...o.gaps.reduce((m, g) => {
    const key = `${g.source}|${g.reason}`;
    const cur = m.get(key);
    m.set(key, cur ? { ...cur, count: cur.count + 1 } : { key, source: g.source, reason: g.reason, fromTime: g.fromTime, count: 1 });
    return m;
  }, new Map<string, { key: string; source: string; reason: string; fromTime: string | null; count: number }>()).values()];

  return (
    <div className="page">
      <div className="grid cols-4">
        <div className="card stat"><b>{total.toLocaleString()}</b><span>events captured</span></div>
        <div className="card stat"><b>{count("prompt_submitted")}</b><span>prompts across {o.stats.sessions} sessions</span></div>
        <div className="card stat"><b>{count("git_commit")}</b><span>commits · {count("test_result")} test runs</span></div>
        <div className="card stat"><b>{o.episodes.explained}<span className="faint" style={{ fontSize: 16 }}> / {o.episodes.total}</span></b><span>episodes explained</span></div>
      </div>
      <div className="section-gap" />
      <GuideUpdates projectId={projectId} />
      <div className="section-gap" />
      <div className="grid cols-2">
        <div className="card">
          <h2>Capture sources</h2>
          {/* "live" only while a recorder is actually running; "ready" means set up but not capturing right now. */}
          <Source status={live ? "live" : "ready"} label="Claude Code transcripts" detail="Prompts, AI replies, tool calls, edits with diffs, test runs" />
          <Source status={!(o.sources.hooksProject || o.sources.hooksUser) ? "off" : live ? "live" : "ready"} label="Claude Code live hooks"
            detail={o.sources.hooksProject || o.sources.hooksUser ? `Installed (${o.sources.hooksProject ? "this folder" : "all sessions"}): exit codes, timings, agent notes${live ? "" : ". Hook data waits and is imported when recording runs"}` : "Not installed — run: dena hooks install"} />
          <Source status={!o.sources.git ? "off" : live ? "live" : "ready"} label="Git" detail={o.sources.git ? "Commits, diffs, branch switches" : "This folder is not a git repository"} />
          <Source status={live ? "live" : "off"} label="File watcher" detail={live ? "Watching for changes" : "Runs while recording; changes made meanwhile are found on the next start"} />
          {!live && <p className="faint" style={{ fontSize: 12.5 }}>Nothing is being captured right now{o.project.recordingState !== "stopped" ? ", although recording was left on. Use Start recording above to resume" : ". Use Start recording above"}.</p>}
          {unknown > 0 && <p className="faint" style={{ fontSize: 12.5, marginBottom: 0 }}>{unknown} events have an unknown author: Dena saw the change but no source recorded who made it.</p>}
        </div>
        <div className="card">
          <h2>Known gaps ({o.gaps.length})</h2>
          {o.gaps.length === 0 && <p className="muted">None recorded.</p>}
          {groups.slice(0, 6).map((g) => (
            <div key={g.key} className="source-row" style={{ alignItems: "flex-start" }}>
              <Badge>{SOURCE_LABEL[g.source] ?? g.source}</Badge>
              <span className="grow" style={{ fontSize: 13 }}>
                {g.reason}
                {g.count > 1 ? <span className="faint"> · {g.count} sessions</span> : g.fromTime && <span className="faint"> · {when(g.fromTime)}</span>}
              </span>
            </div>
          ))}
          {groups.length > 6 && <p className="faint" style={{ fontSize: 12.5 }}>and {groups.length - 6} more</p>}
        </div>
      </div>
      <div className="section-gap" />
      <div className="grid cols-2">
        <div className="card">
          <h2>Latest episodes</h2>
          {o.episodes.latest.length === 0 && <p className="muted">Open the Timeline to group activity into episodes.</p>}
          {o.episodes.latest.map((e) => (
            <div key={e.id} className="link-row" onClick={() => onEpisode(e.id)}>
              <span className="faint mono" style={{ minWidth: 30 }}>#{e.position}</span>
              <span className="s">{e.title}</span>
              <span className="faint" style={{ fontSize: 12 }}>{when(e.startedAt)}</span>
            </div>
          ))}
        </div>
        <div className="card">
          <h2>Recent activity</h2>
          {o.recent.map((e) => <EventRow key={e.id} e={e} onClick={() => onEvent(e.id)} showDate />)}
        </div>
      </div>
    </div>
  );
}

function Source({ status, label, detail }: { status: "live" | "ready" | "off"; label: string; detail: string }) {
  return (
    <div className="source-row">
      <Badge tone={status === "live" ? "ok" : status === "ready" ? "warn" : "muted"}>{status === "live" ? "live" : status === "ready" ? "ready" : "off"}</Badge>
      <div className="grow">
        <div>{label}</div>
        <div className="faint" style={{ fontSize: 12.5 }}>{detail}</div>
      </div>
    </div>
  );
}
