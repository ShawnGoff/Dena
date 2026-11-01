import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { correlate, authorSummary, displaySummary, effectiveTest, likelyAuthors, type LikelyAuthor, type StoredEvent, type Store } from "@dena/core";
import { foldersUsedWithClaude, git, hookInstall, importChangedTranscripts, importGitIfChanged, isWorkFolder, lastHeartbeat, liveRecorder, pausedWindows, Recorder, type RecorderOptions } from "@dena/adapters";
import { explainMany, stepCoverage, exportGuideHtml, tutorialPlan, writeTutorial, episodeChapters, howBuiltPage, howBuiltStep, adoptUpdate, planUpdate, updateSection, updateStep, explainFolder, folderPlan, inFolder, codeOverview, codePage, explainFile, renderCodeMarkdown, buildActivityLog, DEFAULT_KINDS, renderActivityMarkdown, type ActivityKind, packetMatches, standingLimitations, cancelQueued, enqueue, findOutdated, listJobs, processDueJobs, recoverJobs,
  ensureDocRevision, exportGuideMarkdown, activeRevision, addNote, adoptProposed, buildPacket, declineProposed, dismissNote, notesFor, proposedRevision, recordGenerated, restoreRevision, revisions,
  RevisionConflict, saveUserEdit, Step, StoppedError, WikiSection, type DocType,
  estimateSectionTokens, buildBrief, ClaudeCodeProvider, claudeAuthStatus, ensureMemory, generateSection, loadMemory, sectionKeys, storedSection, type SectionKey, episodeEvents, estimate, explainEpisode, loadEpisodes, rebuildEpisodes, storedExplanations, type Provider } from "@dena/engine";

/**
 * Dena's local server: a JSON API over the store plus the built web UI.
 *
 * It holds the user's project history, so it is locked down even though it is local:
 * - listens on 127.0.0.1 only;
 * - every request must carry a Host header naming that address (blocks DNS-rebinding pages);
 * - every API call must carry the per-launch token from the URL Dena prints (blocks other
 *   local web pages, which cannot read that token);
 * - no CORS headers, so browsers will not hand responses to other origins.
 */

export interface ServerOptions {
  port?: number;
  token?: string;
  webDir?: string;
  log?: (m: string) => void;
  /** Model backend for explanations; defaults to the user's Claude Code. Injectable for tests. */
  provider?: Provider;
  /** Options for recorders this server starts (e.g. where to find Claude Code transcripts). */
  recorder?: Omit<RecorderOptions, "log">;
}

/** Model names reach a command line, so only plain names and aliases are accepted ("haiku", "claude-sonnet-5-5"). */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface RunningServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

const DEFAULT_WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/web/dist");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2",
};
const NOTABLE = new Set(["prompt_submitted", "file_created", "file_modified", "file_deleted", "test_result", "error_detected", "git_commit", "agent_note", "branch_changed"]);
const ARTIFACT_LIMIT = 200_000;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const compact = (e: StoredEvent, likely?: Map<number, LikelyAuthor>) => ({
  id: e.id, type: e.eventType, actor: e.actor, source: e.source, summary: displaySummary(e), at: e.occurredAt,
  confidence: e.captureConfidence, notable: NOTABLE.has(e.eventType),
  outcome: e.eventType === "test_result" ? effectiveTest(e).outcome : (e.payload as any).status ?? null,
  likelyAuthor: likely?.get(e.id) ?? null,
});

/** Compacts a list, looking up likely authors for its unknown-author events in one query. */
const compactAll = (store: Store, projectId: string, events: StoredEvent[]) => {
  const likely = likelyAuthors(store, projectId, events.filter((e) => e.actor === "unknown").map((e) => e.id));
  return events.map((e) => compact(e, likely));
};

