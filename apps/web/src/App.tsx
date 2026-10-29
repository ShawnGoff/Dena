import { useCallback, useEffect, useState } from "react";
import { api, hasToken, type Project } from "./api";
import { EvidencePanel } from "./components/EvidencePanel";
import { Overview } from "./views/Overview";
import { Search } from "./views/Search";
import { Timeline } from "./views/Timeline";
import { Guide } from "./views/Guide";
import { Memory } from "./views/Memory";
import { Wiki } from "./views/Wiki";

type View = "overview" | "wiki" | "timeline" | "guide" | "memory" | "search";

/** URL query keeps the view shareable within this browser session: ?p=<project>&v=<view>&ep=<episode>&ev=<event>. */
function readRoute() {
  const q = new URLSearchParams(location.search);
  return { p: q.get("p"), v: (q.get("v") as View) || "overview", ep: q.get("ep"), ev: q.get("ev") ? Number(q.get("ev")) : null, page: q.get("page") };
}

export function App() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [route, setRoute] = useState(readRoute);
  const [refresh, setRefresh] = useState(0);

  const go = useCallback((next: Partial<ReturnType<typeof readRoute>>) => {
    setRoute((r) => {
      const n = { ...r, ...next };
      const q = new URLSearchParams();
      if (n.p) q.set("p", n.p);
      if (n.v !== "overview") q.set("v", n.v);
      if (n.ep) q.set("ep", n.ep);
      if (n.ev != null) q.set("ev", String(n.ev));
      if (n.page) q.set("page", n.page);
      history.pushState(null, "", `${location.pathname}${q.size ? `?${q}` : ""}`);
      return n;
    });
  }, []);

  useEffect(() => {
    const pop = () => setRoute(readRoute());
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  const loadProjects = useCallback(() => api<Project[]>("projects").then(setProjects, (e) => setErr(String(e.message))), []);
  useEffect(() => {
    loadProjects();
    const t = setInterval(loadProjects, 5000); // keeps the recording indicator honest
    return () => clearInterval(t);
  }, [loadProjects]);

  if (!hasToken())
    return <div className="empty" style={{ paddingTop: 120 }}><b>Open Dena from the link it printed</b>Run <code>dena serve</code> and open the address it shows. The link carries a one-time key that keeps other web pages out.</div>;
  if (err) return <div className="page" style={{ padding: 40 }}><div className="error">{err}</div></div>;
  if (!projects) return <div className="empty">Loading…</div>;

  const project = projects.find((p) => p.id === route.p) ?? projects[0] ?? null;
  const onEvent = (id: number) => go({ ev: id });

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Projects">
        <div className="brand"><b>Dena</b><span>how it got built</span></div>
        <div>
          <div className="side-label">Projects</div>
          {projects.map((p) => (
            <button key={p.id} className={`side-item ${p.id === project?.id ? "active" : ""}`} onClick={() => go({ p: p.id, ev: null, ep: null })}>
              <span className={`dot`} style={{ background: p.recordingState === "recording" ? "var(--rec)" : p.recordingState === "paused" ? "var(--warn)" : "var(--line-strong)" }} />
              <span style={{ minWidth: 0 }}>
                {p.name}
                <small title={p.rootPath}>{p.rootPath}</small>
              </span>
            </button>
          ))}
          {projects.length === 0 && <p className="faint" style={{ padding: "0 8px", fontSize: 13 }}>No projects yet. Add one with <code>dena init &lt;folder&gt;</code>.</p>}
        </div>
      </nav>
      {project ? (
        <div className="main">
          <header className="topbar">
            <div style={{ minWidth: 0 }}>
              <h1>{project.name}</h1>
              <div className="path">{project.rootPath}</div>
            </div>
            <Recording project={project} onChange={() => { loadProjects(); setRefresh((n) => n + 1); }} />
            <div className="tabs" role="tablist">
              {(["overview", "wiki", "timeline", "guide", "memory", "search"] as View[]).map((v) => (
                <button key={v} role="tab" aria-selected={route.v === v} className={`tab ${route.v === v ? "active" : ""}`} onClick={() => go({ v })}>
                  {v[0]!.toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
          </header>
          <div className={`layout ${route.ev != null ? "open" : ""}`} style={{ flex: 1, minHeight: 0 }}>
            <div className={`content ${route.v === "guide" || route.v === "wiki" ? "flush" : ""}`}>
              {route.v === "overview" && <Overview projectId={project.id} refresh={refresh} onEvent={onEvent} onEpisode={(ep) => go({ v: "timeline", ep })} />}
              {route.v === "timeline" && <Timeline projectId={project.id} refresh={refresh} openEpisode={route.ep} selectedEvent={route.ev} onEvent={onEvent} />}
              {route.v === "guide" && <Guide projectId={project.id} openEpisode={route.ep} onEpisode={(ep) => go({ ep, ev: null })} onEvent={onEvent} />}
              {route.v === "wiki" && <Wiki projectId={project.id} page={route.page} onPage={(page) => go({ page, ev: null })} onEvent={onEvent}
                onEpisode={(ep) => go({ v: "guide", ep, ev: null })} onMemory={() => go({ v: "memory", ev: null })} onWalkthrough={() => go({ v: "guide", ev: null })} />}
              {route.v === "memory" && <Memory projectId={project.id} onEvent={onEvent} onEpisode={(ep) => go({ v: "guide", ep, ev: null })} />}
              {route.v === "search" && <Search projectId={project.id} selectedEvent={route.ev} onEvent={onEvent} />}
            </div>
            {route.ev != null && <EvidencePanel projectId={project.id} eventId={route.ev} onSelect={onEvent} onClose={() => go({ ev: null })}
              onEpisode={(ep) => route.v === "timeline" && ep !== route.ep && setRoute((r) => ({ ...r, ep }))} />}
          </div>
        </div>
      ) : (
        <div className="empty" style={{ paddingTop: 120 }}><b>No projects yet</b>Register a folder with <code>dena init &lt;folder&gt;</code>, then reload.</div>
      )}
    </div>
  );
}

/** Recording status is always visible, with the controls next to it. */
function Recording({ project, onChange }: { project: Project; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (action: string) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`projects/${project.id}/recording`, { method: "POST", body: { action } });
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const s = project.recordingState;
  const elsewhere = s !== "stopped" && !project.recorderRunning;
  return (
    <div className="rec">
      <span className={`pill ${s}`} title={elsewhere ? "A recorder started from the command line is running" : undefined}>
        <span className="dot" />
        {s === "recording" ? "Recording" : s === "paused" ? "Paused — nothing is captured" : "Not recording"}
      </span>
      {s === "stopped" && <button className="btn primary" disabled={busy} onClick={() => act("start")}>Start recording</button>}
      {s === "recording" && !elsewhere && <button className="btn" disabled={busy} onClick={() => act("pause")}>Pause</button>}
      {s === "paused" && !elsewhere && <button className="btn" disabled={busy} onClick={() => act("resume")}>Resume</button>}
      {s !== "stopped" && !elsewhere && <button className="btn danger" disabled={busy} onClick={() => act("stop")}>Stop</button>}
      {err && <span className="badge bad">{err}</span>}
    </div>
  );
}
