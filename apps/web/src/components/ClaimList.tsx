import { useState, type ReactNode } from "react";
import type { Claim, ClaimKind } from "../api";

export const KIND: Record<ClaimKind, { label: string; tone: string; help: string }> = {
  observed: { label: "Observed", tone: "ok", help: "Shown directly by the cited evidence" },
  inferred: { label: "Inferred", tone: "warn", help: "A reasonable conclusion from the evidence, not shown directly" },
  agent_stated: { label: "Agent said", tone: "accent", help: "The AI's own account of its reasoning; not verified" },
  owner_stated: { label: "You said", tone: "you", help: "Context you added; your account, not a record of events" },
  background: { label: "Background", tone: "muted", help: "General knowledge to help you understand; not a claim about this project" },
};

/**
 * A list of labeled statements. When editable, each statement can be rewritten, marked
 * incorrect (it stays visible, struck through, and the note feeds the next rewrite), or removed.
 */
export function ClaimList({ claims, refs, flaggedByChecks, editable, onEdit, onMarkIncorrect }: {
  claims: Claim[];
  refs: (c: Claim) => ReactNode;
  flaggedByChecks?: Set<string>;
  editable?: boolean;
  onEdit?: (index: number, next: Claim | null) => void;
  onMarkIncorrect?: (index: number, note: string) => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [flagging, setFlagging] = useState<number | null>(null);

  return (
    <ul className="claims">
      {claims.map((c, i) => (
        <li key={i} className={`claim ${c.kind} ${c.flagged ? "flagged" : ""}`}>
          <span className={`badge ${KIND[c.kind]?.tone ?? "muted"}`} title={KIND[c.kind]?.help}>{KIND[c.kind]?.label ?? c.kind}</span>
          <span className="claim-text">
            {editing === i ? (
              <span className="claim-edit">
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(8, Math.max(2, Math.ceil(draft.length / 90)))} autoFocus />
                <span className="row">
                  <button className="btn primary" disabled={!draft.trim()} onClick={() => { onEdit?.(i, { ...c, text: draft.trim(), edited: true }); setEditing(null); }}>Save</button>
                  <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
                  <span className="faint small">Your wording replaces the AI's. Its label and citations stay, and it is shown as edited by you.</span>
                </span>
              </span>
            ) : (
              <>
                <span className="claim-body">{c.text}</span>
                {c.evidence.length > 0 && <span className="refs">{refs(c)}</span>}
                {c.edited && <span className="badge you" style={{ marginLeft: 6 }} title="You rewrote this statement; your words are not checked against evidence">edited by you</span>}
                {c.flagged === "incorrect" && <span className="badge bad" style={{ marginLeft: 6 }}>you marked this incorrect</span>}
                {flaggedByChecks?.has(c.text.slice(0, 80)) && <span className="badge bad" style={{ marginLeft: 6 }} title="Failed an automatic check; see Checks">check failed</span>}
                {editable && (
                  <span className="claim-actions">
                    <button onClick={() => { setDraft(c.text); setEditing(i); }}>Edit</button>
                    {c.flagged !== "incorrect"
                      ? <button onClick={() => setFlagging(flagging === i ? null : i)}>Incorrect</button>
                      : <button onClick={() => onEdit?.(i, { ...c, flagged: undefined })}>Unmark</button>}
                    <button onClick={() => onEdit?.(i, null)}>Remove</button>
                  </span>
                )}
                {flagging === i && <FlagForm onCancel={() => setFlagging(null)} onSubmit={(note) => { onMarkIncorrect?.(i, note); setFlagging(null); }} />}
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function FlagForm({ onSubmit, onCancel }: { onSubmit: (note: string) => void; onCancel: () => void }) {
  const [note, setNote] = useState("");
  return (
    <span className="claim-edit">
      <textarea placeholder="What is wrong, or what actually happened? (optional, but it helps the next rewrite)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} autoFocus />
      <span className="row">
        <button className="btn danger" onClick={() => onSubmit(note.trim())}>Mark incorrect</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </span>
    </span>
  );
}
