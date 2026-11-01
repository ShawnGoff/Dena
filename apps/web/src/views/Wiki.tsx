import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Loading } from "../components/Bits";
import { KIND } from "../components/StepView";
import { ClaimList } from "../components/ClaimList";
import { DocBar, type DocResponse } from "../components/DocBar";
import { BusyBar, ModelChoice } from "../components/BusyBar";
import { ModelSettings, useSettingsChanged } from "../components/ModelSettings";
import { isStandingLimitationText, tokenLine, tokenRange, when } from "../format";
import { AboutGuide } from "../components/AboutGuide";
import { HowBuilt } from "../components/HowBuilt";
import { TutorialDialog } from "../components/TutorialDialog";

interface PageInfo { key: string; title: string; sources: number; chars: number; generated: boolean; stale: boolean; model: string | null }
interface Source { ref: string; type: "fact" | "claim" | "code"; grade: keyof typeof KIND; text: string; unitId: string | null; eventIds: number[]; files?: string[] }
interface Claim { text: string; kind: keyof typeof KIND; evidence: string[]; edited?: boolean; flagged?: "incorrect" }
type SectionContent = Stored["section"];
interface Stored {
  section: { title: string; summary: string; sections: { heading: string; claims: Claim[] }[]; uncertainty: string[]; learn?: { concept: string; explanation: string }[] };
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

const LABEL = (key: string) => (key === "overview" ? "Overview" : key === "product" ? "Product guide" : key === "tutorial" ? "Build it yourself" : key === "architecture" ? "Architecture" : key.slice("component:".length));
/** Source files the Code tab explains (documents and package files are shown as plain paths). */
const isCode = (f: string) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|c|h|cpp|hpp|cs|php|css|scss|html|vue|svelte|sql|sh)$/i.test(f);
const sourceBadge = (x: Source) => (x.type === "fact" ? "Fact" : x.type === "code" ? (x.grade === "observed" ? "From the project's files" : "Dena's reading of the code") : `Claim · ${KIND[x.grade].label}`);

/**
 * The guide's written pages. Each statement cites sources (S1…); each source is a fact Dena
 * counted from events or a claim from an episode's explanation, and lists the events behind it.
 */
export function Wiki({ projectId, page, onPage, onEvent, onEpisode, onFile, onMemory, onWalkthrough }: {
  projectId: string; page: string | null; onPage: (key: string) => void; onEvent: (id: number) => void; onEpisode: (id: string) => void;
  onFile: (path: string) => void; onMemory: () => void; onWalkthrough: () => void;
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
      {p.generated && <span className="toc-done" style={{ color: p.stale ? "var(--warn)" : "var(--ok)" }} title={p.stale ? "Outdated: new activity since it was written" : "Written"}>●</span>}
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
        <button className="toc-item" style={{ gridTemplateColumns: "1fr" }} onClick={onWalkthrough}><span>Step-by-step walkthrough →</span></button>
        <div className="side-label" style={{ marginTop: 14 }}>Share</div>
        <ExportButton projectId={projectId} />
      </nav>
      <div className="guide-main">
        <WikiPage key={current} projectId={projectId} pageKey={current} onEvent={onEvent} onEpisode={onEpisode} onFile={onFile} onWritten={loadPages} />
      </div>
    </div>
  );
}

