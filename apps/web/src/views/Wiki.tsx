import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Loading } from "../components/Bits";
import { KIND } from "../components/StepView";
import { ClaimList } from "../components/ClaimList";
import { DocBar, type DocResponse } from "../components/DocBar";
import { BusyBar, ModelChoice } from "../components/BusyBar";
import { ModelSettings } from "../components/ModelSettings";
import { isStandingLimitationText, tokenLine, tokenRange, when } from "../format";
import { AboutGuide } from "../components/AboutGuide";

interface PageInfo { key: string; title: string; sources: number; chars: number; generated: boolean; stale: boolean; model: string | null }
interface Source { ref: string; type: "fact" | "claim"; grade: keyof typeof KIND; text: string; unitId: string | null; eventIds: number[] }
interface Claim { text: string; kind: keyof typeof KIND; evidence: string[]; edited?: boolean; flagged?: "incorrect" }
type SectionContent = Stored["section"];
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
interface SectionResponse { section: Stored | null; brief: { sources: number; chars: number; tokens: { promptTokens: number; outputTokens: number; low: number; high: number; calibrated: boolean; basis: string } };
  settings: { model: string | null } }

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
        <ModelSettings projectId={projectId} />
        <AboutGuide projectId={projectId} />
        <div className="side-label">Pages</div>
        {pages.filter((p) => !p.key.startsWith("component:")).map(navItem)}
        <div className="side-label" style={{ marginTop: 14 }}>Components</div>
        {comps.map(navItem)}
        <div className="side-label" style={{ marginTop: 14 }}>Built from facts</div>
        <button className="toc-item" style={{ gridTemplateColumns: "1fr" }} onClick={onMemory}><span>Problems, decisions, concepts →</span></button>
        <button className="toc-item" style={{ gridTemplateColumns: "1fr" }} onClick={onWalkthrough}><span>Episode walkthrough →</span></button>
        <div className="side-label" style={{ marginTop: 14 }}>Share</div>
        <ExportButton projectId={projectId} />
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
  const [doc, setDoc] = useState<DocResponse<SectionContent> | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [older, setOlder] = useState<{ content: SectionContent; meta: Record<string, any>; createdAt: string } | null>(null);
  const q = `projects/${projectId}/wiki/section?key=${encodeURIComponent(pageKey)}`;
  const dq = `projects/${projectId}/doc?type=wiki&key=${encodeURIComponent(pageKey)}`;
  const load = useCallback(() => Promise.all([api<SectionResponse>(q), api<DocResponse<SectionContent>>(dq)]).then(([a, b]) => {
    setR(a);
    setDoc(b);
  }, (e) => setErr(String(e.message))), [q, dq]);
  useEffect(() => {
    setOlder(null);
    if (viewing != null && viewing !== doc?.proposed?.id)
      api<{ revision: { content: SectionContent; meta: Record<string, any>; createdAt: string } }>(`projects/${projectId}/doc/revision?type=wiki&key=${encodeURIComponent(pageKey)}&id=${viewing}`)
        .then((x) => setOlder(x.revision), () => {});
  }, [viewing, projectId, pageKey, doc?.proposed?.id]);
  const saveEdit = async (next: SectionContent, note: string) => {
    if (!doc?.active) return;
    try {
      await api(`projects/${projectId}/doc/edit`, { method: "POST", body: { type: "wiki", key: pageKey, content: next, baseId: doc.active.id, note } });
    } catch (e) {
      setErr((e as Error).message);
    }
    await load();
  };
  useEffect(() => {
    load();
  }, [load]);

  const [stopping, setStopping] = useState(false);
  const [runModel, setRunModel] = useState("");
  const stop = async () => {
    setStopping(true);
    await api(`projects/${projectId}/wiki/stop`, { method: "POST", body: { key: pageKey } }).catch(() => {});
  };
  const write = async (model?: string, force = false) => {
    setBusy(model ?? "default");
    setStopping(false);
    setErr(null);
    try {
      await api(`projects/${projectId}/wiki/section`, { method: "POST", body: { key: pageKey, model, force } });
      setViewing(null);
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

  if (!r || !doc) return err ? <div className="error">{err}</div> : <Loading />;
  // Show the active revision (which may hold your edits), a proposed AI update, or an older version.
  const rev = viewing == null ? doc.active : viewing === doc.proposed?.id ? doc.proposed : older;
  const s: Stored | null = rev ? { section: rev.content, sources: rev.meta.sources ?? [], validation: rev.meta.validation, model: rev.meta.model ?? null,
    costUsd: rev.meta.costUsd ?? null, attempts: rev.meta.attempts ?? 1, createdAt: rev.createdAt, stale: viewing == null && doc.stale } : null;
  const editable = viewing == null && !!doc.active;
  const flagged = new Set(s?.validation.issues.filter((i) => i.severity === "error" && i.claim).map((i) => i.claim!) ?? []);
  const cited = s ? new Set(s.section.sections.flatMap((x) => x.claims.flatMap((c) => c.evidence))) : new Set<string>();

  return (
    <div className="page" style={{ maxWidth: 840 }}>
      {busy && <BusyBar what={`Writing this page${busy !== "default" ? ` with ${busy[0]!.toUpperCase() + busy.slice(1)}` : ""}`} onStop={stop} stopping={stopping} />}
      {err && <div className={err.startsWith("Stopped") ? "notice" : "error"}>{err}</div>}
      {!doc.active && (
        <div className="explain-card">
          <h2 className="step-title" style={{ marginTop: 0 }}>{LABEL(pageKey)}</h2>
          <p className="muted">Not written yet. Dena will send {r.brief.sources} sources (facts counted from events, and claims from explained episodes) to <b>{r.settings.model ?? "your default model"}</b>:
            {tokenRange(r.brief.tokens.low, r.brief.tokens.high)} (the high end if the checks ask for a repair).
            <span className="faint small" style={{ display: "block", marginTop: 4 }}>Token estimate {r.brief.tokens.calibrated ? "" : "uses "}{r.brief.tokens.basis}.</span></p>
          <span className="row">
            <ModelChoice value={runModel} onChange={setRunModel} projectDefault={r.settings.model} />
            <button className="btn primary" disabled={!!busy} onClick={() => write(runModel || undefined)}>Write this page</button>
          </span>
        </div>
      )}
      {doc.active && <DocBar projectId={projectId} type="wiki" docKey={pageKey} doc={doc} onChanged={load} viewing={viewing} onView={setViewing} allowContext={false} />}
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
              <ClaimList claims={sec.claims} flaggedByChecks={flagged} editable={editable}
                refs={(c) => c.evidence.map((ref) => <button key={ref} className="ref" onClick={() => goSource(ref)} title="Show this source">{ref}</button>)}
                onEdit={(i, next) => {
                  const sections = s.section.sections.map((x) => (x === sec ? { ...x, claims: next ? x.claims.map((c, j) => (j === i ? next : c)) : x.claims.filter((_, j) => j !== i) } : x));
                  void saveEdit({ ...s.section, sections }, next ? "Edited a statement" : `Removed: “${sec.claims[i]!.text.slice(0, 80)}”`);
                }}
                onMarkIncorrect={(i, n) => {
                  const c = sec.claims[i]!;
                  void api(`projects/${projectId}/doc/note`, { method: "POST", body: { type: "wiki", key: pageKey, kind: "incorrect", target: c.text, text: n } });
                  const sections = s.section.sections.map((x) => (x === sec ? { ...x, claims: x.claims.map((cc, j) => (j === i ? { ...cc, flagged: "incorrect" as const } : cc)) } : x));
                  void saveEdit({ ...s.section, sections }, "Marked a statement incorrect");
                }} />
            </section>
          ))}
          {s.section.uncertainty.filter((u) => !isStandingLimitationText(u)).length > 0 && (
            <section className="step-section"><h3>What is uncertain</h3><ul className="plain">{s.section.uncertainty.filter((u) => !isStandingLimitationText(u)).map((u, i) => <li key={i}>{u}</li>)}</ul></section>
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
            Written by {s.model ?? "unknown model"} · {when(s.createdAt)}{tokenLine(rev?.meta.tokens) ? ` · ${tokenLine(rev?.meta.tokens)}` : ""}{s.costUsd ? ` (API-equivalent $${s.costUsd.toFixed(3)})` : ""}{s.attempts > 1 ? " · needed 1 repair" : ""} · {Math.round(s.validation.groundedShare * 100)}% of project statements reach captured events
          </footer>
          <div className="explain-more">
            <span className="muted">Rewrite this page. Stronger models are more careful and use more of your plan.</span>
            <ModelChoice value={runModel} onChange={setRunModel} projectDefault={r.settings.model} />
            <button className="btn" disabled={!!busy} onClick={() => write(runModel || undefined, true)}>Rewrite</button>
          </div>
        </article>
      )}
    </div>
  );
}

/** Downloads the whole guide as Markdown: current versions of every page and step, with your edits. */
function ExportButton({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ filename: string; markdown: string; counts: { wikiPages: number; steps: number; stepsTotal: number } }>(`projects/${projectId}/export`);
      const url = URL.createObjectURL(new Blob([r.markdown], { type: "text/markdown;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMsg(`${r.counts.wikiPages} pages, ${r.counts.steps} of ${r.counts.stepsTotal} episodes`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ padding: "2px 8px" }}>
      <button className="btn" disabled={busy} onClick={run}>{busy ? "Exporting…" : "Export guide (.md)"}</button>
      {msg && <div className="faint small" style={{ marginTop: 4 }}>{msg}</div>}
    </div>
  );
}
