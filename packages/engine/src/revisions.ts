import type { Store } from "@dena/core";

/**
 * Revision history for guide documents (an episode's step, a wiki page), and the owner's notes.
 *
 * Every version is kept. Exactly one revision per document is "active" (the one shown).
 * The rule that protects the owner's work: an AI-generated version never replaces an active
 * version that contains the owner's edits. It is stored as "proposed" instead, and the owner
 * adopts or declines it.
 */

export type DocType = "step" | "wiki";

export interface Revision {
  id: number;
  docType: DocType;
  docKey: string;
  origin: "generated" | "user" | "restored";
  status: "active" | "proposed" | "superseded" | "declined";
  content: any;
  meta: Record<string, any>;
  baseId: number | null;
  note: string | null;
  createdAt: string;
}

export class RevisionConflict extends Error {
  constructor(readonly currentId: number | null) {
    super("This document changed since you opened it. Reload to see the current version, then make your edit again.");
  }
}

const row = (r: any): Revision => ({
  id: r.id, docType: r.doc_type, docKey: r.doc_key, origin: r.origin, status: r.status, content: JSON.parse(r.content_json),
  meta: JSON.parse(r.meta_json), baseId: r.base_id, note: r.note, createdAt: r.created_at,
});

export function revisions(store: Store, projectId: string, type: DocType, key: string): Revision[] {
  return (store.db.prepare("SELECT * FROM doc_revision WHERE project_id = ? AND doc_type = ? AND doc_key = ? ORDER BY id DESC").all(projectId, type, key) as any[]).map(row);
}

export function activeRevision(store: Store, projectId: string, type: DocType, key: string): Revision | null {
  const r = store.db.prepare("SELECT * FROM doc_revision WHERE project_id = ? AND doc_type = ? AND doc_key = ? AND status = 'active' ORDER BY id DESC LIMIT 1")
    .get(projectId, type, key);
  return r ? row(r) : null;
}

/** An AI update waiting for the owner, if it is newer than the active version. */
export function proposedRevision(store: Store, projectId: string, type: DocType, key: string): Revision | null {
  const active = activeRevision(store, projectId, type, key);
  const r = store.db.prepare("SELECT * FROM doc_revision WHERE project_id = ? AND doc_type = ? AND doc_key = ? AND status = 'proposed' AND id > ? ORDER BY id DESC LIMIT 1")
    .get(projectId, type, key, active?.id ?? 0);
  return r ? row(r) : null;
}

