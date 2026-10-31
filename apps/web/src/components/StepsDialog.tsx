import { useEffect, useState } from "react";
import { api } from "../api";
import { tokenRange } from "../format";
import { BudgetChoice } from "./BudgetChoice";
import { BusyBar, ModelChoice } from "./BusyBar";

interface Plan {
  steps: number;
  explained: number;
  missing: number;
  estimate: { episodes: number; cached: number; factsOnly: number; modelCalls: number; tokensLow: number; tokensHigh: number; tokenBasis: string; tokensCalibrated: boolean } | null;
  progress: { done: number; total: number } | null;
  settings: { model: string | null; depth: string };
}

/**
 * Explains every step not explained yet, in as few calls as possible. It shows the estimate first,
 * stops at the budget you choose (the rest waits for the next run), and can be stopped any time;
 * steps finished before stopping are kept.
 */
export function StepsDialog({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [runModel, setRunModel] = useState("");
  const [budget, setBudget] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const q = `projects/${projectId}/guide/plan${runModel ? `?model=${runModel}` : ""}`;
  useEffect(() => {
    api<Plan>(q).then(setPlan, (e) => setErr(String(e.message)));
  }, [q]);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => api<Plan>(q).then((p) => p.progress && setProgress(p.progress), () => {}), 2000);
    return () => clearInterval(t);
  }, [busy, q]);
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
      const r = await api<{ explained: number; leftForNextRun: number; spentTokens: number; calls: number }>(`projects/${projectId}/guide/explain-rest`, { method: "POST", body: { model: runModel || undefined } });
      setResult(`Explained ${r.explained} ${r.explained === 1 ? "step" : "steps"} in ${r.calls} ${r.calls === 1 ? "call" : "calls"}, using about ${Math.round(r.spentTokens / 1000)}k tokens.`
        + (r.leftForNextRun ? ` ${r.leftForNextRun} ${r.leftForNextRun === 1 ? "step was" : "steps were"} left for the next run, to stay within the budget.` : ""));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      onDone();
    }
  };
  const stop = async () => {
    setStopping(true);
    await api(`projects/${projectId}/guide/stop`, { method: "POST", body: {} }).catch(() => {});
  };

  const est = plan?.estimate;
  const free = est ? est.cached + est.factsOnly : 0;
  const perRun = budget && est && est.modelCalls ? Math.max(1, Math.floor(budget / Math.max(1, (est.tokensLow + est.tokensHigh) / 2 / est.modelCalls))) : null;
  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="steps-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="steps-title">Explain the remaining steps?</h2>
        {!plan && !err && <p className="muted">Working out the estimate…</p>}
        {plan && !result && (plan.missing === 0 ? <p>Every step that changed something is already explained. Nothing to send.</p> : (
          <>
            <p><b>{plan.explained} of {plan.steps}</b> steps are explained. This explains the other <b>{plan.missing}</b>, in as few calls as possible
              ({plan.settings.depth === "concise" ? "Concise" : "Thorough"}).</p>
            {est && (
              <p className="choice-like">
                {est.modelCalls > 0 ? <><b>{tokenRange(est.tokensLow, est.tokensHigh)}</b> in about {est.modelCalls} {est.modelCalls === 1 ? "call" : "calls"}</> : <b>No model needed</b>}
                {free > 0 && <>; {free} {free === 1 ? "step is" : "steps are"} written from the facts, free</>}.
                <span className="faint small" style={{ display: "block" }}>Token estimate {est.tokensCalibrated ? "" : "uses "}{est.tokenBasis}. It is a range, not a promise.</span>
              </p>
            )}
            <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
              <BudgetChoice projectId={projectId} onChange={setBudget} />
              {perRun && est && perRun < est.modelCalls && <span className="faint small">About {perRun} {perRun === 1 ? "call" : "calls"} per run; run it again to continue.</span>}
            </div>
          </>
        ))}
        {busy && (
          <>
            <BusyBar what={progress ? `${progress.done} of ${progress.total} steps done` : "Starting"} onStop={stop} stopping={stopping} />
            <p className="faint small">Stopping ends the current call. Steps already explained are kept.</p>
          </>
        )}
        {result && <div className="notice">{result}</div>}
        {err && <div className={err.startsWith("Stopped") ? "notice" : "error"}>{err}</div>}
        <div className="row modal-actions">
          {!result && plan && plan.missing > 0 && <ModelChoice value={runModel} onChange={setRunModel} projectDefault={plan.settings.model} />}
          <span style={{ flex: 1 }} />
          <button className="btn" disabled={busy} onClick={onClose}>{result || (plan && !plan.missing) ? "Close" : "Cancel"}</button>
          {!result && plan && plan.missing > 0 && <button className="btn primary" disabled={busy} onClick={run}>Continue</button>}
        </div>
      </div>
    </div>
  );
}
