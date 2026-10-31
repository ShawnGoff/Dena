import { useEffect, useState } from "react";
import { api } from "../api";
import { tokenRange } from "../format";
import { BudgetChoice } from "./BudgetChoice";
import { BusyBar, ModelChoice } from "./BusyBar";

interface Plan {
  steps: number;
  explained: number;
  asInstructions: number;
  missing: string[];
  explainEstimate: { tokensLow: number; tokensHigh: number; modelCalls: number } | null;
  pageEstimate: { low: number; high: number; calibrated: boolean; basis: string };
  written: boolean;
  model: string | null;
}

/**
 * Writing the whole-project tutorial reads every explained step, so it asks first and says what
 * it will cost: the page alone, or the page after explaining the steps not explained yet.
 */
export function TutorialDialog({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [runModel, setRunModel] = useState("");
  const [explainRest, setExplainRest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<Plan>(`projects/${projectId}/tutorial/plan${runModel ? `?model=${runModel}` : ""}`).then(setPlan, (e) => setErr(String(e.message)));
  }, [projectId, runModel]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [busy, onClose]);

  const run = async () => {
    setBusy(true);
    setStopping(false);
    setErr(null);
    try {
      await api(`projects/${projectId}/tutorial/write`, { method: "POST", body: { explainRest, model: runModel || undefined } });
      onDone();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setStopping(true);
    await api(`projects/${projectId}/wiki/stop`, { method: "POST", body: { key: "tutorial" } }).catch(() => {});
  };

  const both = plan?.explainEstimate ? { low: plan.explainEstimate.tokensLow + plan.pageEstimate.low, high: plan.explainEstimate.tokensHigh + plan.pageEstimate.high } : null;
  const stories = plan ? plan.explained - plan.asInstructions : 0;
  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="tut-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="tut-title">{plan?.written ? "Rewrite" : "Write"} the whole-project tutorial?</h2>
        <p>This reads <b>every explained step in your project</b> and turns them into one tutorial that teaches someone to build it from the start.
          It is one of the larger things Dena does, so check the estimate before you continue.</p>
        {!plan && !err && <p className="muted">Working out the estimate…</p>}
        {plan && (
          <>
            <p className="muted small">{plan.explained} of {plan.steps} steps are explained{plan.explained ? `; ${plan.asInstructions} of them as instructions` : ""}.
              {plan.missing.length > 0 && " Steps that are not explained are left out, and the tutorial will say where it has gaps."}</p>
            <label className="choice">
              <input type="radio" name="tut" checked={!explainRest} onChange={() => setExplainRest(false)} />
              <span><b>Use the {plan.explained} steps already explained</b><br /><span className="muted small">{tokenRange(plan.pageEstimate.low, plan.pageEstimate.high)}</span></span>
            </label>
            {plan.missing.length > 0 && both && (
              <label className="choice">
                <input type="radio" name="tut" checked={explainRest} onChange={() => setExplainRest(true)} />
                <span><b>Explain the other {plan.missing.length} steps first, then write it</b><br />
                  <span className="muted small">{tokenRange(both.low, both.high)} in total, in about {plan.explainEstimate!.modelCalls + 1} calls. This can take several minutes.</span></span>
              </label>
            )}
            {plan.missing.length > 0 && explainRest && (
              <div style={{ margin: "4px 0 8px 32px" }}><BudgetChoice projectId={projectId} />
                <span className="faint small" style={{ display: "block" }}>If the budget runs out first, the tutorial is written from the steps explained so far.</span></div>
            )}
            {stories > 0 && <p className="faint small">{stories} explained {stories === 1 ? "step was" : "steps were"} written as a story, before steps became instructions. They are used as they are; rewriting them as instructions on their own pages gives a better tutorial.</p>}
            <p className="faint small">Token estimate {plan.pageEstimate.calibrated ? "" : "uses "}{plan.pageEstimate.basis}. It is a range, not a promise.</p>
          </>
        )}
        {busy && <BusyBar what={explainRest ? "Explaining the remaining steps, then writing the tutorial" : "Writing the tutorial"} onStop={stop} stopping={stopping} />}
        {err && <div className={err.startsWith("Stopped") ? "notice" : "error"}>{err}</div>}
        <div className="row modal-actions">
          <ModelChoice value={runModel} onChange={setRunModel} projectDefault={plan?.model ?? null} />
          <span style={{ flex: 1 }} />
          <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !plan || (!plan.explained && !explainRest)} onClick={run}>Continue</button>
        </div>
      </div>
    </div>
  );
}