function insert(store: Store, projectId: string, type: DocType, key: string, r: Omit<Revision, "id" | "docType" | "docKey" | "createdAt">): Revision {
  const now = new Date().toISOString();
  return store.db.transaction(() => {
    if (r.status === "active")
      store.db.prepare("UPDATE doc_revision SET status = 'superseded' WHERE project_id = ? AND doc_type = ? AND doc_key = ? AND status = 'active'").run(projectId, type, key);
    if (r.status === "proposed")
      store.db.prepare("UPDATE doc_revision SET status = 'superseded' WHERE project_id = ? AND doc_type = ? AND doc_key = ? AND status = 'proposed'").run(projectId, type, key);
    const info = store.db
      .prepare("INSERT INTO doc_revision (project_id, doc_type, doc_key, origin, status, content_json, meta_json, base_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(projectId, type, key, r.origin, r.status, JSON.stringify(r.content), JSON.stringify(r.meta), r.baseId, r.note, now);
    return { ...r, id: Number(info.lastInsertRowid), docType: type, docKey: key, createdAt: now };
  })();
}

/**
 * Records a freshly generated version. It becomes active unless the active version holds the
 * owner's edits, in which case it is proposed and the owner's version stays on screen.
 */
export function recordGenerated(store: Store, projectId: string, type: DocType, key: string, content: unknown, meta: Record<string, any>): Revision {
  const active = activeRevision(store, projectId, type, key);
  const protect = !!active?.meta.userEdited;
  return insert(store, projectId, type, key, { origin: "generated", status: protect ? "proposed" : "active", content, meta: { ...meta, userEdited: false },
    baseId: active?.id ?? null, note: protect ? "AI update written while your edited version was active" : null });
}

/**
 * Records an AI update for the owner to review before it is shown: a targeted update always
 * waits as a proposal, with what it adds, changes and removes in `meta.diff`.
 */
export function recordProposed(store: Store, projectId: string, type: DocType, key: string, content: unknown, meta: Record<string, any>, note: string): Revision {
  const active = activeRevision(store, projectId, type, key);
  return insert(store, projectId, type, key, { origin: "generated", status: "proposed", content, meta, baseId: active?.id ?? null, note });
}

/** Saves the owner's edit. `baseId` must be the active revision they edited (optimistic concurrency). */
export function saveUserEdit(store: Store, projectId: string, type: DocType, key: string, content: unknown, baseId: number, note?: string): Revision {
  const active = activeRevision(store, projectId, type, key);
  if (!active || active.id !== baseId) throw new RevisionConflict(active?.id ?? null);
  return insert(store, projectId, type, key, { origin: "user", status: "active", content, meta: { ...active.meta, userEdited: true }, baseId, note: note ?? null });
}

/** Adopts a proposed AI version: it becomes active and the owner's edits stay in history. */
export function adoptProposed(store: Store, projectId: string, type: DocType, key: string, id: number): Revision {
  const p = revisions(store, projectId, type, key).find((r) => r.id === id && r.status === "proposed");
  if (!p) throw new Error("That AI update is no longer waiting");
  store.db.prepare("UPDATE doc_revision SET status = 'superseded' WHERE id = ?").run(id);
  // A targeted update keeps the owner's edited statements, so the adopted version still holds their work.
  return insert(store, projectId, type, key, { origin: "generated", status: "active", content: p.content, meta: { ...p.meta, userEdited: p.meta.targeted ? !!p.meta.userEdited : false }, baseId: id,
    note: "AI update adopted by the owner" });
}

export function declineProposed(store: Store, projectId: string, type: DocType, key: string, id: number): void {
  store.db.prepare("UPDATE doc_revision SET status = 'declined' WHERE project_id = ? AND doc_type = ? AND doc_key = ? AND id = ? AND status = 'proposed'")
    .run(projectId, type, key, id);
}

/** Restores any earlier version as a new active revision; nothing is deleted. */
export function restoreRevision(store: Store, projectId: string, type: DocType, key: string, id: number): Revision {
  const r = revisions(store, projectId, type, key).find((x) => x.id === id);
  if (!r) throw new Error("No such revision");
  return insert(store, projectId, type, key, { origin: "restored", status: "active", content: r.content, meta: { ...r.meta }, baseId: id,
    note: `Restored the version from ${r.createdAt.slice(0, 16).replace("T", " ")} UTC` });
}

// ---- owner notes ----

export interface DocNote {
  id: number;
  docType: DocType;
  docKey: string;
  kind: "context" | "incorrect" | "incomplete";
  target: string | null;
  text: string;
  status: "open" | "dismissed";
  createdAt: string;
}

export function addNote(store: Store, projectId: string, type: DocType, key: string, note: { kind: DocNote["kind"]; text: string; target?: string | null }): DocNote {
  const now = new Date().toISOString();
  const info = store.db
    .prepare("INSERT INTO doc_note (project_id, doc_type, doc_key, kind, target, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(projectId, type, key, note.kind, note.target ?? null, note.text, now);
  return { id: Number(info.lastInsertRowid), docType: type, docKey: key, kind: note.kind, target: note.target ?? null, text: note.text, status: "open", createdAt: now };
}

export function notesFor(store: Store, projectId: string, type: DocType, key: string, opts: { all?: boolean } = {}): DocNote[] {
  return (store.db.prepare(`SELECT * FROM doc_note WHERE project_id = ? AND doc_type = ? AND doc_key = ? ${opts.all ? "" : "AND status = 'open'"} ORDER BY id`)
    .all(projectId, type, key) as any[]).map((r) => ({ id: r.id, docType: r.doc_type, docKey: r.doc_key, kind: r.kind, target: r.target, text: r.text, status: r.status, createdAt: r.created_at }));
}

export function dismissNote(store: Store, projectId: string, id: number): void {
  store.db.prepare("UPDATE doc_note SET status = 'dismissed' WHERE project_id = ? AND id = ?").run(projectId, id);
}
