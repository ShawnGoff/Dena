import { useCallback, useEffect, useState } from "react";
import { api, type Project } from "../api";
import { when } from "../format";

interface Folder { path: string; sessions: number; lastUsed: string; firstSeen: string }
interface Added {
  project: Project;
  imported: { events: number; from: string | null; to: string | null; conversations: number; prompts: number; commits: number };
  transcriptsKeptDays: number;
}

const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

/**
 * Adding projects: by folder, or from folders Dena noticed you used with Claude Code. Adding
 * imports the project's past (conversations Claude Code still has, and git history). No model is
 * used; nothing is recorded from a suggested folder until you add it.
 */
export function ProjectAdder({ onAdded }: { onAdded: (p: Project) => void }) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [open, setOpen] = useState<string | null>(null); // the path being added ("" = typed by hand)
  const load = useCallback(() => api<{ folders: Folder[] }>("discover").then((r) => setFolders(r.folders), () => {}), []);
  useEffect(() => {
    load();
  }, [load]);
  const dismiss = (path: string) => api<{ folders: Folder[] }>("discover/dismiss", { method: "POST", body: { path } }).then((r) => setFolders(r.folders), () => {});
  return (
    <>
      <button className="side-item add-project" onClick={() => setOpen("")}>+ Add project</button>
      {folders.length > 0 && (
        <div className="suggest">
          <div className="side-label" title="Folders where you used Claude Code that Dena doesn't know yet. Nothing is recorded from them until you add one.">Worked in recently</div>
          {folders.slice(0, 4).map((f) => (
            <div key={f.path} className="suggest-row">
              <span className="suggest-name" title={f.path}>{f.path.split("/").pop()}<small>{f.sessions} {f.sessions === 1 ? "session" : "sessions"} · {when(f.lastUsed).replace(/,.*$/, "")}</small></span>
              <span className="suggest-actions">
                <button className="linkish small" onClick={() => setOpen(f.path)}>Add</button>
                <button className="linkish small faint" onClick={() => dismiss(f.path)} title="Don't suggest this folder again">Not now</button>
              </span>
            </div>
          ))}
        </div>
      )}
      {open !== null && <AddDialog initial={open} onClose={() => setOpen(null)} onAdded={(p) => { load(); onAdded(p); }} />}
    </>
  );
}

function AddDialog({ initial, onClose, onAdded }: { initial: string; onClose: () => void; onAdded: (p: Project) => void }) {
  const [path, setPath] = useState(initial ? shortPath(initial) : "");
  const [name, setName] = useState(initial ? initial.split("/").pop()! : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<Added | null>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [busy, onClose]);
  const add = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<Added>("projects", { method: "POST", body: { path: path.trim(), name: name.trim() || undefined } });
      setDone(r);
      onAdded(r.project);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const i = done?.imported;
  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="add-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="add-title">{done ? `Added ${done.project.name}` : "Add a project"}</h2>
        {!done ? (
          <>
            <p className="muted">Dena reads the folder's past from what is already on your computer: conversations Claude Code still has, and its git history.
              No AI is used, and nothing is sent anywhere.</p>
            <label className="field"><span className="faint small">Folder</span>
              <input value={path} onChange={(e) => { setPath(e.target.value); if (!name || name === path.split("/").pop()) setName(e.target.value.split("/").filter(Boolean).pop() ?? ""); }}
                placeholder="~/code/my-app" autoFocus={!initial} spellCheck={false} /></label>
            <label className="field"><span className="faint small">Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-app" /></label>
          </>
        ) : (
          <>
            <p>{i!.events === 0 ? "No past activity was found for this folder yet. Start recording to capture new work."
              : <>Imported <b>{i!.conversations} {i!.conversations === 1 ? "conversation" : "conversations"}</b> ({i!.prompts} {i!.prompts === 1 ? "prompt" : "prompts"}) and <b>{i!.commits} {i!.commits === 1 ? "commit" : "commits"}</b>
                {i!.from && <>, from {when(i!.from).replace(/,.*$/, "")} to {when(i!.to!).replace(/,.*$/, "")}</>}.</>}</p>
            {done.transcriptsKeptDays <= 90 && (
              <p className="faint small">Claude Code keeps its conversations for {done.transcriptsKeptDays} days, so anything older was already deleted (git history is complete).
                To keep them longer, add <code>"cleanupPeriodDays": 3650</code> to <code>~/.claude/settings.json</code>.</p>
            )}
            <p className="muted small">Explaining it is separate and shows an estimate first: open the Guide and use <b>Explain remaining steps…</b>.
              To keep capturing new work, press <b>Start recording</b> on its page.</p>
          </>
        )}
        {err && <div className="error">{err}</div>}
        <div className="row modal-actions">
          <span style={{ flex: 1 }} />
          <button className="btn" disabled={busy} onClick={onClose}>{done ? "Close" : "Cancel"}</button>
          {!done && <button className="btn primary" disabled={busy || !path.trim()} onClick={add}>{busy ? "Reading its past…" : "Add project"}</button>}
        </div>
      </div>
    </div>
  );
}
