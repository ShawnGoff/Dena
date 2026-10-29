import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { correlate, type Store } from "@dena/core";
import * as claudeCode from "./claude-code/transcript.ts";
import * as git from "./git/git.ts";
import { FsCapture } from "./fs/watcher.ts";
import { ingestHooks } from "./claude-code/hooks.ts";

/**
 * Runs every capture source for one project. Each source is independent: a failure in one
 * is reported and recorded as a gap, and the others keep going.
 */

export interface RecorderOptions {
  /** "all" reads every Claude Code project folder and keeps only activity that points at this project. */
  transcriptScope?: "own" | "all";
  pollMs?: number;
  claudeHome?: string;
  log?: (msg: string) => void;
}

export function transcriptFiles(root: string, scope: "own" | "all", claudeHome = path.join(os.homedir(), ".claude")): string[] {
  if (scope === "own") return claudeCode.listTranscripts(root, claudeHome);
  const base = path.join(claudeHome, "projects");
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base).flatMap((d) => {
    try {
      return claudeCode.transcriptsIn(path.join(base, d));
    } catch {
      return [];
    }
  });
}

/** Imports transcripts that changed since the last import. Unchanged files are skipped by size+mtime. */
export async function importChangedTranscripts(store: Store, projectId: string, root: string, opts: RecorderOptions = {}) {
  const log = opts.log ?? (() => {});
  let events = 0;
  for (const f of transcriptFiles(root, opts.transcriptScope ?? "all", opts.claudeHome)) {
    let st: fs.Stats;
    try {
      st = fs.statSync(f);
    } catch {
      continue;
    }
    const fingerprint = `${st.size}:${Math.floor(st.mtimeMs)}`;
    if (store.getCursor(projectId, claudeCode.SOURCE, f) === fingerprint) continue;
    try {
      const { batch, report } = await claudeCode.importTranscript(f, root);
      const r = store.ingest(projectId, batch);
      events += r.eventsInserted;
      if (r.eventsInserted) log(`claude: +${r.eventsInserted} events from ${path.basename(f)}${report.excludedGroups ? ` (${report.excludedGroups} prompt groups belonged to other projects)` : ""}`);
      store.setCursor(projectId, claudeCode.SOURCE, f, fingerprint);
    } catch (err) {
      log(`claude: could not import ${path.basename(f)}: ${(err as Error).message}`);
      store.recordGap(projectId, { sessionId: null, source: claudeCode.SOURCE, fromTime: new Date().toISOString(), toTime: null,
        reason: `Transcript ${path.basename(f)} could not be read` });
    }
  }
  return events;
}

export function importGitIfChanged(store: Store, projectId: string, root: string, log: (m: string) => void = () => {}) {
  if (!git.isGitRepo(root)) return 0;
  const head = path.join(root, ".git");
  let fingerprint = "";
  try {
    const refs = fs.readFileSync(path.join(head, "HEAD"), "utf8");
    const logs = path.join(head, "logs", "HEAD");
    fingerprint = `${refs.trim()}:${fs.existsSync(logs) ? fs.statSync(logs).size : 0}`;
  } catch {
    fingerprint = String(Date.now()); // worktrees/submodules: just re-import, it dedups
  }
  if (store.getCursor(projectId, git.SOURCE, "fingerprint") === fingerprint) return 0;
  const { batch } = git.importGit(root);
  const r = store.ingest(projectId, batch);
  store.setCursor(projectId, git.SOURCE, "fingerprint", fingerprint);
  if (r.eventsInserted) log(`git: +${r.eventsInserted} events`);
  return r.eventsInserted;
}

export class Recorder {
  private fs: FsCapture | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private sessionId = "";
  private state: "recording" | "paused" | "stopped" = "stopped";
  private pausedAt: string | null = null;

  constructor(
    private readonly store: Store,
    private readonly projectId: string,
    private readonly opts: RecorderOptions = {},
  ) {}

  private get root() {
    return this.store.getProject(this.projectId)!.rootPath;
  }
  private log(m: string) {
    this.opts.log?.(m);
  }