export async function startServer(store: Store, opts: ServerOptions = {}): Promise<RunningServer> {
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const webDir = opts.webDir ?? DEFAULT_WEB_DIR;
  const recorders = new Map<string, Recorder>();
  /** Generations in progress, each with the control that stops it (the Stop button). */
  const inFlight = new Map<string, AbortController>();
  /** How far a whole-folder code explanation has got, for the page to show while it runs. */
  const folderProgress = new Map<string, { done: number; total: number; current: string | null }>();
  /** How far "explain the remaining steps" has got. */
  const batchProgress = new Map<string, { done: number; total: number; current: string | null }>();
  const stopped = (e: unknown) => e instanceof StoppedError;

  // Background updates: one runner per project; retries are scheduled, and queued work resumes after a restart.
  const runners = new Map<string, Promise<void>>();
  const timers = new Map<string, NodeJS.Timeout>();
  const runUpdates = (projectId: string) => {
    if (runners.has(projectId) || !store.getProject(projectId)) return;
    clearTimeout(timers.get(projectId));
    const job = (async () => {
      try {
        const r = await processDueJobs(store, projectId, getProvider(projectId), { log: (m) => log(`[updates] ${m}`) });
        if (r.nextAt && !r.stoppedForBudget)
          timers.set(projectId, setTimeout(() => runUpdates(projectId), Math.max(1_000, Date.parse(r.nextAt) - Date.now())));
      } catch (e) {
        log(`[updates] ${(e as Error).message}`);
      } finally {
        runners.delete(projectId);
      }
    })();
    runners.set(projectId, job);
  };
  recoverJobs(store);

  // A project left "recording" with no live recorder (the last Dena process exited without a clean
  // shutdown) is resumed here: recording was the owner's last choice, and the screen must not say
  // "recording" while nothing captures. The gap is recorded from the last heartbeat.
  const resumeLeftOn = async () => {
    for (const p of store.listProjects()) {
      if (p.recordingState === "stopped" || recorders.has(p.id) || liveRecorder(store, p.id)) continue;
      const hb = lastHeartbeat(store, p.id);
      if (hb) store.setCursor(p.id, "dena", "last_stopped_at", hb.at);
      const wasPaused = p.recordingState === "paused";
      const rec = new Recorder(store, p.id, { ...opts.recorder, log: (m) => log(`[${p.name}] ${m}`) });
      recorders.set(p.id, rec);
      try {
        await rec.start();
        if (wasPaused) store.setRecordingState(p.id, "paused");
        log(`[${p.name}] ${wasPaused ? "recorder restored (still paused)" : "recording resumed"}: it was left on when Dena last stopped`);
      } catch (e) {
        recorders.delete(p.id);
        log(`[${p.name}] could not resume recording: ${(e as Error).message}`);
      }
    }
  };
  const recorderState = (projectId: string) => {
    const here = recorders.has(projectId);
    const elsewhere = !here ? liveRecorder(store, projectId) : null;
    return { recorderRunning: here || !!elsewhere, recorderHere: here, recorderElsewherePid: elsewhere?.pid ?? null };
  };
  // Updates still queued from before Dena last stopped do not resume on their own: Dena may now be
  // starting at login, and spending usage nobody asked for today is not acceptable. The Overview
  // asks whether to continue them.
  const resumable = new Set(store.listProjects().filter((p) => store.db.prepare("SELECT 1 FROM update_job WHERE project_id = ? AND status = 'queued'").get(p.id)).map((p) => p.id));
  const dismissedFile = path.join(store.home, "dismissed-folders.json");
  const dismissed = (): string[] => {
    try {
      return JSON.parse(fs.readFileSync(dismissedFile, "utf8"));
    } catch {
      return [];
    }
  };
  /** Folders used with Claude Code that no project covers and you have not dismissed, newest first. */
  const suggestions = () => {
    const roots = store.listProjects().map((x) => x.rootPath);
    const no = new Set(dismissed());
    return foldersUsedWithClaude(opts.recorder?.claudeHome).filter((f) => isWorkFolder(f.path) && !no.has(f.path)
      && !roots.some((r) => f.path === r || f.path.startsWith(`${r}/`) || r.startsWith(`${f.path}/`)) && fs.existsSync(f.path)).slice(0, 6);
  };
  const count = (projectId: string, what: string, where: string) =>
    (store.db.prepare(`SELECT ${what} n FROM event WHERE project_id = ? AND ${where}`).get(projectId) as { n: number }).n;
  /** How many days Claude Code keeps its transcripts (its cleanupPeriodDays setting; 30 by default). */
  const transcriptRetentionDays = (): number => {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8")).cleanupPeriodDays;
      return typeof v === "number" && v > 0 ? v : 30;
    } catch {
      return 30;
    }
  };

  /** What the last start recovered from while Dena was off (counted, never written by a model). */
  const catchUp = (projectId: string) => {
    try {
      return JSON.parse(store.getCursor(projectId, "dena", "last_catch_up") ?? "null");
    } catch {
      return null;
    }
  };
  /** A provider per call, so each project's sign-in setting applies. */
  const getProvider = (projectId: string): Provider => {
    if (opts.provider) return opts.provider;
    try {
      return new ClaudeCodeProvider(undefined, { auth: store.projectSettings(projectId).auth ?? "account", effort: store.projectSettings(projectId).effort });
    } catch (e) {
      throw new HttpError(503, (e as Error).message);
    }
  };
  const log = opts.log ?? (() => {});
  let port = opts.port ?? 4600;

  const tokenOk = (given: string | undefined) => {
    if (!given) return false;
    const a = Buffer.from(given), b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const project = (id: string) => {
    const p = store.getProject(id);
    if (!p) throw new HttpError(404, "No such project");
    return p;
  };

  async function api(method: string, parts: string[], url: URL, body: any): Promise<unknown> {
    // /api/projects
    if (parts.length === 1 && parts[0] === "projects" && method === "GET")
      return store.listProjects().map((p) => ({ ...p, ...recorderState(p.id), stats: store.stats(p.id), folder: store.projectSettings(p.id).folder ?? null }));

    // Folders you worked in with Claude Code that Dena does not know yet. Read-only; nothing is recorded.
    if (parts[0] === "discover" && parts.length === 1 && method === "GET") return { folders: suggestions() };
    if (parts[0] === "discover" && parts[1] === "dismiss" && method === "POST") {
      const dir = String(body?.path ?? "");
      fs.writeFileSync(dismissedFile, JSON.stringify([...new Set([...dismissed(), dir])], null, 2));
      return { folders: suggestions() };
    }

    // Browse folders inside your home folder, to pick one to add. Names only; nothing is read inside them.
    if (parts[0] === "browse" && parts.length === 1 && method === "GET") {
      const home = fs.realpathSync(os.homedir());
      const asked = String(url.searchParams.get("path") ?? "").replace(/^~(?=\/|$)/, home) || home;
      let dir: string;
      try {
        dir = fs.realpathSync(asked);
      } catch {
        throw new HttpError(404, "That folder does not exist");
      }
      if (dir !== home && !dir.startsWith(`${home}/`)) throw new HttpError(403, "Browsing is limited to your home folder");
      const used = new Set(foldersUsedWithClaude(opts.recorder?.claudeHome).map((f) => f.path));
      const known = new Set(store.listProjects().map((x) => x.rootPath));
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        throw new HttpError(403, "Dena cannot open that folder");
      }
      const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !["node_modules", "Library"].includes(e.name) || (e.isSymbolicLink() && !e.name.startsWith(".")))
        .map((e) => path.join(dir, e.name))
        .filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } })
        .sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { sensitivity: "base" }))
        .slice(0, 500)
        .map((d) => ({ name: path.basename(d), path: d, git: fs.existsSync(path.join(d, ".git")), claude: used.has(d), added: known.has(d) }));
      return { path: dir, parent: dir === home ? null : path.dirname(dir), home, git: fs.existsSync(path.join(dir, ".git")), claude: used.has(dir), added: known.has(dir), dirs };
    }

    // Add a project and import its past: Claude Code's transcripts and git history. No model is used.
    if (parts.length === 1 && parts[0] === "projects" && method === "POST") {
      const raw = String(body?.path ?? "").trim().replace(/^~(?=\/|$)/, os.homedir());
      if (!raw || !path.isAbsolute(raw)) throw new HttpError(400, "Give the folder's full path, like ~/code/my-app");
      let dir: string;
      try {
        dir = fs.realpathSync(raw);
        if (!fs.statSync(dir).isDirectory()) throw new Error();
      } catch {
        throw new HttpError(400, "That folder does not exist");
      }
      if (!isWorkFolder(dir)) throw new HttpError(400, "That looks like a system or temporary folder, not a project");
      const existing = store.listProjects().find((x) => x.rootPath === dir);
      if (existing) throw new HttpError(409, `"${existing.name}" already covers that folder`);
      const name = String(body?.name ?? "").trim().slice(0, 80) || path.basename(dir);
      const created = store.createProject(name, dir);
      const before = (store.db.prepare("SELECT MAX(id) n FROM event").get() as { n: number | null }).n ?? 0;
      await importChangedTranscripts(store, created.id, dir, { claudeHome: opts.recorder?.claudeHome });
      importGitIfChanged(store, created.id, dir);
      correlate(store, created.id);
      const q = (sql: string) => store.db.prepare(`SELECT ${sql} FROM event WHERE project_id = ? AND id > ?`).get(created.id, before) as any;
      const span = q("MIN(occurred_at) f, MAX(occurred_at) t, COUNT(*) n");
      log(`added project ${name} (${dir}): ${span.n} events from its past`);
      return {
        project: created,
        imported: { events: span.n, from: span.f, to: span.t,
          conversations: q("COUNT(DISTINCT session_id) n").n === 0 ? 0 : count(created.id, "COUNT(DISTINCT session_id)", "event_type = 'prompt_submitted' AND actor = 'user'"),
          prompts: count(created.id, "COUNT(*)", "event_type = 'prompt_submitted' AND actor = 'user'"),
          commits: count(created.id, "COUNT(*)", "event_type = 'git_commit'") },
        transcriptsKeptDays: transcriptRetentionDays(),
      };
    }
    if (parts[0] !== "projects" || !parts[1]) throw new HttpError(404, "Not found");
    const p = project(parts[1]);
    const sub = parts.slice(2);

    // Remove a project from Dena: its recorded history, explanations and pages. The folder and
    // its files are never touched. Recording and anything running for it stop first.
    if (sub.length === 0 && method === "DELETE") {
      const elsewhere = !recorders.has(p.id) ? liveRecorder(store, p.id) : null;
      if (elsewhere) throw new HttpError(409, `Another Dena (pid ${elsewhere.pid}) is recording this project. Stop it there first.`);
      const rec = recorders.get(p.id);
      if (rec) {
        recorders.delete(p.id);
        await rec.stop();
      }
      for (const [key, c] of inFlight) if (key.startsWith(`${p.id}:`)) c.abort();
      cancelQueued(store, p.id);
      const t = timers.get(p.id);
      if (t) clearTimeout(t);
      timers.delete(p.id);
      resumable.delete(p.id);
      // Not suggested again under "Worked in recently": you just chose to remove it.
      fs.writeFileSync(dismissedFile, JSON.stringify([...new Set([...dismissed(), p.rootPath])], null, 2));
      store.deleteProject(p.id);
      log(`removed project ${p.name} from Dena (its folder ${p.rootPath} is untouched)`);
      return { removed: true, name: p.name, folder: p.rootPath };
    }

    if (sub.length === 1 && sub[0] === "overview" && method === "GET") {
      const recent = store.db.prepare("SELECT id FROM event WHERE project_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 12").all(p.id) as { id: number }[];
      const explained = (store.db.prepare("SELECT COUNT(DISTINCT unit_id) n FROM explanation WHERE project_id = ?").get(p.id) as { n: number }).n;
      const episodes = loadEpisodes(store, p.id);
      return {
        project: { ...p, ...recorderState(p.id) },
        settings: store.projectSettings(p.id),
        stats: store.stats(p.id),
        sources: {
          git: git.isGitRepo(p.rootPath),
          hooksProject: hookInstall.installedIn("project", p.rootPath),
          hooksUser: hookInstall.installedIn("user"),
        },
        gaps: store.gaps(p.id),
        recent: compactAll(store, p.id, store.eventsById(p.id, recent.map((r) => r.id)).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))),
        authors: authorSummary(store, p.id),
        catchUp: catchUp(p.id),
        pausedWindows: pausedWindows(store, p.id).length,
        episodes: { total: episodes.length, explained, latest: episodes.slice(-5).reverse() },
      };
    }

    if (sub[0] === "episodes" && sub.length === 1 && method === "GET") {
      let eps = loadEpisodes(store, p.id);
      if (!eps.length || url.searchParams.get("rebuild") === "1") {
        rebuildEpisodes(store, p.id);
        eps = loadEpisodes(store, p.id);
      }
      const explained = new Set((store.db.prepare("SELECT DISTINCT unit_id FROM explanation WHERE project_id = ?").all(p.id) as { unit_id: string }[]).map((r) => r.unit_id));
      const chapters = episodeChapters(store, p.id, eps);
      return eps.map((e) => {
        const step = explained.has(e.id) ? activeRevision(store, p.id, "step", e.id)?.content : null;
        const ch = chapters.get(e.id);
        return { ...e, explained: explained.has(e.id), stepTitle: step?.title ?? null, instructions: !!step?.instructions?.length,
          chapter: ch ? { key: ch.key, areas: ch.areas.slice(0, 3), startedAt: ch.startedAt } : null };
      });
    }

    if (sub[0] === "episodes" && sub[2] === "events" && method === "GET") return compactAll(store, p.id, episodeEvents(store, p.id, sub[1]!));

    if (sub[0] === "episodes" && sub[2] === "explanation" && method === "GET") {
      const all = storedExplanations(store, p.id, sub[1]!);
      const latestPerModel = [...new Map(all.map((x) => [`${x.requestedModel || x.model}|${x.depth}`, x])).values()];
      const settings = store.projectSettings(p.id);
      return { explanations: latestPerModel, estimate: estimate(store, p.id, [sub[1]!]), settings: { model: settings.model ?? null, depth: settings.depth },
        busy: inFlight.has(`${p.id}:${sub[1]}`) };
    }

    if (sub[0] === "episodes" && sub[2] === "stop" && method === "POST") {
      const c = inFlight.get(`${p.id}:${sub[1]}`);
      c?.abort();
      return { stopping: !!c };
    }

    if (sub[0] === "wiki" && sub[1] === "stop" && method === "POST") {
      const c = inFlight.get(`${p.id}:wiki:${String(body?.key ?? "")}`);
      c?.abort();
      return { stopping: !!c };
    }

    if (sub[0] === "episodes" && sub[2] === "explain" && method === "POST") {
      const unit = sub[1]!;
      if (!loadEpisodes(store, p.id).some((e) => e.id === unit)) throw new HttpError(404, "No such step");
      const model = body?.model ?? undefined;
      if (model !== undefined && (typeof model !== "string" || !MODEL_NAME.test(model))) throw new HttpError(400, "Invalid model name");
      const key = `${p.id}:${unit}`;
      if (inFlight.has(key)) throw new HttpError(409, "This step is already being explained");
      const controller = new AbortController();
      inFlight.set(key, controller);
      try {
        const x = await explainEpisode(store, p.id, unit, getProvider(p.id), { model, force: body?.force === true, signal: controller.signal, log: (m) => log(`[${p.name}] ${m}`) });
        return { unitId: x.unitId, cached: x.cached, model: x.model, costUsd: x.costUsd, ok: x.validation.ok };
      } catch (e) {
        if (stopped(e)) throw new HttpError(409, (e as Error).message);
        const msg = (e as Error).message;
        log(`[${p.name}] explain failed: ${msg}`);
        // Messages from explainFailure are written for users and contain no project content.
        throw new HttpError(502, /^(Claude Code|Claude is|Your Anthropic|No valid API key)/.test(msg) ? msg : "The model call failed. Check Claude Code's sign-in, then try again.");
      } finally {
        inFlight.delete(key);
      }
    }

    if (sub[0] === "memory" && method === "GET") {
      ensureMemory(store, p.id, { force: url.searchParams.get("rebuild") === "1" });
      const all = loadMemory(store, p.id);
      const eps = Object.fromEntries(loadEpisodes(store, p.id).map((e) => [e.id, { position: e.position, title: e.title }]));
      const of = (k: string) => all.filter((m) => m.kind === k);
      return { components: of("component"), problems: of("problem").sort((a, b) => b.sortKey - a.sortKey), decisions: of("decision"),
        concepts: of("concept"), questions: of("question"), episodes: eps,
        explainedEpisodes: (store.db.prepare("SELECT COUNT(DISTINCT unit_id) n FROM explanation WHERE project_id = ?").get(p.id) as { n: number }).n };
    }

    if (sub[0] === "wiki" && sub.length === 1 && method === "GET") {
      return sectionKeys(store, p.id).map((s) => {
        const brief = buildBrief(store, p.id, s.key);
        const active = ensureDocRevision(store, p.id, "wiki", s.key); // what the page shows, which may be restored or edited
        return { ...s, sources: brief.sources.length, chars: brief.chars, generated: !!active, stale: !!active && active.meta.inputHash !== brief.hash, model: active?.meta.model ?? null };
      });
    }

    if (sub[0] === "wiki" && sub[1] === "section") {
      const key = (method === "GET" ? url.searchParams.get("key") : body?.key) as SectionKey | null;
      if (!key || !sectionKeys(store, p.id).some((s) => s.key === key)) throw new HttpError(404, "No such section");
      if (method === "GET") {
        const brief = buildBrief(store, p.id, key);
        const settings = store.projectSettings(p.id);
        return { section: storedSection(store, p.id, key, brief.hash), brief: { sources: brief.sources.length, chars: brief.chars, tokens: estimateSectionTokens(store, p.id, brief) },
          settings: { model: settings.model ?? null } };
      }
      if (method !== "POST") throw new HttpError(405, "Method not allowed");
      const model = body?.model ?? undefined;
      if (model !== undefined && (typeof model !== "string" || !MODEL_NAME.test(model))) throw new HttpError(400, "Invalid model name");
      const flight = `${p.id}:wiki:${key}`;
      if (inFlight.has(flight)) throw new HttpError(409, "This page is already being written");
      const controller = new AbortController();
      inFlight.set(flight, controller);
      try {
        const s = await generateSection(store, p.id, key, getProvider(p.id), { model, force: body?.force === true, signal: controller.signal, log: (m) => log(`[${p.name}] wiki ${key}: ${m}`) });
        return { key, cached: s.cached, ok: s.validation.ok, model: s.model };
      } catch (e) {
        if (stopped(e)) throw new HttpError(409, (e as Error).message);
        const msg = (e as Error).message;
        log(`[${p.name}] wiki ${key} failed: ${msg}`);
        throw new HttpError(502, /^(Claude Code|Claude is|Your Anthropic|No valid API key|There is no captured)/.test(msg) ? msg : "The model call failed. Check Claude Code's sign-in, then try again.");
      } finally {
        inFlight.delete(flight);
      }
    }

    if (sub[0] === "code") {
      const settings = store.projectSettings(p.id);
      if (sub.length === 1 && method === "GET") return { files: codeOverview(store, p.id), settings: { model: settings.model ?? null } };
      if (sub[1] === "folder" || sub[1] === "explain-folder" || (sub[1] === "stop" && body?.folder)) {
        const dir = String((method === "GET" ? url.searchParams.get("dir") : body?.dir ?? body?.folder) ?? "");
        if (!dir || !codeOverview(store, p.id).some((f) => inFolder(f.path, dir))) throw new HttpError(404, "No such folder");
        const flight = `${p.id}:code-folder:${dir}`;
        const model = (method === "GET" ? url.searchParams.get("model") : body?.model) || undefined;
        if (model !== undefined && (typeof model !== "string" || !MODEL_NAME.test(model))) throw new HttpError(400, "Invalid model name");
        if (sub[1] === "folder" && method === "GET") return { plan: folderPlan(store, p.id, dir, model), progress: folderProgress.get(flight) ?? null, settings: { model: settings.model ?? null } };
        if (sub[1] === "stop" && method === "POST") {
          const c = inFlight.get(flight);
          c?.abort();
          return { stopping: !!c };
        }
        if (sub[1] === "explain-folder" && method === "POST") {
          if (inFlight.has(flight)) throw new HttpError(409, "This folder is already being explained");
          const controller = new AbortController();
          inFlight.set(flight, controller);
          try {
            return await explainFolder(store, p.id, dir, getProvider(p.id), { model, signal: controller.signal, log: (m) => log(`[${p.name}] code ${m}`),
              onProgress: (pr) => folderProgress.set(flight, pr) });
          } catch (e) {
            if (stopped(e)) throw new HttpError(409, "Stopped. Files explained before you stopped are kept.");
            const msg = (e as Error).message;
            log(`[${p.name}] code folder ${dir} failed: ${msg}`);
            throw new HttpError(502, /^(Claude Code|Claude is|Your Anthropic|No valid API key)/.test(msg) ? msg : "The model call failed. Check Claude Code's sign-in, then try again.");
          } finally {
            inFlight.delete(flight);
            folderProgress.delete(flight);
          }
        }
      }
      const file = String((method === "GET" ? url.searchParams.get("path") : body?.path) ?? "");
      const flight = `${p.id}:code:${file}`;
      const page = () => {
        try {
          return codePage(store, p.id, file);
        } catch (e) {
          throw new HttpError(404, (e as Error).message);
        }
      };
      if (sub[1] === "file" && method === "GET") return { ...page(), settings: { model: settings.model ?? null }, busy: inFlight.has(flight) };
      if (sub[1] === "export" && method === "GET") return { filename: `${file.replace(/[^\w.-]+/g, "_")}.md`, markdown: renderCodeMarkdown(page()) };
      if (sub[1] === "stop" && method === "POST") {
        const c = inFlight.get(flight);
        c?.abort();
        return { stopping: !!c };
      }
      if (sub[1] === "explain" && method === "POST") {
        page(); // 404 for anything Dena does not explain
        const model = body?.model ?? undefined;
        if (model !== undefined && (typeof model !== "string" || !MODEL_NAME.test(model))) throw new HttpError(400, "Invalid model name");
        const only = Array.isArray(body?.only) ? (body.only as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
        if (inFlight.has(flight)) throw new HttpError(409, "This file is already being explained");
        const controller = new AbortController();
        inFlight.set(flight, controller);
        try {
          const r = await explainFile(store, p.id, file, getProvider(p.id), { model, force: body?.force === true, only, signal: controller.signal, log: (m) => log(`[${p.name}] code ${m}`) });
          return r;
        } catch (e) {
          if (stopped(e)) throw new HttpError(409, (e as Error).message);
          const msg = (e as Error).message;
          log(`[${p.name}] code ${file} failed: ${msg}`);
          throw new HttpError(502, /^(Claude Code|Claude is|Your Anthropic|No valid API key)/.test(msg) ? msg : "The model call failed. Check Claude Code's sign-in, then try again.");
        } finally {
          inFlight.delete(flight);
        }
      }
    }

    if (sub[0] === "updates") {
      if (method === "GET") {
        const all = findOutdated(store, p.id);
        const outdated = all.filter((o) => !o.waiting);
        // Targeted updates send only what changed, so the estimate comes from each document's plan.
        const plans = outdated.map((o) => planUpdate(store, p.id, o.type, o.key)?.estimate).filter((x): x is NonNullable<typeof x> => !!x);
        const tokens = { prompt: plans.reduce((n, t) => n + t.promptTokens, 0), output: plans.reduce((n, t) => n + t.outputTokens, 0),
          low: plans.reduce((n, t) => n + t.low, 0), high: plans.reduce((n, t) => n + t.high, 0), calibrated: plans.every((t) => t.calibrated), basis: plans[0]?.basis ?? "" };
        return { outdated, waiting: all.filter((o) => o.waiting), estimate: null, tokens, waitingFromBefore: resumable.has(p.id) && !runners.has(p.id), jobs: listJobs(store, p.id, 30), running: runners.has(p.id),
          settings: { model: store.projectSettings(p.id).model ?? null, maxUsdPerRun: store.projectSettings(p.id).maxUsdPerRun ?? null, maxTokensPerRun: store.projectSettings(p.id).maxTokensPerRun ?? null } };
      }
      if (method !== "POST") throw new HttpError(405, "Method not allowed");
      if (sub[1] === "run") {
        const outdated = findOutdated(store, p.id).filter((o) => !o.waiting);
        const wanted = Array.isArray(body?.items) ? outdated.filter((o) => body.items.some((i: any) => i?.type === o.type && i?.key === o.key)) : outdated;
        const queued = enqueue(store, p.id, wanted.map((o) => ({ type: o.type, key: o.key })));
        resumable.delete(p.id);
        runUpdates(p.id);
        return { queued };
      }
      if (sub[1] === "resume") {
        resumable.delete(p.id);
        runUpdates(p.id);
        return { resumed: true };
      }
      if (sub[1] === "cancel") {
        resumable.delete(p.id);
        return { cancelled: cancelQueued(store, p.id) };
      }
      throw new HttpError(404, "Not found");
    }

    if (sub[0] === "export" && method === "GET" && url.searchParams.get("format") === "html") {
      const r = exportGuideHtml(store, p.id);
      return { filename: `${p.name.replace(/[^\w.-]+/g, "-")}-guide.html`, html: r.html, counts: r.counts };
    }

    if (sub[0] === "export" && method === "GET") {
      const r = exportGuideMarkdown(store, p.id);
      return { filename: `${p.name.replace(/[^\w.-]+/g, "-")}-guide.md`, markdown: r.markdown, counts: r.counts };
    }

    if (sub[0] === "guide" && ["plan", "explain-rest", "stop"].includes(sub[1] ?? "")) {
      const flight = `${p.id}:guide-batch`;
      const model = (method === "GET" ? url.searchParams.get("model") : body?.model) || undefined;
      if (model !== undefined && (typeof model !== "string" || !MODEL_NAME.test(model))) throw new HttpError(400, "Invalid model name");
      if (sub[1] === "plan" && method === "GET") {
        const cov = stepCoverage(store, p.id);
        const est = cov.missing.length ? estimate(store, p.id, cov.missing, { model }) : null;
        return { steps: cov.steps.length, explained: cov.explained.length, missing: cov.missing.length, estimate: est,
          progress: batchProgress.get(flight) ?? null, settings: { model: store.projectSettings(p.id).model ?? null, depth: store.projectSettings(p.id).depth } };
      }
      if (sub[1] === "stop" && method === "POST") {
        const c = inFlight.get(flight);
        c?.abort();
        return { stopping: !!c };
      }
      if (sub[1] === "explain-rest" && method === "POST") {
        if (inFlight.has(flight)) throw new HttpError(409, "Steps are already being explained");
        const ids = stepCoverage(store, p.id).missing;
        const controller = new AbortController();
        inFlight.set(flight, controller);
        let done = 0;
        batchProgress.set(flight, { done: 0, total: ids.length, current: null });
        try {
          const r = await explainMany(store, p.id, ids, getProvider(p.id), { model, signal: controller.signal, log: (m) => log(`[${p.name}] guide: ${m}`),
            onProgress: () => batchProgress.set(flight, { done: ++done, total: ids.length, current: null }) });
          return { explained: r.explained.filter((x) => !x.cached).length, leftForNextRun: r.skippedForBudget.length, spentTokens: r.spentTokens, calls: r.calls };
        } catch (e) {
          if (stopped(e)) throw new HttpError(409, "Stopped. Steps explained before you stopped are kept.");
          const msg = (e as Error).message;
          log(`[${p.name}] guide batch failed: ${msg}`);
          throw new HttpError(502, /^(Claude Code|Claude is|Your Anthropic|No valid API key)/.test(msg) ? msg : "The model call failed. Check Claude Code's sign-in, then try again.");
        } finally {
          inFlight.delete(flight);
          batchProgress.delete(flight);
        }
      }
    }

    if (sub[0] === "tutorial") {
      const model = (method === "GET" ? url.searchParams.get("model") : body?.model) || undefined;
      if (model !== undefined && (typeof model !== "string" || !MODEL_NAME.test(model))) throw new HttpError(400, "Invalid model name");
      if (sub[1] === "plan" && method === "GET") return { ...tutorialPlan(store, p.id, model), model: model ?? store.projectSettings(p.id).model ?? null };
      if (sub[1] === "write" && method === "POST") {
        const flight = `${p.id}:wiki:tutorial`; // the page's Stop button ends it
        if (inFlight.has(flight)) throw new HttpError(409, "The tutorial is already being written");
        const controller = new AbortController();
        inFlight.set(flight, controller);
        try {
          const r = await writeTutorial(store, p.id, getProvider(p.id), { explainRest: body?.explainRest === true, model, signal: controller.signal, log: (m) => log(`[${p.name}] tutorial: ${m}`) });
          return { explainedNow: r.explainedNow, ok: r.page.validation.ok, model: r.page.model };
        } catch (e) {
          if (stopped(e)) throw new HttpError(409, (e as Error).message);
          const msg = (e as Error).message;
          log(`[${p.name}] tutorial failed: ${msg}`);
          throw new HttpError(502, /^(Claude Code|Claude is|Your Anthropic|No valid API key|There is no captured)/.test(msg) ? msg : "The model call failed. Check Claude Code's sign-in, then try again.");
        } finally {
          inFlight.delete(flight);
        }
      }
    }

    if (sub[0] === "how-built" && method === "GET") {
      const type = url.searchParams.get("type");
      const key = String(url.searchParams.get("key") ?? "");
      if (type === "step" && loadEpisodes(store, p.id).some((e) => e.id === key)) return howBuiltStep(store, p.id, key);
      if (type === "wiki" && sectionKeys(store, p.id).some((s) => s.key === key)) return howBuiltPage(store, p.id, key);
      throw new HttpError(404, "No such document");
    }

    if (sub[0] === "doc") {
      const type = (method === "GET" ? url.searchParams.get("type") : body?.type) as DocType;
      const key = String((method === "GET" ? url.searchParams.get("key") : body?.key) ?? "");
      if (type !== "step" && type !== "wiki") throw new HttpError(400, "type is step or wiki");
      const valid = type === "step" ? loadEpisodes(store, p.id).some((e) => e.id === key) : sectionKeys(store, p.id).some((s) => s.key === key);
      if (!valid) throw new HttpError(404, "No such document");
      const action = sub[1] ?? "";
      if (method === "GET" && !action) {
        const active = ensureDocRevision(store, p.id, type, key);
        let stale = false;
        if (active)
          stale = type === "step"
            ? !packetMatches(buildPacket(store, p.id, key, { depth: active.meta.depth ?? store.projectSettings(p.id).depth }), active.meta.packetHash)
            : buildBrief(store, p.id, key as SectionKey).hash !== active.meta.inputHash;
        const slim = (r: ReturnType<typeof activeRevision>) => r && { id: r.id, origin: r.origin, status: r.status, note: r.note, createdAt: r.createdAt, model: r.meta.model ?? null, userEdited: !!r.meta.userEdited };
        const proposed = proposedRevision(store, p.id, type, key);
        // What a targeted update would keep and send, for the estimate before running it.
        const plan = stale && !proposed ? planUpdate(store, p.id, type, key) : null;
        const update = plan && { kept: plan.kept.length, review: plan.affected.length, fresh: plan.fresh.length, send: plan.sendRefs.length, of: plan.allRefs, needsModel: plan.needsModel, estimate: plan.estimate };
        return { active, proposed, stale, update, busy: inFlight.has(type === "step" ? `${p.id}:${key}` : `${p.id}:wiki:${key}`),
          history: revisions(store, p.id, type, key).map(slim), notes: notesFor(store, p.id, type, key, { all: true }) };
      }
      if (method === "GET" && action === "revision") {
        const r = revisions(store, p.id, type, key).find((x) => x.id === Number(url.searchParams.get("id")));
        if (!r) throw new HttpError(404, "No such revision");
        return { revision: r };
      }
      if (method !== "POST") throw new HttpError(405, "Method not allowed");
      if (action === "update") {
        const model = body?.model ?? undefined;
        if (model !== undefined && (typeof model !== "string" || !MODEL_NAME.test(model))) throw new HttpError(400, "Invalid model name");
        const flight = type === "step" ? `${p.id}:${key}` : `${p.id}:wiki:${key}`; // the same Stop buttons end it
        if (inFlight.has(flight)) throw new HttpError(409, "This document is already being written");
        const controller = new AbortController();
        inFlight.set(flight, controller);
        try {
          const o = { model, signal: controller.signal, log: (m: string) => log(`[${p.name}] update ${type} ${key}: ${m}`) };
          const r = type === "step" ? await updateStep(store, p.id, key, getProvider(p.id), o) : await updateSection(store, p.id, key as SectionKey, getProvider(p.id), o);
          return { diff: r.diff, calledModel: r.calledModel, ok: r.ok, tokens: r.tokens };
        } catch (e) {
          if (stopped(e)) throw new HttpError(409, (e as Error).message);
          const msg = (e as Error).message;
          log(`[${p.name}] update ${type} ${key} failed: ${msg}`);
          throw new HttpError(502, /^(Claude Code|Claude is|Your Anthropic|No valid API key|This (episode|page))/.test(msg) ? msg : "The model call failed. Check Claude Code's sign-in, then try again.");
        } finally {
          inFlight.delete(flight);
        }
      }
      if (["edit", "restore", "adopt", "decline"].includes(action) && inFlight.has(type === "step" ? `${p.id}:${key}` : `${p.id}:wiki:${key}`))
        throw new HttpError(409, "This is being written right now. Wait for it to finish (or press Stop), then try again.");
      try {
        if (action === "edit") {
          const parsed = (type === "step" ? Step : WikiSection).safeParse(body?.content);
          if (!parsed.success) throw new HttpError(400, "The edited document is not in the expected shape");
          const note = typeof body?.note === "string" ? body.note.slice(0, 500) : undefined;
          return saveUserEdit(store, p.id, type, key, parsed.data, Number(body?.baseId), note);
        }
        if (action === "adopt") return adoptUpdate(store, p.id, type, key, Number(body?.id));
        if (action === "decline") return declineProposed(store, p.id, type, key, Number(body?.id)), { ok: true };
        if (action === "restore") return restoreRevision(store, p.id, type, key, Number(body?.id));
        if (action === "note") {
          const kind = body?.kind;
          if (!["context", "incorrect", "incomplete"].includes(kind)) throw new HttpError(400, "kind is context, incorrect or incomplete");
          const text = String(body?.text ?? "").trim().slice(0, 2_000);
          if (!text && kind === "context") throw new HttpError(400, "Write the context first");
          return addNote(store, p.id, type, key, { kind, text, target: typeof body?.target === "string" ? body.target.slice(0, 500) : null });
        }
        if (action === "dismiss-note") return dismissNote(store, p.id, Number(body?.id)), { ok: true };
      } catch (e) {
        if (e instanceof RevisionConflict) throw new HttpError(409, e.message);
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, (e as Error).message);
      }
      throw new HttpError(404, "Not found");
    }

    if (sub[0] === "activity" && method === "GET") {
      // Built from events on each request (no model, ~0.1s for thousands of events).
      const id = url.searchParams.get("id");
      const sessions = buildActivityLog(store, p.id, id ? { sessionId: id === "outside" ? "__none__" : id } : {});
      if (!sub[1]) return sessions.map(({ entries, ...s }) => ({ ...s, entryCount: entries.length }));
      const s = id === "outside" ? buildActivityLog(store, p.id).find((x) => x.id === "outside") : sessions[0];
      if (!s) throw new HttpError(404, "No such session");
      if (sub[1] === "session") return s;
      if (sub[1] === "export") {
        const kinds = (url.searchParams.get("kinds")?.split(",").filter(Boolean) ?? DEFAULT_KINDS) as ActivityKind[];
        return { filename: `${p.name.replace(/[^\w.-]+/g, "-")}-ai-log-${s.startedAt.slice(0, 10)}.md`, markdown: renderActivityMarkdown(p.name, s, kinds) };
      }
      throw new HttpError(404, "Not found");
    }

    if (sub[0] === "about" && method === "GET") return { limitations: standingLimitations(store, p.id) };

    if (sub[0] === "auth" && method === "GET") {
      if (opts.provider) return { found: true, loggedIn: true, method: "test", detail: "Test provider", auth: "account" };
      const auth = store.projectSettings(p.id).auth ?? "account";
      return { ...claudeAuthStatus(auth), auth };
    }

    if (sub[0] === "settings" && sub.length === 1) {
      if (method === "POST") {
        const patch: Record<string, unknown> = {};
        if ("model" in (body ?? {})) {
          if (body.model !== null && (typeof body.model !== "string" || !MODEL_NAME.test(body.model))) throw new HttpError(400, "Invalid model name");
          patch.model = body.model ?? undefined;
        }
        if ("auth" in (body ?? {})) {
          if (body.auth !== "account" && body.auth !== "api-key") throw new HttpError(400, "auth is account or api-key");
          patch.auth = body.auth;
        }
        if ("depth" in (body ?? {})) {
          if (body.depth !== "concise" && body.depth !== "thorough") throw new HttpError(400, "depth is concise or thorough");
          patch.depth = body.depth;
        }
        if ("folder" in (body ?? {})) {
          const f = body.folder;
          if (f !== null && (typeof f !== "string" || f.trim().length > 60)) throw new HttpError(400, "A folder name is up to 60 characters, or none");
          patch.folder = f === null || !f.trim() ? undefined : f.trim();
        }
        if ("maxTokensPerRun" in (body ?? {})) {
          const v = body.maxTokensPerRun;
          if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 5_000)) throw new HttpError(400, "The budget is a number of tokens, at least 5,000, or none");
          patch.maxTokensPerRun = v ?? undefined;
        }
        store.updateProjectSettings(p.id, patch);
      } else if (method !== "GET") throw new HttpError(405, "Method not allowed");
      const s2 = store.projectSettings(p.id);
      return { model: s2.model ?? null, depth: s2.depth, auth: s2.auth ?? "account", maxUsdPerRun: s2.maxUsdPerRun ?? null, maxTokensPerRun: s2.maxTokensPerRun ?? null, folder: s2.folder ?? null };
    }

    if (sub[0] === "events" && sub.length === 2 && method === "GET") {
      const id = Number(sub[1]);
      const [e] = store.eventsById(p.id, [id]);
      if (!e) throw new HttpError(404, "No such event");
      const links = store.linksFor(id);
      const others = new Map(store.eventsById(p.id, links.map((l) => l.otherId)).map((o) => [o.id, o]));
      const unit = store.db.prepare("SELECT unit_id FROM work_unit_event WHERE project_id = ? AND event_id = ?").get(p.id, id) as { unit_id: string } | undefined;
      return {
        event: { ...e, summary: displaySummary(e), capturedSummary: e.summary },
        episode: unit?.unit_id ?? null,
        links: links.map((l) => ({ ...l, other: others.has(l.otherId) ? compact(others.get(l.otherId)!) : null })),
        likelyAuthor: e.actor === "unknown" ? likelyAuthors(store, p.id, [id]).get(id) ?? null : null,
        artifacts: store.artifactsFor(id).map((a) => {
          const buf = store.blobs.get(a.contentHash);
          const text = buf ? buf.toString("utf8") : null;
          return { ...a, content: text && text.length > ARTIFACT_LIMIT ? text.slice(0, ARTIFACT_LIMIT) : text, truncated: !!text && text.length > ARTIFACT_LIMIT };
        }),
      };
    }

    if (sub[0] === "search" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const hits = store.search(p.id, q, 60);
      const rows = compactAll(store, p.id, hits.map((h) => h.event));
      return rows.map((r, i) => ({ ...r, snippet: hits[i]!.snippet }));
    }

    if (sub[0] === "recording" && method === "POST") {
      const action = body?.action;
      const running = recorders.get(p.id);
      if (action === "start") {
        if (running) return { state: store.getProject(p.id)!.recordingState, ...recorderState(p.id) };
        const other = liveRecorder(store, p.id);
        if (other) throw new HttpError(409, `This project is already being recorded by another Dena process (pid ${other.pid}). Stop that one first.`);
        const rec = new Recorder(store, p.id, { ...opts.recorder, log: (m) => log(`[${p.name}] ${m}`) });
        recorders.set(p.id, rec);
        await rec.start();
      } else if (action === "pause" || action === "resume") {
        if (!running) throw new HttpError(409, "Not recording");
        store.setRecordingState(p.id, action === "pause" ? "paused" : "recording"); // the recorder applies it on its next tick
      } else if (action === "stop") {
        if (running) {
          recorders.delete(p.id);
          await running.stop();
        }
      } else throw new HttpError(400, "action must be start, pause, resume or stop");
      return { state: store.getProject(p.id)!.recordingState, ...recorderState(p.id), catchUp: action === "start" ? catchUp(p.id) : null };
    }

    throw new HttpError(404, "Not found");
  }

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
    let file = path.resolve(webDir, rel);
    if (!file.startsWith(webDir + path.sep) && file !== webDir) throw new HttpError(403, "Forbidden");
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(webDir, "index.html"); // client-side routes
    if (!fs.existsSync(file)) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("The web UI has not been built yet. Run: npm run build:web");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      // The page names this build's scripts, so it is never reused from cache after an update;
      // the scripts' own names change with every build, so they can be cached.
      "cache-control": path.basename(file) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer", // the token in the URL must not leak to other sites
      "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    });
    fs.createReadStream(file).pipe(res);
    void req;
  }

  const server = http.createServer(async (req, res) => {
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify(data));
    };
    try {
      const host = req.headers.host ?? "";
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(421, "Unexpected Host header");
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (!url.pathname.startsWith("/api/")) return serveStatic(req, res, url.pathname);
      if (!tokenOk(req.headers["x-dena-token"] as string | undefined)) throw new HttpError(401, "Missing or wrong token");
      let body: any = null;
      if (req.method === "POST") {
        if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "JSON only");
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 100_000) throw new HttpError(413, "Too large");
        }
        body = raw ? JSON.parse(raw) : null;
      }
      const parts = url.pathname.slice("/api/".length).split("/").filter(Boolean);
      send(200, await api(req.method ?? "GET", parts, url, body));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log(`server error: ${(err as Error).message}`);
      // Never echo internals or project content in errors.
      send(status, { error: err instanceof HttpError ? err.message : "Internal error" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  port = (server.address() as { port: number }).port;
  await resumeLeftOn();
  return {
    url: `http://127.0.0.1:${port}/#t=${token}`,
    port,
    token,
    async close() {
      for (const t of timers.values()) clearTimeout(t);
      await Promise.allSettled(runners.values());
      for (const [id, r] of recorders) {
        recorders.delete(id);
        await r.stop();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
