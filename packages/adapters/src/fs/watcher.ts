import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createTwoFilesPatch, structuredPatch } from "diff";
import {
  DEFAULT_EXCLUDED_DIRS,
  isSensitivePath,
  redactText,
  sha256,
  type FsFileState,
  type IngestBatch,
  type NewEvent,
  type Store,
} from "@dena/core";

/**
 * Filesystem capture. This is the only source that sees changes made by shell commands,
 * scripts, editors and humans alike, which is also why it cannot say who made a change:
 * every event it produces has actor "unknown". Correlation with other sources may add
 * labeled links later; it never rewrites the actor.
 */

export const SOURCE = "fs";

export interface FsCaptureOptions {
  debounceMs?: number;
  /** Text files up to this size get a redacted snapshot so later changes can be diffed. */
  maxSnapshotBytes?: number;
  onIngest?: (summaries: string[]) => void;
  onError?: (err: unknown) => void;
}

interface Observed {
  buf: Buffer;
  size: number;
  mtimeMs: number;
}

const globToRe = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}`);

export class FsCapture {
  private watcher: fs.FSWatcher | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  private pending = new Set<string>();
  private state: Map<string, FsFileState>;
  private readonly root: string;
  private readonly excludeRes: RegExp[];
  private readonly isRepo: boolean;
  private readonly debounceMs: number;
  private readonly maxSnapshot: number;
  sessionId: string | null = null;

  constructor(
    private readonly store: Store,
    private readonly projectId: string,
    root: string,
    private readonly opts: FsCaptureOptions = {},
  ) {
    this.root = path.resolve(root);
    this.debounceMs = opts.debounceMs ?? 750;
    this.maxSnapshot = opts.maxSnapshotBytes ?? 512 * 1024;
    this.state = store.fsState(projectId);
    this.excludeRes = store.projectSettings(projectId).exclude.map((g) => globToRe(g.endsWith("/") ? `${g}**` : g));
    this.isRepo = spawnSync("git", ["-C", this.root, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).stdout?.trim() === "true";
  }

  /** Default dirs, user patterns, and (in git repos) .gitignore rules. */
  isExcluded(rel: string): boolean {
    const segs = rel.split(/[\\/]/);
    if (segs.some((s) => DEFAULT_EXCLUDED_DIRS.includes(s))) return true;
    return this.excludeRes.some((re) => re.test(rel));
  }

  private gitIgnored(rels: string[]): Set<string> {
    if (!this.isRepo || rels.length === 0) return new Set();
    const r = spawnSync("git", ["-C", this.root, "check-ignore", "--stdin"], { input: rels.join("\n"), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return new Set((r.stdout ?? "").split("\n").filter(Boolean));
  }

  private walk(): string[] {
    const out: string[] = [];
    const visit = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        const rel = path.relative(this.root, abs);
        if (this.isExcluded(rel)) continue;
        if (e.isDirectory()) visit(abs);
        else if (e.isFile()) out.push(rel);
      }
    };
    visit(this.root);
    const ignored = this.gitIgnored(out);
    return out.filter((r) => !ignored.has(r));
  }

  private read(rel: string): Observed | null {
    try {
      const abs = path.join(this.root, rel);
      const st = fs.statSync(abs);
      if (!st.isFile()) return null;
      return { buf: fs.readFileSync(abs), size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
    } catch {
      return null;
    }
  }

  /**
   * Compares the tree with the last known state.
   * - First run for a project: records a baseline, emits no change events.
   * - Later runs: emits changes made while Dena was not recording, labeled as such.
   */
  scan(): { baseline: boolean; changes: number } {
    const baseline = this.state.size === 0 && !this.store.getCursor(this.projectId, SOURCE, "baseline_at");
    const files = this.walk();
    const seen = new Set(files);
    const batch = emptyBatch();
    let changes = 0;
    for (const rel of files) {
      const cur = this.read(rel);
      if (!cur) continue;
      const prev = this.state.get(rel);
      if (prev && prev.size === cur.size && prev.mtimeMs === cur.mtimeMs) continue;
      if (baseline) this.commit(rel, cur, this.snapshotOf(rel, cur));
      else if (this.change(batch, rel, prev, cur, "startup_scan")) changes++;
    }
    if (!baseline)
      for (const rel of [...this.state.keys()])
        if (!seen.has(rel) && !this.isExcluded(rel) && this.change(batch, rel, this.state.get(rel), null, "startup_scan")) changes++;
    if (baseline) this.store.setCursor(this.projectId, SOURCE, "baseline_at", new Date().toISOString());
    this.ingest(batch);
    return { baseline, changes };
  }

  start(): void {
    this.watcher = fs.watch(this.root, { recursive: true }, (_type, filename) => {
      if (!filename) return;
      const rel = filename.toString();
      if (this.isExcluded(rel)) return;
      this.pending.add(rel);
      clearTimeout(this.timers.get(rel));
      this.timers.set(
        rel,
        setTimeout(() => {
          this.timers.delete(rel);
          if (this.timers.size === 0) this.flush();
        }, this.debounceMs),
      );
    });
    this.watcher.on("error", (err) => this.opts.onError?.(err));
  }

  /** Processes settled paths. Called automatically once the debounce window is quiet. */
  flush(): void {
    const rels = [...this.pending];
    this.pending.clear();
    const ignored = this.gitIgnored(rels);
    const batch = emptyBatch();
    for (const rel of rels) {
      if (ignored.has(rel)) continue;
      const cur = this.read(rel);
      const prev = this.state.get(rel);
      if (!cur && fs.existsSync(path.join(this.root, rel))) continue; // a directory
      this.change(batch, rel, prev, cur, "watcher");
    }
    try {
      this.ingest(batch);
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.pending.size) this.flush();
  }

  private snapshotOf(rel: string, cur: Observed): string | null {
    if (isSensitivePath(rel) || cur.size > this.maxSnapshot || cur.buf.subarray(0, 8000).includes(0)) return null;
    return redactText(cur.buf.toString("utf8"));
  }

  private stagedState = new Map<string, FsFileState | null>();

  private commit(rel: string, cur: Observed | null, snapshot: string | null): void {
    if (!cur) {
      this.stagedState.set(rel, null);
      return;
    }
    const snapshotHash = snapshot === null ? null : this.store.blobs.put(snapshot).hash;
    this.stagedState.set(rel, { hash: sha256(cur.buf), size: cur.size, mtimeMs: cur.mtimeMs, snapshotHash });
  }

  /** Adds an event for one path if its content really changed. Returns whether it did. */
  private change(batch: IngestBatch, rel: string, prev: FsFileState | undefined, cur: Observed | null, detectedBy: "watcher" | "startup_scan"): boolean {
    if (!prev && !cur) return false;
    const hash = cur ? sha256(cur.buf) : null;
    if (prev && hash === prev.hash) {
      this.commit(rel, cur, cur ? this.snapshotOfCached(prev) : null); // touched, not changed: refresh mtime only
      return false;
    }
    const sensitive = isSensitivePath(rel);
    const snapshot = cur ? this.snapshotOf(rel, cur) : null;
    const prevText = prev?.snapshotHash ? (this.store.blobs.get(prev.snapshotHash)?.toString("utf8") ?? null) : null;
    const type = !cur ? "file_deleted" : !prev ? "file_created" : "file_modified";
    const offline = detectedBy === "startup_scan";
    const occurredAt = offline && cur ? new Date(cur.mtimeMs).toISOString() : new Date().toISOString();
    const sid = `${rel}@${type}@${(hash ?? prev!.hash).slice(0, 16)}@${cur?.mtimeMs ?? occurredAt}`;

    let added: number | null = null;
    let removed: number | null = null;
    let diffNote: string | null = null;
    if (snapshot !== null && prevText !== null) {
      const sp = structuredPatch(rel, rel, prevText, snapshot, "", "", { context: 3 });
      added = sp.hunks.reduce((n, h) => n + h.lines.filter((l) => l.startsWith("+")).length, 0);
      removed = sp.hunks.reduce((n, h) => n + h.lines.filter((l) => l.startsWith("-")).length, 0);
      batch.artifacts.push({ sourceEventId: sid, role: "diff", artifactType: "diff", uriOrPath: rel,
        content: createTwoFilesPatch(`a/${rel}`, `b/${rel}`, prevText, snapshot, "", "", { context: 3 }) });
    } else if (snapshot !== null && type === "file_created") {
      added = snapshot.split("\n").length;
      batch.artifacts.push({ sourceEventId: sid, role: "content", artifactType: "file_snapshot", uriOrPath: rel, content: snapshot });
    } else if (type === "file_deleted") {
      diffNote = null;
    } else {
      diffNote = sensitive ? "sensitive file: contents never stored"
        : !snapshot ? "binary or too large to snapshot"
        : "no earlier snapshot of this file, so no diff is available";
    }

    const verb = type === "file_created" ? "Created" : type === "file_deleted" ? "Deleted" : "Modified";
    batch.events.push({
      sessionId: this.sessionId,
      source: SOURCE,
      sourceEventId: sid,
      eventType: type,
      occurredAt,
      actor: "unknown",
      summary: `${verb} ${rel}${added !== null ? ` (+${added} −${removed ?? 0})` : ""}${offline ? " — while not recording" : ""}`,
      payload: {
        file: rel, outsideRoot: false, detectedBy, linesAdded: added, linesRemoved: removed, sizeBytes: cur?.size ?? null,
        contentWithheld: sensitive || undefined, diffUnavailable: diffNote ?? undefined,
        ...(offline ? { timingNote: cur ? "time is the file's modification time; the change happened while Dena was not recording"
          : "deleted at an unknown time while Dena was not recording" } : {}),
      },
      captureConfidence: offline || diffNote ? "partial" : "observed",
    } satisfies NewEvent);
    this.commit(rel, cur, snapshot);
    return true;
  }

  private snapshotOfCached(prev: FsFileState): string | null {
    return prev.snapshotHash ? (this.store.blobs.get(prev.snapshotHash)?.toString("utf8") ?? null) : null;
  }

  /** Events first, then state: after a crash in between, the re-scan yields the same source ids and dedups. */
  private ingest(batch: IngestBatch): void {
    if (batch.events.length) {
      if (this.sessionId) batch.sessions.push({ id: this.sessionId, source: SOURCE, startedAt: null, endedAt: new Date().toISOString() });
      this.store.ingest(this.projectId, batch);
      this.opts.onIngest?.(batch.events.map((e) => e.summary));
    }
    for (const [rel, s] of this.stagedState) {
      this.store.setFsState(this.projectId, rel, s);
      if (s) this.state.set(rel, s);
      else this.state.delete(rel);
    }
    this.stagedState.clear();
  }
}

const emptyBatch = (): IngestBatch => ({ sessions: [], events: [], artifacts: [], links: [], gaps: [] });
