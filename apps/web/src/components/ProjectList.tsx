import { useEffect, useMemo, useState } from "react";
import { api, type Project } from "../api";

type P = Project & { folder?: string | null };

const COLLAPSED = "dena.collapsedFolders";
const readCollapsed = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED) ?? "[]");
  } catch {
    return [];
  }
};

/**
 * The sidebar's projects: ungrouped ones first, then folders you name, which fold away. Each
 * project has a menu to move it to a folder or remove it from Dena (its files stay on disk).
 */
export function ProjectList({ projects, currentId, onSelect, onChanged }: {
  projects: P[]; currentId: string | null; onSelect: (id: string) => void; onChanged: (removedId?: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<string[]>(readCollapsed);
  const [menu, setMenu] = useState<string | null>(null);
  const [moving, setMoving] = useState<P | null>(null);
  const [removing, setRemoving] = useState<P | null>(null);
  const folders = useMemo(() => [...new Set(projects.map((p) => p.folder).filter((f): f is string => !!f))].sort((a, b) => a.localeCompare(b)), [projects]);
  const toggle = (f: string) => {
    const next = collapsed.includes(f) ? collapsed.filter((x) => x !== f) : [...collapsed, f];
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED, JSON.stringify(next));
    } catch { /* not remembered */ }
  };
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  const item = (p: P) => (
    <div key={p.id} className={`side-item-wrap ${menu === p.id ? "menu-open" : ""}`}>
      <button className={`side-item ${p.id === currentId ? "active" : ""}`} onClick={() => onSelect(p.id)}>
        <span className="dot" style={{ background: p.recordingState === "recording" ? "var(--rec)" : p.recordingState === "paused" ? "var(--warn)" : "var(--line-strong)" }} />
        <span style={{ minWidth: 0 }}>
          {p.name}
          <small title={p.rootPath}>{p.rootPath}</small>
        </span>
      </button>
      <button className="item-menu-btn" aria-label={`Options for ${p.name}`} aria-haspopup="menu" aria-expanded={menu === p.id}
        onClick={(e) => { e.stopPropagation(); setMenu(menu === p.id ? null : p.id); }}>⋯</button>
      {menu === p.id && (
        <div className="item-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <button role="menuitem" onClick={() => { setMenu(null); setMoving(p); }}>Move to folder…</button>
          <button role="menuitem" className="danger-text" onClick={() => { setMenu(null); setRemoving(p); }}>Remove from Dena…</button>
        </div>
      )}
    </div>
  );

  const loose = projects.filter((p) => !p.folder);
  return (
    <>
      <div className="side-label">Projects</div>
      {loose.map(item)}
      {folders.map((f) => {
        const inside = projects.filter((p) => p.folder === f);
        const shut = collapsed.includes(f) && !inside.some((p) => p.id === currentId);
        return (
          <div key={f} className="side-folder">
            <button className="side-folder-head" onClick={() => toggle(f)} aria-expanded={!shut}>
              <span aria-hidden>{shut ? "▸" : "▾"}</span> {f} <span className="faint">{inside.length}</span>
            </button>
            {!shut && inside.map(item)}
          </div>
        );
      })}
      {moving && <MoveDialog project={moving} folders={folders} onClose={() => setMoving(null)} onDone={() => { setMoving(null); onChanged(); }} />}
      {removing && <RemoveDialog project={removing} onClose={() => setRemoving(null)} onDone={() => { const id = removing.id; setRemoving(null); onChanged(id); }} />}
    </>
  );
}

function MoveDialog({ project, folders, onClose, onDone }: { project: P; folders: string[]; onClose: () => void; onDone: () => void }) {
  const [choice, setChoice] = useState(project.folder ?? "");
  const [fresh, setFresh] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    const folder = choice === "__new" ? fresh.trim() : choice;
    try {
      await api(`projects/${project.id}/settings`, { method: "POST", body: { folder: folder || null } });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="move-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="move-title">Move {project.name} to a folder</h2>
        <p className="muted small">Folders only group projects in this list. Nothing on your disk moves.</p>
        <label className="field"><span className="faint small">Folder</span>
          <select value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">No folder</option>
            {folders.map((f) => <option key={f} value={f}>{f}</option>)}
            <option value="__new">New folder…</option>
          </select>
        </label>
        {choice === "__new" && (
          <label className="field"><span className="faint small">New folder name</span>
            <input value={fresh} onChange={(e) => setFresh(e.target.value)} placeholder="e.g. Games" maxLength={60} autoFocus /></label>
        )}
        {err && <div className="error">{err}</div>}
        <div className="row modal-actions">
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={choice === "__new" && !fresh.trim()} onClick={save}>Move</button>
        </div>
      </div>
    </div>
  );
}

function RemoveDialog({ project, onClose, onDone }: { project: P; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const events = project.stats?.byType.reduce((n, t) => n + t.n, 0) ?? null;
  const remove = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`projects/${project.id}`, { method: "DELETE" });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="remove-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="remove-title">Remove {project.name} from Dena?</h2>
        <p>This deletes what Dena recorded and wrote for it{events != null ? <> ({events.toLocaleString()} recorded events</> : " (its recorded events"}, its explained steps, wiki and
          code pages, and your notes and edits). <b>This can't be undone.</b></p>
        <p className="muted">Your folder <code>{project.rootPath}</code> and its files are not touched.</p>
        <p className="faint small">To bring it back later, use + Add project. Its past is read again from Claude Code and git, but conversations older than Claude Code keeps are gone,
          and the explanations would need writing again.</p>
        {err && <div className="error">{err}</div>}
        <div className="row modal-actions">
          <span style={{ flex: 1 }} />
          <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn danger" disabled={busy} onClick={remove}>{busy ? "Removing…" : "Remove from Dena"}</button>
        </div>
      </div>
    </div>
  );
}
