import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Loading } from "../components/Bits";
import { KIND } from "../components/StepView";
import { when } from "../format";

interface PageInfo { key: string; title: string; sources: number; chars: number; generated: boolean; stale: boolean; model: string | null }
interface Source { ref: string; type: "fact" | "claim"; grade: keyof typeof KIND; text: string; unitId: string | null; eventIds: number[] }
interface Claim { text: string; kind: keyof typeof KIND; evidence: string[] }
interface Stored {
  section: { title: string; summary: string; sections: { heading: string; claims: Claim[] }[]; uncertainty: string[] };
  validation: { ok: boolean; issues: { severity: string; heading: string; claim?: string; message: string }[]; groundedShare: number };
  sources: Source[];
  model: string | null;
  costUsd: number | null;
  attempts: number;
  createdAt: string;
  stale: boolean;
}
interface SectionResponse { section: Stored | null; brief: { sources: number; chars: number }; settings: { model: string | null } }

const LABEL = (key: string) => (key === "overview" ? "Overview" : key === "architecture" ? "Architecture" : key.slice("component:".length));

/**
 * The guide's written pages. Each statement cites sources (S1…); each source is a fact Dena
 * counted from events or a claim from an episode's explanation, and lists the events behind it.
 */
export function Wiki({ projectId, page, onPage, onEvent, onEpisode, onMemory, onWalkthrough }: {
  projectId: string; page: string | null; onPage: (key: string) => void; onEvent: (id: number) => void; onEpisode: (id: string) => void;
  onMemory: () => void; onWalkthrough: () => void;
}) {
  const [pages, setPages] = useState<PageInfo[] | null>(null);
  const loadPages = useCallback(() => api<PageInfo[]>(`projects/${projectId}/wiki`).then(setPages, () => setPages([])), [projectId]);
  useEffect(() => {
    loadPages();
  }, [loadPages]);
  if (!pages) return <Loading />;
  const current = page ?? "overview";
  const comps = pages.filter((p) => p.key.startsWith("component:"));
  const navItem = (p: PageInfo) => (
    <button key={p.key} className={`toc-item ${p.key === current ? "active" : ""}`} onClick={() => onPage(p.key)} style={{ gridTemplateColumns: "1fr auto" }}>
      <span className={`toc-title ${p.key.startsWith("component:") ? "mono" : ""}`}>{LABEL(p.key)}</span>
      {p.generated && <span className="toc-done" style={{ color: p.stale ? "var(--warn)" : "var(--ok)" }} title={p.stale ? "Outdated: new evidence since it was written" : "Written"}>●</span>}
    </button>
  );
  return (
    <div className="guide">
      <nav className="toc" aria-label="Wiki pages">
        <div className="side-label">Pages</div>
        {pages.filter((p) => !p.key.startsWith("component:")).map(navItem)}
        <div className="side-label" style={{ marginTop: 14 }}>Components</div>
        {comps.map(navItem)}
        <div className="side-label" style={{ marginTop: 14 }}>Built from facts</div>
        <button className="toc-item" style={{ gridTemplateColumns: "1fr" }} onClick={onMemory}><span>Problems, decisions, concepts →</span></button>
        <button className="toc-item" style={{ gridTemplateColumns: "1fr" }} onClick={onWalkthrough}><span>Episode walkthrough →</span></button>
      </nav>
      <div className="guide-main">
        <WikiPage key={current} projectId={projectId} pageKey={current} onEvent={onEvent} onEpisode={onEpisode} onWritten={loadPages} />
      </div>
    </div>
  );
}

