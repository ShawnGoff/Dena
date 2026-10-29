import { useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Loading } from "../components/Bits";
import { KIND } from "../components/StepView";
import { when } from "../format";

interface Entity {
  id: string;
  kind: string;
  title: string;
  data: Record<string, any>;
  sources: { unitId: string | null; eventId: number | null; basis: string }[];
}
interface MemoryData {
  components: Entity[];
  problems: Entity[];
  decisions: Entity[];
  concepts: Entity[];
  questions: Entity[];
  episodes: Record<string, { position: number; title: string }>;
  explainedEpisodes: number;
}
type Section = "problems" | "components" | "decisions" | "concepts" | "questions";

const SECTIONS: { key: Section; label: string; help: string }[] = [
  { key: "problems", label: "Problems & fixes", help: "Test failures and what came after them, read from captured test runs." },
  { key: "components", label: "Components", help: "Parts of the project by folder, counted from captured file changes and commits." },
  { key: "decisions", label: "Decisions", help: "Choices recorded in agent notes and in explained episodes, each with how it is known." },
  { key: "concepts", label: "Concepts", help: "Terms defined while explaining episodes: general background, not claims about this project." },
  { key: "questions", label: "Unknowns", help: "What the evidence could not show, as noted in explanations and agent notes." },
];

/**
 * Project memory: what the project is made of and what happened to it, built without a model
 * from events and existing explanations. Every item links back to episodes and events.
 */
