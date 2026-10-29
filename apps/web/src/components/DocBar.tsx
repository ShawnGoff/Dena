import { useState } from "react";
import { api } from "../api";
import { Badge } from "./Bits";
import { when } from "../format";

export interface DocRevisionLite { id: number; origin: "generated" | "user" | "restored"; status: string; note: string | null; createdAt: string; model: string | null; userEdited: boolean }
export interface DocNote { id: number; kind: "context" | "incorrect" | "incomplete"; target: string | null; text: string; status: "open" | "dismissed"; createdAt: string }
export interface DocResponse<C> {
  active: { id: number; origin: string; content: C; meta: Record<string, any>; createdAt: string } | null;
  proposed: { id: number; content: C; meta: Record<string, any>; createdAt: string; note: string | null } | null;
  stale: boolean;
  history: DocRevisionLite[];
  notes: DocNote[];
}

const ORIGIN: Record<string, string> = { generated: "AI", user: "You", restored: "Restored" };

/**
 * Everything around a document that is about its versions: an AI update waiting for you,
 * the revision history with restore, and (for episode steps) your notes and context.
 */
export function DocBar<C>({ projectId, type, docKey, doc, onChanged, viewing, onView, allowContext }: {
  projectId: string; type: "step" | "wiki"; docKey: string; doc: DocResponse<C>; onChanged: () => void;
  viewing: number | null; onView: (id: number | null) => void; allowContext: boolean;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [context, setContext] = useState("");
  const post = async (action: string, body: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`projects/${projectId}/doc/${action}`, { method: "POST", body: { type, key: docKey, ...body } });
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
      {err && <div className="error">{err}</div>}
      {doc.proposed && (
        <div className="notice proposal">
          <b>An AI update is waiting.</b> It was written from newer evidence while your edited version was showing, so your version stays until you choose.
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
          <div className="small"><b>Add context</b> <span className="faint">— something the capture could not see (why you chose something, what you meant). It is used the next time this episode is explained, labeled "You said".</span></div>
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
          {type === "step" && doc.stale && <div className="faint small">Your notes are used when this episode is next explained ("Update with new evidence").</div>}
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
