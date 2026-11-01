import { useState } from "react";
import { api } from "../api";
import { Badge } from "./Bits";
import { tokenRange, when } from "../format";
import { BusyBar, ModelChoice } from "./BusyBar";

export interface DocRevisionLite { id: number; origin: "generated" | "user" | "restored"; status: string; note: string | null; createdAt: string; model: string | null; userEdited: boolean }
export interface DocNote { id: number; kind: "context" | "incorrect" | "incomplete"; target: string | null; text: string; status: "open" | "dismissed"; createdAt: string }
export interface DocResponse<C> {
  active: { id: number; origin: string; content: C; meta: Record<string, any>; createdAt: string } | null;
  proposed: { id: number; content: C; meta: Record<string, any>; createdAt: string; note: string | null } | null;
  stale: boolean;
  /** What a targeted update would do now (only when the document is behind and nothing is waiting). */
  update: { kept: number; review: number; fresh: number; send: number; of: number; needsModel: boolean; estimate: { low: number; high: number; calibrated: boolean; basis: string } | null } | null;
  busy?: boolean;
  history: DocRevisionLite[];
  notes: DocNote[];
}

const ORIGIN: Record<string, string> = { generated: "AI", user: "You", restored: "Restored" };

/**
 * Everything around a document that is about its versions: an AI update waiting for you,
 * the revision history with restore, and (for episode steps) your notes and context.
 */