export function Memory({ projectId, onEvent, onEpisode }: { projectId: string; onEvent: (id: number) => void; onEpisode: (id: string) => void }) {
  const [m, setM] = useState<MemoryData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("problems");
  useEffect(() => {
    api<MemoryData>(`projects/${projectId}/memory`).then(setM, (e) => setErr(String(e.message)));
  }, [projectId]);
  if (err) return <div className="error">{err}</div>;
  if (!m) return <Loading />;

  const ep = (id: string | null | undefined) => {
    const e = id ? m.episodes[id] : undefined;
    return e && id ? (
      <button key={id} className="chip" title={e.title} onClick={() => onEpisode(id)}>#{e.position}</button>
    ) : null;
  };
  const evBtn = (id: number | null | undefined, label: string) =>
    id != null ? <button key={`${label}-${id}`} className="ref" onClick={() => onEvent(id)} title="Open the evidence">{label}</button> : null;
  const count = (k: Section) => m[k].length;
  const sparse = (k: Section) => (k === "decisions" || k === "concepts" || k === "questions") && m.explainedEpisodes < 10;

  return (
    <div className="page">
      <div className="mem-tabs" role="tablist">
        {SECTIONS.map((s) => (
          <button key={s.key} role="tab" aria-selected={section === s.key} className={`tab ${section === s.key ? "active" : ""}`} onClick={() => setSection(s.key)}>
            {s.label} <span className="faint">{count(s.key)}</span>
          </button>
        ))}
      </div>
      <p className="muted" style={{ margin: "4px 0 16px" }}>{SECTIONS.find((s) => s.key === section)!.help}</p>
      {sparse(section) && (
        <div className="notice" style={{ marginBottom: 14 }}>
          Built from the {m.explainedEpisodes} episode{m.explainedEpisodes === 1 ? "" : "s"} explained so far. Explain more episodes in the Guide to fill this in.
        </div>
      )}

      {section === "problems" && m.problems.map((p) => {
        const d = p.data;
        return (
          <div key={p.id} className="card mem-card">
            <div className="mem-head">
              <Badge tone={d.status === "fixed" ? "ok" : "bad"}>{d.status === "fixed" ? "fixed" : "still failing"}</Badge>
              <b className="mem-title">{p.title}</b>
              <span className="faint mem-when">{when(d.firstFailedAt)}</span>
            </div>
            <div className="mem-body">
              <div>
                Failed {d.failedRuns} time{d.failedRuns === 1 ? "" : "s"}{d.failingTests.length > 1 ? ` (${d.failingTests.length} tests)` : ""}
                {d.fixCounts && <> · then passed: {d.fixCounts.passed ?? "?"} passed, {d.fixCounts.failed} failed</>}
                {" "}{p.sources.filter((s) => s.eventId != null).slice(0, 6).map((s, i) => evBtn(s.eventId, s.basis.startsWith("failing") ? `fail ${i + 1}` : s.basis.startsWith("first") ? "pass" : s.basis.startsWith("commit") ? "commit" : "note"))}
              </div>
              {d.failingTests.length > 1 && <ul className="plain small">{d.failingTests.map((t: string) => <li key={t}>{t}</li>)}</ul>}
              {d.causeNotes.map((n: any) => (
                <div key={n.eventId} className="mem-note"><span className={`badge ${KIND.agent_stated.tone}`}>Agent said</span> {n.text} {evBtn(n.eventId, "note")}</div>
              ))}
              {d.filesChangedBetween.length > 0 && <div className="small muted">Changed in between: <code>{d.filesChangedBetween.join(", ")}</code></div>}
              {d.commitsBetween.map((c: any) => <div key={c.sha} className="small muted">Committed in between: <code>{c.sha}</code> {c.message} {evBtn(c.eventId, "commit")}</div>)}
              {d.commitAfterFix && (
                <div className="small muted"><Badge tone="warn">Inferred</Badge> Committed right after the fix: <code>{d.commitAfterFix.sha}</code> {d.commitAfterFix.message}
                  {d.commitAfterFix.files.length > 0 && <> — <code>{d.commitAfterFix.files.slice(0, 5).join(", ")}{d.commitAfterFix.files.length > 5 ? "…" : ""}</code></>}</div>
              )}
              <div className="mem-foot"><span className="faint">{d.basis}</span><span className="chips">{d.episodes.map(ep)}</span></div>
            </div>
          </div>
        );
      })}

      {section === "components" && (
        <div className="grid cols-2">
          {m.components.map((c) => {
            const d = c.data;
            return (
              <div key={c.id} className="card mem-card">
                <div className="mem-head"><b className="mem-title mono">{c.title}</b></div>
                <div className="mem-stats">
                  <span><b>{d.commits}</b> commits</span><span><b>{d.fileCount}</b> files</span><span><b>{d.fileChanges}</b> edits seen</span>
                  <span className="ok">+{d.linesAdded}</span><span className="bad">−{d.linesRemoved}</span>
                </div>
                <ul className="plain small mono">{d.files.slice(0, 6).map((f: any) => <li key={f.path}>{f.path} <span className="faint">×{f.changes}</span></li>)}</ul>
                {d.fileCount > 6 && <div className="faint small">and {d.fileCount - 6} more files</div>}
                <div className="mem-foot"><span className="faint">Changed {when(d.firstChanged)} – {when(d.lastChanged)}</span>
                  <span className="chips">{d.episodes.slice(-8).map(ep)}{d.episodes.length > 8 && <span className="faint">+{d.episodes.length - 8}</span>}</span></div>
              </div>
            );
          })}
        </div>
      )}

      {section === "decisions" && m.decisions.map((x) => {
        const k = (x.data.claimKind ?? "observed") as keyof typeof KIND;
        return (
          <div key={x.id} className="claim mem-line">
            <span className={`badge ${KIND[k]?.tone ?? "muted"}`} title={KIND[k]?.help}>{KIND[k]?.label ?? k}</span>
            <span>{x.data.text} <span className="refs">{x.sources.filter((s) => s.eventId != null).slice(0, 4).map((s, i) => evBtn(s.eventId, `ev ${i + 1}`))}</span> <span className="chips">{ep(x.data.episode)}</span></span>
          </div>
        );
      })}

      {section === "concepts" && (
        <dl className="concepts">
          {m.concepts.map((c) => (
            <div key={c.id} className="mem-line" style={{ display: "block" }}>
              <dt>{c.title} <span className="chips">{c.data.episodes.map(ep)}</span></dt>
              <dd>{c.data.explanation}</dd>
            </div>
          ))}
        </dl>
      )}

      {section === "questions" && m.questions.map((q) => (
        <div key={q.id} className="mem-line">
          <span>{withRefs(q.data.text, q.data.refs ?? {}, onEvent)} <span className="chips">{(q.data.episodes as string[]).slice(0, 6).map(ep)}</span></span>
          <div className="faint small">{q.data.from}</div>
        </div>
      ))}

      {count(section) === 0 && <div className="empty"><b>Nothing here yet</b>{sparse(section) ? "Explain episodes in the Guide first." : "No captured activity of this kind."}</div>}
    </div>
  );
}

/** Turns "E8" mentions into buttons that open the events they referred to. */
function withRefs(text: string, refs: Record<string, number[]>, onEvent: (id: number) => void) {
  return text.split(/(\bE\d+\b)/g).map((part, i) =>
    refs[part]?.length ? <button key={i} className="ref" onClick={() => onEvent(refs[part]![0]!)} title="Open the evidence">{part}</button> : <span key={i}>{part}</span>,
  );
}