  async start(): Promise<void> {
    const now = new Date().toISOString();
    const lastStop = this.store.getCursor(this.projectId, "dena", "last_stopped_at");
    if (lastStop)
      this.store.recordGap(this.projectId, { sessionId: null, source: "dena", fromTime: lastStop, toTime: now,
        reason: "Dena was not recording; file changes in this window are recovered by the startup scan without exact times" });
    this.sessionId = `rec-${now}`;
    this.store.ingest(this.projectId, { sessions: [{ id: this.sessionId, source: "dena.recorder", startedAt: now, endedAt: null, summary: "recording session" }],
      events: [], artifacts: [], links: [], gaps: [] });
    this.store.setRecordingState(this.projectId, "recording");
    this.state = "recording";
    this.startFs();
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs ?? 5_000);
    // Hook calls ring the doorbell: react within a second instead of waiting for the next poll.
    const spool = path.join(this.store.home, "spool");
    fs.mkdirSync(spool, { recursive: true });
    let bell: NodeJS.Timeout | null = null;
    this.spoolWatcher = fs.watch(spool, () => {
      if (bell) clearTimeout(bell);
      bell = setTimeout(() => void this.tick(), 500);
    });
  }

  private spoolWatcher: fs.FSWatcher | null = null;

  private startFs() {
    this.fs = new FsCapture(this.store, this.projectId, this.root, {
      onIngest: (s) => s.forEach((x) => this.log(`fs: ${x}`)),
      onError: (e) => this.log(`fs: ${(e as Error).message}`),
    });
    this.fs.sessionId = this.sessionId;
    const scan = this.fs.scan();
    this.log(scan.baseline ? "fs: baseline captured" : `fs: ${scan.changes} changes found from while not recording`);
    this.fs.start();
  }

  /** Polls the cheap sources and follows pause/resume requests made from another process. */
  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const wanted = this.store.getProject(this.projectId)?.recordingState ?? "stopped";
      if (wanted === "paused" && this.state === "recording") {
        this.fs?.stop();
        this.fs = null;
        this.state = "paused";
        this.pausedAt = new Date().toISOString();
        this.log("paused — nothing is being captured");
      } else if (wanted === "recording" && this.state === "paused") {
        this.store.recordGap(this.projectId, { sessionId: this.sessionId, source: "dena", fromTime: this.pausedAt, toTime: new Date().toISOString(),
          reason: "Recording was paused by the user" });
        this.state = "recording";
        this.startFs();
        this.log("resumed");
      }
      if (this.state !== "recording") return;
      const h = await ingestHooks(this.store, this.projectId, this.root);
      if (h.events || h.fallbacks)
        this.log(`hooks: +${h.events} events from ${h.records} hook calls${h.fallbacks ? `, ${h.fallbacks} missing from transcripts` : ""}`);
      const g = importGitIfChanged(this.store, this.projectId, this.root, (m) => this.log(m));
      const c = await importChangedTranscripts(this.store, this.projectId, this.root, this.opts);
      if (g || c || h.transcriptsImported) correlate(this.store, this.projectId);
    } catch (err) {
      this.log(`recorder: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.spoolWatcher?.close();
    this.fs?.stop();
    if (this.state === "recording") {
      this.state = "stopped"; // so a final tick does not restart anything
      importGitIfChanged(this.store, this.projectId, this.root);
      await importChangedTranscripts(this.store, this.projectId, this.root, this.opts);
      await ingestHooks(this.store, this.projectId, this.root, { final: true }); // after transcripts, so only real misses become fallbacks
    }
    correlate(this.store, this.projectId);
    const now = new Date().toISOString();
    this.store.ingest(this.projectId, { sessions: [{ id: this.sessionId, source: "dena.recorder", startedAt: null, endedAt: now }],
      events: [], artifacts: [], links: [], gaps: [] });
    this.store.setCursor(this.projectId, "dena", "last_stopped_at", now);
    this.store.setRecordingState(this.projectId, "stopped");
    this.state = "stopped";
  }
}
