import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Badge } from "./Bits";
import { tokenRange, when } from "../format";

interface Outdated { type: "step" | "wiki"; key: string; title: string; reason: string; userEdited: boolean; chars: number }
interface Job { id: number; type: string; key: string; status: string; attempts: number; nextAt: string; lastError: string | null; result: string | null; updatedAt: string }
interface Updates {
  outdated: Outdated[];
  estimate: { estimatedUsd: number | null; modelCalls: number } | null;
  tokens: { prompt: number; output: number; low: number; high: number; calibrated: boolean; basis: string };
  jobs: Job[];
  running: boolean;
  settings: { model: string | null; maxUsdPerRun: number | null };
}

const STATUS_TONE: Record<string, string> = { done: "ok", failed: "bad", running: "accent", queued: "muted", cancelled: "muted" };

/**
 * Which written pages and steps are behind the evidence, and a queue that updates only those.
 * Nothing runs without a click; edits you made are kept and the update waits as a proposal.
 */
export function GuideUpdates({ projectId }: { projectId: string }) {
  const [u, setU] = useState<Updates | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => api<Updates>(`projects/${projectId}/updates`).then(setU, (e) => setErr(String(e.message))), [projectId]);
  useEffect(() => {
    load();
  }, [load]);
  const active = !!u && (u.running || u.jobs.some((j) => j.status === "queued" || j.status === "running"));
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [active, load]);

  if (!u) return err ? <div className="error">{err}</div> : null;
  const post = async (path: string) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`projects/${projectId}/updates/${path}`, { method: "POST", body: {} });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const recent = u.jobs.slice(0, 8);
  const wikiCount = u.outdated.filter((o) => o.type === "wiki").length;

  return (
    <div className="card">
      <h2>Keeping the guide current</h2>
      {err && <div className="error">{err}</div>}
      {u.outdated.length === 0 && !active && <p className="muted" style={{ margin: 0 }}>Everything written so far matches the captured evidence.</p>}
      {u.outdated.length > 0 && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            {u.outdated.length} written {u.outdated.length === 1 ? "item is" : "items are"} behind the evidence. Updating rewrites only these, with <b>{u.settings.model ?? "your default model"}</b>
: {tokenRange(u.tokens.low, u.tokens.high)} in total
            {u.estimate?.estimatedUsd != null ? ` (API-equivalent about $${(u.estimate.estimatedUsd + wikiCount * 0.006).toFixed(2)})` : ""}.
            {u.outdated.some((o) => o.userEdited) && " Items you edited keep your version; their update waits for your choice."}
          </p>
          <div className="notes-list">
            {u.outdated.slice(0, 8).map((o) => (
              <div key={`${o.type}:${o.key}`} className="note-row">
                <Badge>{o.type === "step" ? "Step" : "Page"}</Badge>
                <span className="small" style={{ flex: 1 }}>{o.title}</span>
                <span className="faint small">{o.reason}</span>
                {o.userEdited && <Badge tone="you">you edited</Badge>}
              </div>
            ))}
            {u.outdated.length > 8 && <div className="faint small">and {u.outdated.length - 8} more</div>}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn primary" disabled={busy || active} onClick={() => post("run")}>{active ? "Updating…" : `Update ${u.outdated.length === 1 ? "it" : `all ${u.outdated.length}`}`}</button>
            {u.settings.maxUsdPerRun != null && <span className="faint small">Stops before ${u.settings.maxUsdPerRun} of usage.</span>}
          </div>
        </>
      )}
      {recent.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="row" style={{ justifyContent: "space-between", width: "100%" }}>
            <span className="faint small">Recent updates</span>
            {active && <button className="linkish" onClick={() => post("cancel")}>Cancel waiting updates</button>}
          </div>
          {recent.map((j) => (
            <div key={j.id} className="note-row">
              <Badge tone={STATUS_TONE[j.status] ?? "muted"}>{j.status === "queued" && j.attempts ? "retrying" : j.status}</Badge>
              <span className="small mono" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.type === "step" ? "step" : j.key}</span>
              <span className="faint small">{j.result ?? (j.lastError ? `${j.lastError.slice(0, 80)}${j.status === "queued" ? ` · next try ${when(j.nextAt)}` : ""}` : when(j.updatedAt))}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
