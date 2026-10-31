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
  const [browsing, setBrowsing] = useState(!initial);
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
              <span className="row" style={{ gap: 6 }}>
                <input style={{ flex: 1 }} value={path} onChange={(e) => { setPath(e.target.value); if (!name || name === path.split("/").pop()) setName(e.target.value.split("/").filter(Boolean).pop() ?? ""); }}
                  placeholder="~/code/my-app" autoFocus={!initial} spellCheck={false} />
                <button className="btn" type="button" onClick={() => setBrowsing(!browsing)}>{browsing ? "Close" : "Browse…"}</button>
              </span></label>
            {browsing && <FolderBrowser start={path} onPick={(p) => { setPath(shortPath(p)); setName(p.split("/").pop() ?? ""); setBrowsing(false); }} />}
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

interface Listing { path: string; parent: string | null; home: string; git: boolean; claude: boolean; added: boolean; dirs: { name: string; path: string; git: boolean; claude: boolean; added: boolean }[] }

/** Folders inside your home folder, from Dena's own server: a web page cannot see real paths itself. */
function FolderBrowser({ start, onPick }: { start: string; onPick: (path: string) => void }) {
  const [at, setAt] = useState(start.trim() || "~");
  const [l, setL] = useState<Listing | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setErr(null);
    api<Listing>(`browse?path=${encodeURIComponent(at)}`).then(setL, (e) => {
      setErr(String(e.message));
      if (at !== "~") setAt("~");
    });
  }, [at]);
  if (!l) return err ? <div className="error">{err}</div> : <p className="faint small">Opening…</p>;
  const tags = (d: { git: boolean; claude: boolean; added: boolean }) => (
    <>{d.added && <span className="badge">in Dena</span>}{d.claude && <span className="badge accent">Claude Code</span>}{d.git && <span className="badge">git</span>}</>
  );
  return (
    <div className="browser">
      <div className="browser-head">
        {l.parent && <button className="linkish small" onClick={() => setAt(l.parent!)}>↑ Up</button>}
        <span className="mono small browser-path" title={l.path}>{shortPath(l.path)}</span>
        <span className="row" style={{ gap: 4 }}>{tags(l)}</span>
      </div>
      <div className="browser-list">
        {l.dirs.length === 0 && <p className="faint small" style={{ padding: "6px 10px" }}>No folders inside.</p>}
        {l.dirs.map((d) => (
          <button key={d.path} className="browser-row" onClick={() => setAt(d.path)} title="Open this folder">
            <span>📁 {d.name}</span><span className="row" style={{ gap: 4 }}>{tags(d)}</span>
          </button>
        ))}
      </div>
      <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
        <span className="faint small">{l.git || l.claude ? "This looks like a project." : "Open a folder, or choose this one."}</span>
        <button className="btn primary" disabled={l.added || l.path === l.home} onClick={() => onPick(l.path)}>{l.added ? "Already in Dena" : "Choose this folder"}</button>
      </div>
    </div>
  );
}
