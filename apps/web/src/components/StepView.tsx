import type { Claim, ClaimKind, StoredExplanation } from "../api";
import { ClaimList, KIND } from "./ClaimList";
import { tokenLine } from "../format";

export { KIND };

type ClaimSection = "whatHappened" | "whyItMattered" | "howItWorks" | "whatChanged" | "decisions" | "verification";

/**
 * Renders one explained step from its structured form. Every claim shows its kind, and every
 * evidence reference opens the events behind it. When editable, statements can be rewritten,
 * marked incorrect or removed; each change is saved as a new revision by the caller.
 */
export function StepView({ x, onRef, editable, onChange, onMarkIncorrect }: {
  x: StoredExplanation;
  onRef: (eventId: number) => void;
  editable?: boolean;
  onChange?: (next: StoredExplanation["step"], note: string) => void;
  onMarkIncorrect?: (claim: Claim, note: string) => void;
}) {
  const s = x.step;
  const flagged = new Set(x.validation.issues.filter((i) => i.severity === "error" && i.claim).map((i) => i.claim!));
  const refs = (c: Claim) => c.evidence.map((ref) => {
    const ev = x.evidence[ref];
    return (
      <button key={ref} className="ref" disabled={!ev?.eventIds.length} title={ev ? `${ev.kind} · open the evidence` : "Not in the evidence"}
        onClick={() => ev?.eventIds[0] != null && onRef(ev.eventIds[0])}>
        {ref}
      </button>
    );
  });
  const change = (section: ClaimSection, i: number, next: Claim | null) => {
    const list = [...s[section]];
    const before = list[i]!;
    if (next) list[i] = next;
    else list.splice(i, 1);
    onChange?.({ ...s, [section]: list }, next ? (next.text !== before.text ? "Edited a statement" : "Changed a statement's mark") : `Removed: “${before.text.slice(0, 80)}”`);
  };
  const claims = (title: string, section: ClaimSection, note?: string) =>
    s[section].length > 0 && (
      <section className="step-section">
        <h3>{title}{note && <span className="faint"> · {note}</span>}</h3>
        <ClaimList claims={s[section]} refs={refs} flaggedByChecks={flagged} editable={editable}
          onEdit={(i, next) => change(section, i, next)}
          onMarkIncorrect={(i, n) => {
            const c = s[section][i]!;
            onMarkIncorrect?.(c, n);
            change(section, i, { ...c, flagged: "incorrect" });
          }} />
      </section>
    );

  return (
    <article className="step">
      <h2 className="step-title">{s.title}</h2>
      <div className="ai-notice">
        <b>Written by AI from captured evidence. It can be wrong.</b> Each statement is labeled{" "}
        {(Object.keys(KIND) as ClaimKind[]).map((k) => <span key={k} className={`badge ${KIND[k].tone}`} title={KIND[k].help} style={{ marginRight: 4 }}>{KIND[k].label}</span>)}
        and the <span className="ref static">E3</span> buttons open the events behind it.{editable && " Hover a statement to edit it, mark it incorrect, or remove it."}
      </div>
      <p className="step-summary">{s.summary}</p>
      {claims("What happened", "whatHappened")}
      {claims("Why it mattered", "whyItMattered")}
      {claims("How it works", "howItWorks")}
      {claims("What changed", "whatChanged", "from captured facts")}
      {claims("Decisions", "decisions")}
      {claims("Verification", "verification", "from captured test runs")}
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
      {(x.validation.autoFixes?.length ?? 0) > 0 && (
        <section className="step-section">
          <h3>Fixed automatically</h3>
          <ul className="plain">{x.validation.autoFixes!.map((f, i) => <li key={i}>{f}</li>)}</ul>
          <p className="faint" style={{ fontSize: 12.5 }}>To avoid another model call, Dena fixed these itself. It only removes or weakens statements; it never adds claims.</p>
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
          <p className="faint" style={{ fontSize: 12.5 }}>Automatic checks catch known kinds of mistakes. Passing them does not mean every sentence is correct. Statements you edited are not checked.</p>
        </section>
      )}
      <footer className="step-foot">
        {s.generatedBy === "facts"
          ? "No model was used: this episode changed nothing, so Dena summarised the captured messages."
          : `Written by ${x.model ?? "unknown model"} · ${x.depth}${tokenLine(x.tokens) ? ` · ${tokenLine(x.tokens)}` : ""}${x.costUsd ? ` (API-equivalent $${x.costUsd.toFixed(3)})` : ""}${x.batched ? " · shared call" : ""}${x.attempts > 1 ? " · needed 1 repair" : ""}`}
        {" · "}{x.validation.counts.observed} observed, {x.validation.counts.inferred} inferred, {x.validation.counts.agent_stated} agent-said, {x.validation.counts.background} background
        {" · "}{Math.round(x.validation.citedShare * 100)}% of project statements have valid evidence
      </footer>
    </article>
  );
}
