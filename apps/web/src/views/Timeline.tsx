import { useEffect, useRef, useState } from "react";
import { api, type Episode, type EventLite } from "../api";
import { Badge, EventRow, Loading } from "../components/Bits";
import { when } from "../format";

/**
 * Episodes in order, collapsed by default so thousands of events stay readable. Expanding one
 * shows its notable events; "show everything" reveals tool calls and replies as well.
 */
export function Timeline({ projectId, refresh, openEpisode, selectedEvent, onEvent }: {
  projectId: string; refresh: number; openEpisode: string | null; selectedEvent: number | null; onEvent: (id: number) => void;
}) {
  const [eps, setEps] = useState<Episode[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set(openEpisode ? [openEpisode] : []));
  const [all, setAll] = useState(false);
  const [onlyChanges, setOnlyChanges] = useState(false);

  useEffect(() => {
    api<Episode[]>(`projects/${projectId}/episodes${refresh ? "?rebuild=1" : ""}`).then(setEps, (e) => setErr(String(e.message)));
  }, [projectId, refresh]);
  useEffect(() => {
    if (openEpisode) setOpen((s) => new Set([...s, openEpisode]));
  }, [openEpisode]);

  if (err) return <div className="error">{err}</div>;
  if (!eps) return <Loading />;
  if (!eps.length) return <div className="empty"><b>No activity yet</b>Start recording, or import history with <code>dena import-claude</code> and <code>dena import-git</code>.</div>;

  const shown = onlyChanges ? eps.filter((e) => e.stats.fileChanges || e.stats.commits) : eps;
  const toggle = (id: string) => setOpen((s) => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  return (
    <div className="page">
      <div className="toolbar">
        <span className="muted">{eps.length} episodes</span>
        <label className="toggle"><input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} /> only episodes with changes</label>
        <label className="toggle"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> show every event</label>
        <span style={{ marginLeft: "auto" }} />
        <button className="btn" onClick={() => setOpen(new Set())}>Collapse all</button>
      </div>
      {shown.map((e) => (
        <EpisodeCard key={e.id} projectId={projectId} ep={e} open={open.has(e.id)} all={all} onToggle={() => toggle(e.id)}
          selectedEvent={selectedEvent} onEvent={onEvent} scrollTo={openEpisode === e.id} />
      ))}
    </div>
  );
}

function EpisodeCard({ projectId, ep, open, all, onToggle, selectedEvent, onEvent, scrollTo }: {
  projectId: string; ep: Episode; open: boolean; all: boolean; onToggle: () => void; selectedEvent: number | null; onEvent: (id: number) => void; scrollTo: boolean;
}) {
  const [events, setEvents] = useState<EventLite[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && !events) api<EventLite[]>(`projects/${projectId}/episodes/${ep.id}/events`).then(setEvents, () => setEvents([]));
  }, [open, events, projectId, ep.id]);
  useEffect(() => {
    if (scrollTo) ref.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [scrollTo]);
  const s = ep.stats;
  const visible = events?.filter((e) => all || e.notable) ?? [];
  const hidden = (events?.length ?? 0) - visible.length;

  return (
    <div className="episode" ref={ref}>
      <button className="episode-head" onClick={onToggle} aria-expanded={open}>
        <span className="episode-num">#{ep.position}</span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <div className="episode-title">{ep.title}</div>
          <div className="episode-meta">
            <span className="faint" style={{ fontSize: 12.5 }}>{when(ep.startedAt)}</span>
            {s.prompts > 0 && <Badge tone="accent">{s.prompts} prompt{s.prompts > 1 ? "s" : ""}</Badge>}
            {s.fileChanges > 0 && <Badge tone="ok">{s.fileChanges} file change{s.fileChanges > 1 ? "s" : ""}</Badge>}
            {s.commits > 0 && <Badge tone="ok">{s.commits} commit{s.commits > 1 ? "s" : ""}</Badge>}
            {s.tests > 0 && <Badge tone={s.testFailures ? "bad" : "ok"}>{s.tests} test run{s.tests > 1 ? "s" : ""}{s.testFailures ? ` · ${s.testFailures} failed` : ""}</Badge>}
            {s.notes > 0 && <Badge tone="warn">{s.notes} agent note{s.notes > 1 ? "s" : ""}</Badge>}
            {ep.explained && <Badge>explained</Badge>}
          </div>
        </span>
        <span className={`chev ${open ? "open" : ""}`}>›</span>
      </button>
      {open && (
        <div className="episode-body">
          {!events && <Loading />}
          {visible.map((e) => <EventRow key={e.id} e={e} selected={e.id === selectedEvent} onClick={() => onEvent(e.id)} />)}
          {hidden > 0 && <div className="faint" style={{ fontSize: 12.5, padding: "6px 10px" }}>{hidden} tool calls, replies and results hidden · tick "show every event" to see them</div>}
        </div>
      )}
    </div>
  );
}