function WikiPage({ projectId, pageKey, onEvent, onEpisode, onWritten }: { projectId: string; pageKey: string; onEvent: (id: number) => void; onEpisode: (id: string) => void; onWritten: () => void }) {
  const [r, setR] = useState<SectionResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const q = `projects/${projectId}/wiki/section?key=${encodeURIComponent(pageKey)}`;
  const load = useCallback(() => api<SectionResponse>(q).then(setR, (e) => setErr(String(e.message))), [q]);
  useEffect(() => {
    load();
  }, [load]);

  const write = async (model?: string, force = false) => {
    setBusy(model ?? "default");
    setErr(null);
    try {
      await api(`projects/${projectId}/wiki/section`, { method: "POST", body: { key: pageKey, model, force } });
      await load();
      onWritten();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const goSource = (ref: string) => {
    setFocus(ref);
    document.getElementById(`src-${ref}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  if (!r) return err ? <div className="error">{err}</div> : <Loading />;
  const s = r.section;
  const flagged = new Set(s?.validation.issues.filter((i) => i.severity === "error" && i.claim).map((i) => i.claim!) ?? []);
  const cited = s ? new Set(s.section.sections.flatMap((x) => x.claims.flatMap((c) => c.evidence))) : new Set<string>();

  return (
    <div className="page" style={{ maxWidth: 840 }}>
      {err && <div className="error">{err}</div>}
      {!s && (
        <div className="explain-card">
          <h2 className="step-title" style={{ marginTop: 0 }}>{LABEL(pageKey)}</h2>
          <p className="muted">Not written yet. Dena will send {r.brief.sources} sources (about {Math.round(r.brief.chars / 1000)}k characters: facts counted from events, and claims from explained episodes) to <b>{r.settings.model ?? "your default model"}</b>.</p>
          <button className="btn primary" disabled={!!busy} onClick={() => write()}>{busy ? "Writing… this can take a minute" : "Write this page"}</button>
        </div>
      )}
      {s && (
        <article className="step">
          <h2 className="step-title">{s.section.title}</h2>
          <div className="ai-notice">
            <b>Written by AI from captured evidence. It can be wrong.</b> Each statement is labeled and cites sources like <span className="ref static">S3</span>.
            A source is a <b>fact</b> Dena counted from captured events, or a <b>claim</b> from an episode's explanation; each lists the events behind it.
          </div>
          {s.stale && (
            <div className="notice" style={{ marginBottom: 14 }}>New evidence has been captured since this page was written.{" "}
              <button className="btn" disabled={!!busy} onClick={() => write(undefined, true)}>{busy ? "Rewriting…" : "Rewrite with new evidence"}</button></div>
          )}
          <p className="step-summary">{s.section.summary}</p>
          {s.section.sections.map((sec) => (
            <section key={sec.heading} className="step-section">
              <h3>{sec.heading}</h3>
              <ul className="claims">
                {sec.claims.map((c, i) => (
                  <li key={i} className={`claim ${c.kind}`}>
                    <span className={`badge ${KIND[c.kind].tone}`} title={KIND[c.kind].help}>{KIND[c.kind].label}</span>
                    <span className="claim-text">
                      {c.text}
                      {c.evidence.length > 0 && <span className="refs">{c.evidence.map((ref) => <button key={ref} className="ref" onClick={() => goSource(ref)} title="Show this source">{ref}</button>)}</span>}
                      {flagged.has(c.text.slice(0, 80)) && <span className="badge bad" style={{ marginLeft: 6 }}>check failed</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {s.section.uncertainty.length > 0 && (
            <section className="step-section"><h3>What is uncertain</h3><ul className="plain">{s.section.uncertainty.map((u, i) => <li key={i}>{u}</li>)}</ul></section>
          )}
          {s.validation.issues.length > 0 && (
            <section className="step-section"><h3>Checks</h3>
              <ul className="plain">{s.validation.issues.map((p, i) => <li key={i}><Badge tone={p.severity === "error" ? "bad" : "warn"}>{p.severity === "error" ? "failed" : "note"}</Badge> {p.heading}{p.claim ? ` — “${p.claim}…”` : ""}: {p.message}</li>)}</ul>
            </section>
          )}
          <section className="step-section">
            <h3>Sources</h3>
            {s.sources.filter((x) => cited.has(x.ref)).map((x) => (
              <div key={x.ref} id={`src-${x.ref}`} className={`source ${focus === x.ref ? "focused" : ""}`}>
                <span className="ref static">{x.ref}</span>
                <span>
                  <Badge tone={x.type === "fact" ? "ok" : KIND[x.grade].tone}>{x.type === "fact" ? "Fact" : `Claim · ${KIND[x.grade].label}`}</Badge> {x.text}
                  <span className="refs">{x.eventIds.slice(0, 6).map((id, i) => <button key={id} className="ref" onClick={() => onEvent(id)} title="Open the evidence">ev {i + 1}</button>)}</span>
                  {x.unitId && <button className="chip" style={{ marginLeft: 6 }} onClick={() => onEpisode(x.unitId!)}>episode</button>}
                </span>
              </div>
            ))}
          </section>
          <footer className="step-foot">
            Written by {s.model ?? "unknown model"} · {when(s.createdAt)}{s.costUsd ? ` · est. usage $${s.costUsd.toFixed(3)}` : ""}{s.attempts > 1 ? " · needed 1 repair" : ""} · {Math.round(s.validation.groundedShare * 100)}% of project statements reach captured events
          </footer>
          <div className="explain-more">
            <span className="muted">Want a more careful page? Stronger models use more of your plan.</span>
            {["sonnet", "opus"].map((m) => <button key={m} className="btn" disabled={!!busy} onClick={() => write(m, true)}>{busy === m ? `Writing with ${m[0]!.toUpperCase() + m.slice(1)}…` : `Rewrite with ${m[0]!.toUpperCase() + m.slice(1)}`}</button>)}
          </div>
        </article>
      )}
    </div>
  );
}
