import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Badge } from "./Bits";
import { tokenRange, when } from "../format";
import { useSettingsChanged } from "./ModelSettings";

interface Outdated { type: "step" | "wiki"; key: string; title: string; reason: string; userEdited: boolean; chars: number; waiting: boolean }
interface Job { id: number; type: string; key: string; status: string; attempts: number; nextAt: string; lastError: string | null; result: string | null; updatedAt: string }
interface Updates {
  outdated: Outdated[];
  /** Updates already written for the current evidence, waiting for the owner's review. */
  waiting: Outdated[];
  tokens: { prompt: number; output: number; low: number; high: number; calibrated: boolean; basis: string };
  jobs: Job[];
  running: boolean;
  /** Updates queued before Dena last stopped, which wait for a yes instead of resuming on their own. */
  waitingFromBefore: boolean;
  settings: { model: string | null; maxUsdPerRun: number | null; maxTokensPerRun?: number | null };
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
  useSettingsChanged(load);
  const active = !!u && !u.waitingFromBefore && (u.running || u.jobs.some((j) => j.status === "queued" || j.status === "running"));
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

  return (
    <div className="card">
      <h2>Keeping the guide current</h2>
      {err && <div className="error">{err}</div>}
      {u.waitingFromBefore && (
        <div className="notice" style={{ marginBottom: 10 }}>
          {u.jobs.filter((j) => j.status === "queued").length} {u.jobs.filter((j) => j.status === "queued").length === 1 ? "update was" : "updates were"} still waiting when Dena last stopped.
          They will not run, or use any of your plan, until you say so.
          <span className="row" style={{ marginTop: 8 }}>
            <button className="btn primary" disabled={busy} onClick={() => post("resume")}>Continue them</button>
            <button className="btn" disabled={busy} onClick={() => post("cancel")}>Cancel them</button>
          </span>
        </div>
      )}
      {u.outdated.length === 0 && !u.waiting.length && !active && !u.waitingFromBefore && <p className="muted" style={{ margin: 0 }}>Everything written so far matches the captured evidence.</p>}
      {u.outdated.length > 0 && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            {u.outdated.length} written {u.outdated.length === 1 ? "item is" : "items are"} behind the evidence. Updating keeps every statement whose evidence did not change
            and sends only what changed, with <b>{u.settings.model ?? "your default model"}</b>: {tokenRange(u.tokens.low, u.tokens.high)} in total.
            Each update waits for your review before it is applied.
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
            {u.settings.maxTokensPerRun != null && <span className="faint small">Stops at about {Math.round(u.settings.maxTokensPerRun / 1000)}k tokens; the rest waits for the next run.</span>}
          </div>
        </>
      )}
      {u.waiting.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <span className="faint small">Waiting for your review (open each to apply or keep the current version)</span>
          {u.waiting.slice(0, 8).map((o) => (
            <div key={`w:${o.type}:${o.key}`} className="note-row">
              <Badge tone="warn">{o.type === "step" ? "Step" : "Page"}</Badge>
              <span className="small" style={{ flex: 1 }}>{o.title}</span>
            </div>
          ))}
        </div>
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