function WikiPage({ projectId, pageKey, onEvent, onEpisode, onFile, onWritten }: {
  projectId: string; pageKey: string; onEvent: (id: number) => void; onEpisode: (id: string) => void; onFile: (path: string) => void; onWritten: () => void;
}) {
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
  useSettingsChanged(load);

  const [stopping, setStopping] = useState(false);
  const [runModel, setRunModel] = useState("");
  // The whole-project tutorial asks first, with an estimate, every time it is written in full.
  const tutorial = pageKey === "tutorial";
  const [confirm, setConfirm] = useState(false);
  const writeFull = (force = false) => (tutorial ? setConfirm(true) : write(runModel || undefined, force));
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
      {confirm && <TutorialDialog projectId={projectId} onClose={() => setConfirm(false)} onDone={() => { setViewing(null); load(); onWritten(); }} />}
      {!doc.active && tutorial && (
        <div className="explain-card">
          <h2 className="step-title" style={{ marginTop: 0 }}>Build it yourself</h2>
          <p className="muted">One tutorial that teaches someone to build this project from the start, written from the instructions in your explained steps.
            It covers your entire project, so Dena shows the estimate and asks before it starts.</p>
          <button className="btn primary" onClick={() => setConfirm(true)}>Write the tutorial…</button>
        </div>
      )}
      {!doc.active && !tutorial && (
        <div className="explain-card">
          <h2 className="step-title" style={{ marginTop: 0 }}>{LABEL(pageKey)}</h2>
          <p className="muted">Not written yet. Dena will send {r.brief.sources} sources (facts counted from events, claims from explained steps, and the project's own files):
            {tokenRange(r.brief.tokens.low, r.brief.tokens.high)} (the high end if the checks ask for a repair).
            <span className="faint small" style={{ display: "block", marginTop: 4 }}>Token estimate {r.brief.tokens.calibrated ? "" : "uses "}{r.brief.tokens.basis}.</span></p>
          <span className="row">
            <ModelChoice value={runModel} onChange={setRunModel} projectDefault={r.settings.model} />
            <button className="btn primary" disabled={!!busy} onClick={() => write(runModel || undefined)}>Write this page</button>
          </span>
        </div>
      )}
      {doc.active && <DocBar projectId={projectId} type="wiki" docKey={pageKey} doc={doc} onChanged={() => { load(); onWritten(); }} viewing={viewing} onView={setViewing} allowContext={false}
        onRewrite={() => writeFull(true)} projectModel={r.settings.model} />}
      {s && (
        <article className="step">
          <h2 className="step-title">{s.section.title}</h2>
          <div className="ai-notice">
            <b>Written by AI from what Dena recorded. It can be wrong.</b> Each statement is labeled and cites sources like <span className="ref static">S3</span>.
            A source is a <b>fact</b> Dena counted from captured events, a <b>claim</b> from a step's explanation, or text from the project's own <b>files</b>; each lists the events or file behind it.
          </div>
          <p className="step-summary">{s.section.summary}</p>
          {s.section.sections.map((sec) => (
            <section key={sec.heading} className="step-section">
              <h3>{sec.heading}</h3>
              <ClaimList claims={sec.claims} flaggedByChecks={flagged} editable={editable} numbered={tutorial}
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
          {s.section.learn && s.section.learn.length > 0 && (
            <section className="step-section"><h3>What you can learn here</h3>
              <div className="concepts">{s.section.learn.map((c) => <div key={c.concept} className="concept"><b>📘 {c.concept}</b><span>{c.explanation}</span></div>)}</div>
              <p className="faint small">General knowledge the page draws on, not claims about this project.</p>
            </section>
          )}
          {viewing == null && <HowBuilt projectId={projectId} type="wiki" docKey={pageKey} onEvent={onEvent} />}
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
                  <Badge tone={x.type === "fact" || (x.type === "code" && x.grade === "observed") ? "ok" : KIND[x.grade].tone}>{sourceBadge(x)}</Badge> <SourceText text={x.text} />
                  <span className="refs">{x.eventIds.slice(0, 6).map((id, i) => <button key={id} className="ref" onClick={() => onEvent(id)} title="See the source">ev {i + 1}</button>)}</span>
                  {x.files?.map((f) => isCode(f)
                    ? <button key={f} className="chip" style={{ marginLeft: 6 }} onClick={() => onFile(f)} title="Open this file's explainer">{f}</button>
                    : <code key={f} className="small" style={{ marginLeft: 6 }}>{f}</code>)}
                  {x.unitId && <button className="chip" style={{ marginLeft: 6 }} onClick={() => onEpisode(x.unitId!)}>step</button>}
                </span>
              </div>
            ))}
          </section>
          <footer className="step-foot">
            Written by {s.model ?? "unknown model"} · {when(s.createdAt)}{tokenLine(rev?.meta.tokens) ? ` · ${tokenLine(rev?.meta.tokens)}` : ""}{s.costUsd ? ` (API-equivalent $${s.costUsd.toFixed(3)})` : ""}{s.attempts > 1 ? " · needed 1 repair" : ""} · {Math.round(s.validation.groundedShare * 100)}% of project statements reach captured events or the project's files
          </footer>
          <div className="explain-more">
            <span className="muted">Rewrite this page. Stronger models are more careful and use more of your plan.</span>
            <ModelChoice value={runModel} onChange={setRunModel} projectDefault={r.settings.model} />
            <button className="btn" disabled={!!busy} onClick={() => writeFull(true)}>{tutorial ? "Rewrite…" : "Rewrite"}</button>
          </div>
        </article>
      )}
    </div>
  );
}

/** Downloads the whole guide: Markdown to keep or edit, or one HTML page to share. Both are current versions with your edits. */
function ExportButton({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState<"md" | "html" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (format: "md" | "html") => {
    setBusy(format);
    setMsg(null);
    try {
      const r = await api<{ filename: string; markdown?: string; html?: string; counts: { wikiPages: number; steps: number; stepsTotal: number } }>(
        `projects/${projectId}/export${format === "html" ? "?format=html" : ""}`);
      const blob = format === "html" ? new Blob([r.html!], { type: "text/html;charset=utf-8" }) : new Blob([r.markdown!], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMsg(`${r.counts.wikiPages} pages, ${r.counts.steps} of ${r.counts.stepsTotal} steps${format === "html" ? ". It contains your project's history: read it before you share it." : ""}`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div style={{ padding: "2px 8px" }}>
      <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <button className="btn" disabled={!!busy} onClick={() => run("html")} title="One page that opens in any browser">{busy === "html" ? "Exporting…" : "Share as a web page (.html)"}</button>
        <button className="btn" disabled={!!busy} onClick={() => run("md")}>{busy === "md" ? "Exporting…" : "Markdown (.md)"}</button>
      </span>
      {msg && <div className="faint small" style={{ marginTop: 4 }}>{msg}</div>}
    </div>
  );
}

/** Long sources (a whole README section) show a preview first. */
function SourceText({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  if (text.length <= 320) return <>{text}</>;
  return <>{all ? text : `${text.slice(0, 300).trimEnd()}…`} <button className="linkish small" onClick={() => setAll(!all)}>{all ? "show less" : "show all"}</button></>;
}