export function DocBar<C>({ projectId, type, docKey, doc, onChanged, viewing, onView, allowContext, onRewrite, projectModel }: {
  projectId: string; type: "step" | "wiki"; docKey: string; doc: DocResponse<C>; onChanged: () => void;
  viewing: number | null; onView: (id: number | null) => void; allowContext: boolean;
  /** Rewrites the whole document from scratch (the alternative to a targeted update). */
  onRewrite?: () => void; projectModel?: string | null;
}) {
  const [updating, setUpdating] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [runModel, setRunModel] = useState("");
  const update = async () => {
    setUpdating(true);
    setStopping(false);
    setErr(null);
    try {
      await api(`projects/${projectId}/doc/update`, { method: "POST", body: { type, key: docKey, model: runModel || undefined } });
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUpdating(false);
    }
  };
  const stop = async () => {
    setStopping(true);
    const path = type === "step" ? `episodes/${encodeURIComponent(docKey)}/stop` : "wiki/stop";
    await api(`projects/${projectId}/${path}`, { method: "POST", body: { key: docKey } }).catch(() => {});
  };
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [context, setContext] = useState("");
  const post = async (action: string, body: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`projects/${projectId}/doc/${action}`, { method: "POST", body: { type, key: docKey, ...body } });
      // Restoring or adopting the version on screen makes it the current one: show it as such.
      if (action === "restore" || action === "adopt" || action === "decline") onView(null);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const openNotes = doc.notes.filter((n) => n.status === "open");

  return (
    <div className="docbar">
      {updating && <BusyBar what="Updating with the new activity" onStop={stop} stopping={stopping} />}
      {err && <div className={err.startsWith("Stopped") ? "notice" : "error"}>{err}</div>}
      {doc.stale && !doc.proposed && viewing == null && doc.update && (
        <div className="notice update-offer">
          <b>New activity{doc.notes.some((n) => n.status === "open") ? " or your notes" : ""} arrived since this was written.</b>{" "}
          {doc.update.needsModel
            ? <>A targeted update keeps the {doc.update.kept} {doc.update.kept === 1 ? "statement" : "statements"} whose sources did not change{doc.update.review ? `, re-checks the ${doc.update.review} whose sources changed,` : ""} and adds what is new. It sends {doc.update.send} of {doc.update.of} {type === "step" ? "sources" : "sources"}{doc.update.estimate ? `: ${tokenRange(doc.update.estimate.low, doc.update.estimate.high)}` : ""}.
              You will see what it adds, changes and removes before anything is applied.</>
            : <>Only facts Dena counts itself changed, so no model is needed. You will see the changes before they are applied.</>}
          <span className="row" style={{ marginTop: 8 }}>
            {doc.update.needsModel && <ModelChoice value={runModel} onChange={setRunModel} projectDefault={projectModel ?? null} />}
            <button className="btn primary" disabled={updating || doc.busy} onClick={update}>Update with new activity</button>
            {onRewrite && <button className="btn" disabled={updating || doc.busy} onClick={onRewrite} title="Write the whole document again from all its sources">Rewrite from scratch</button>}
          </span>
        </div>
      )}
      {doc.proposed?.meta.targeted && (
        <div className="notice proposal">
          <b>An update from new activity is ready for review.</b> Statements whose sources did not change were kept as they are{doc.proposed.meta.userEdited ? ", including yours" : ""}.
          <UpdateDiffView diff={doc.proposed.meta.diff} type={type} />
          <span className="row">
            <button className="btn" onClick={() => onView(viewing === doc.proposed!.id ? null : doc.proposed!.id)}>{viewing === doc.proposed.id ? "Back to the current version" : "Show it in full"}</button>
            <button className="btn primary" disabled={busy} onClick={() => post("adopt", { id: doc.proposed!.id })}>Apply update</button>
            <button className="btn" disabled={busy} onClick={() => post("decline", { id: doc.proposed!.id })}>Keep the current version</button>
          </span>
          <span className="faint small">Either way, both versions stay in the history.</span>
        </div>
      )}
      {doc.proposed && !doc.proposed.meta.targeted && (
        <div className="notice proposal">
          <b>An AI update is waiting.</b> It was written from newer activity while your own version (edited or restored) was showing, so yours stays until you choose.
          <span className="row">
            <button className="btn" onClick={() => onView(viewing === doc.proposed!.id ? null : doc.proposed!.id)}>{viewing === doc.proposed.id ? "Back to your version" : "Show the AI update"}</button>
            <button className="btn primary" disabled={busy} onClick={() => post("adopt", { id: doc.proposed!.id })}>Use the AI update</button>
            <button className="btn" disabled={busy} onClick={() => post("decline", { id: doc.proposed!.id })}>Keep mine</button>
          </span>
          <span className="faint small">Either way, both versions stay in the history.</span>
        </div>
      )}
      {viewing && viewing !== doc.proposed?.id && (
        <div className="notice">You are looking at an earlier version (read-only). <button className="btn" onClick={() => onView(null)}>Back to the current version</button></div>
      )}

      {allowContext && (
        <div className="context-box">
          <div className="small"><b>Add context</b> <span className="faint">— something the capture could not see (why you chose something, what you meant). It is used the next time this step is explained, labeled "You said".</span></div>
          <textarea rows={2} value={context} onChange={(e) => setContext(e.target.value)} placeholder="e.g. We kept split(',') on purpose for the prototype; quoting came later." />
          <span className="row"><button className="btn" disabled={busy || !context.trim()} onClick={async () => { await post("note", { kind: "context", text: context.trim() }); setContext(""); }}>Add</button></span>
        </div>
      )}
      {openNotes.length > 0 && (
        <div className="notes-list">
          {openNotes.map((n) => (
            <div key={n.id} className="note-row">
              <Badge tone={n.kind === "context" ? "you" : "bad"}>{n.kind === "context" ? "Your context" : "You marked incorrect"}</Badge>
              <span className="small">{n.target ? <>“{n.target.slice(0, 120)}{n.target.length > 120 ? "…" : ""}” </> : null}{n.text && <span className="muted">{n.target ? "— " : ""}{n.text}</span>}</span>
              <button className="close" title="Remove this note" onClick={() => post("dismiss-note", { id: n.id })}>×</button>
            </div>
          ))}
          {type === "step" && doc.stale && <div className="faint small">Your notes are used when this step is next explained ("Update with new activity").</div>}
        </div>
      )}

      <button className="linkish" onClick={() => setShowHistory((v) => !v)}>{showHistory ? "Hide" : "Show"} history ({doc.history.length} version{doc.history.length === 1 ? "" : "s"})</button>
      {showHistory && (
        <div className="history">
          {doc.history.map((h) => (
            <div key={h.id} className={`history-row ${h.status}`}>
              <Badge tone={h.origin === "user" ? "you" : h.origin === "restored" ? "warn" : "muted"}>{ORIGIN[h.origin]}</Badge>
              <span className="small">{when(h.createdAt)}{h.model && h.origin === "generated" ? ` · ${h.model}` : ""}{h.note ? ` · ${h.note}` : ""}</span>
              <span className="faint small">{h.status === "active" ? "current" : h.status}</span>
              <span className="row" style={{ marginLeft: "auto" }}>
                {h.status !== "active" && <button className="btn" onClick={() => onView(viewing === h.id ? null : h.id)}>{viewing === h.id ? "Hide" : "View"}</button>}
                {h.status !== "active" && <button className="btn" disabled={busy} onClick={() => post("restore", { id: h.id })}>Restore</button>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const STEP_SECTION: Record<string, string> = {
  whatHappened: "What happened", whyItMattered: "Why it mattered", howItWorks: "How it works", decisions: "Decisions", whatChanged: "What changed", verification: "How it was verified",
};
interface Diff {
  kept: number;
  added: { section: string; text: string }[];
  changed: { section: string; text: string; before: string }[];
  removed: { section: string; text: string }[];
  summary: { before: string; after: string } | null;
  title: { before: string; after: string } | null;
  sent: { items: number; of: number; statements: number };
}

/** What a targeted update adds, changes and removes, statement by statement. */
export function UpdateDiffView({ diff, type }: { diff: Diff; type: "step" | "wiki" }) {
  const label = (s: string) => (type === "step" ? STEP_SECTION[s] ?? s : s);
  const nothing = !diff.added.length && !diff.changed.length && !diff.removed.length && !diff.summary && !diff.title;
  return (
    <div className="diff-view">
      <div className="faint small">
        {diff.kept} kept · {diff.added.length} added · {diff.changed.length} changed · {diff.removed.length} removed
        {diff.sent.items ? ` · sent ${diff.sent.items} of ${diff.sent.of} ${type === "step" ? "sources" : "sources"}` : " · no model call"}
      </div>
      {nothing && <p className="muted small">No statements change; only Dena's own counts were refreshed.</p>}
      {diff.title && <div className="diff-row changed"><span className="diff-tag">Title</span><span><del>{diff.title.before}</del> → {diff.title.after}</span></div>}
      {diff.summary && <div className="diff-row changed"><span className="diff-tag">Summary</span><span><del>{diff.summary.before}</del><br />{diff.summary.after}</span></div>}
      {diff.changed.map((c, i) => <div key={`c${i}`} className="diff-row changed"><span className="diff-tag">Changed · {label(c.section)}</span><span><del>{c.before}</del><br />{c.text}</span></div>)}
      {diff.added.map((c, i) => <div key={`a${i}`} className="diff-row added"><span className="diff-tag">Added · {label(c.section)}</span><span>{c.text}</span></div>)}
      {diff.removed.map((c, i) => <div key={`r${i}`} className="diff-row removed"><span className="diff-tag">Removed · {label(c.section)}</span><span><del>{c.text}</del></span></div>)}
    </div>
  );
}
