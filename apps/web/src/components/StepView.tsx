import type { Claim, ClaimKind, StoredExplanation } from "../api";

export const KIND: Record<ClaimKind, { label: string; tone: string; help: string }> = {
  observed: { label: "Observed", tone: "ok", help: "Shown directly by the cited evidence" },
  inferred: { label: "Inferred", tone: "warn", help: "A reasonable conclusion from the evidence, not shown directly" },
  agent_stated: { label: "Agent said", tone: "accent", help: "The AI's own account of its reasoning; not verified" },
  background: { label: "Background", tone: "muted", help: "General knowledge to help you understand; not a claim about this project" },
};

/**
 * Renders one explained step from its structured form. Every claim shows its kind, and every
 * evidence reference opens the events behind it.
 */
export function StepView({ x, onRef }: { x: StoredExplanation; onRef: (eventId: number) => void }) {
  const s = x.step;
  const flagged = new Set(x.validation.issues.filter((i) => i.severity === "error" && i.claim).map((i) => i.claim!));
  const refBtn = (ref: string) => {
    const ev = x.evidence[ref];
    return (
      <button key={ref} className="ref" disabled={!ev?.eventIds.length} title={ev ? `${ev.kind} · open the evidence` : "Not in the evidence"}
        onClick={() => ev?.eventIds[0] != null && onRef(ev.eventIds[0])}>
        {ref}
      </button>
    );
  };
  const claims = (title: string, list: Claim[], note?: string) =>
    list.length > 0 && (
      <section className="step-section">
        <h3>{title}{note && <span className="faint"> · {note}</span>}</h3>
        <ul className="claims">
          {list.map((c, i) => (
            <li key={i} className={`claim ${c.kind}`}>
              <span className={`badge ${KIND[c.kind].tone}`} title={KIND[c.kind].help}>{KIND[c.kind].label}</span>
              <span className="claim-text">
                {c.text}
                {c.evidence.length > 0 && <span className="refs">{c.evidence.map(refBtn)}</span>}
                {flagged.has(c.text.slice(0, 80)) && <span className="badge bad" style={{ marginLeft: 6 }} title="Failed an automatic check; see Checks below">check failed</span>}
              </span>
            </li>
          ))}
        </ul>
      </section>
    );

  return (
    <article className="step">
      <h2 className="step-title">{s.title}</h2>
      <div className="ai-notice">
        <b>Written by AI from captured evidence. It can be wrong.</b> Each statement is labeled{" "}
        {(Object.keys(KIND) as ClaimKind[]).map((k) => <span key={k} className={`badge ${KIND[k].tone}`} title={KIND[k].help} style={{ marginRight: 4 }}>{KIND[k].label}</span>)}
        and the <span className="ref static">E3</span> buttons open the events behind it.
      </div>
      {x.stale && <div className="notice" style={{ marginBottom: 14 }}>New evidence has been captured for this episode since this was written. Explain again to include it.</div>}
      <p className="step-summary">{s.summary}</p>
      {claims("What happened", s.whatHappened)}
      {claims("Why it mattered", s.whyItMattered)}
      {claims("How it works", s.howItWorks)}
      {claims("What changed", s.whatChanged, "from captured facts")}
      {claims("Decisions", s.decisions)}
      {claims("Verification", s.verification, "from captured test runs")}
      {s.generatedBy !== "facts" && s.verification.length === 0 && (
        <section className="step-section"><h3>Verification</h3><p className="muted">No test runs were captured for this work.</p></section>
      )}
      {s.concepts.length > 0 && (
        <section className="step-section">
          <h3>Concepts to understand</h3>
          <dl className="concepts">
            {s.concepts.map((c) => <div key={c.term}><dt>{c.term}</dt><dd>{c.explanation}</dd></div>)}
          </dl>
        </section>
      )}
      {s.uncertainty.length > 0 && (
        <section className="step-section">
          <h3>What is uncertain</h3>
          <ul className="plain">{s.uncertainty.map((u, i) => <li key={i}>{u}</li>)}</ul>
        </section>
      )}
      {x.validation.issues.length > 0 && (
        <section className="step-section">
          <h3>Checks</h3>
          <ul className="plain">
            {x.validation.issues.map((p, i) => (
              <li key={i}><span className={`badge ${p.severity === "error" ? "bad" : "warn"}`}>{p.severity === "error" ? "failed" : "note"}</span> {p.section}{p.claim ? ` — “${p.claim}…”` : ""}: {p.message}</li>
            ))}
          </ul>
          <p className="faint" style={{ fontSize: 12.5 }}>Automatic checks catch known kinds of mistakes. Passing them does not mean every sentence is correct.</p>
        </section>
      )}
      <footer className="step-foot">
        {s.generatedBy === "facts"
          ? "No model was used: this episode changed nothing, so Dena summarised the captured messages."
          : `Written by ${x.model ?? "unknown model"} · ${x.depth}${x.costUsd ? ` · est. usage $${x.costUsd.toFixed(3)}` : ""}${x.batched ? " (shared call)" : ""}${x.attempts > 1 ? " · needed 1 repair" : ""}`}
        {" · "}{x.validation.counts.observed} observed, {x.validation.counts.inferred} inferred, {x.validation.counts.agent_stated} agent-said, {x.validation.counts.background} background
        {" · "}{Math.round(x.validation.citedShare * 100)}% of project statements have valid evidence
      </footer>
    </article>
  );
}
