import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { displaySummary, effectiveTest, type StoredEvent, type Store } from "@dena/core";
import { git, hookInstall, Recorder } from "@dena/adapters";
import { cancelQueued, enqueue, findOutdated, listJobs, processDueJobs, recoverJobs,
  ensureDocRevision, exportGuideMarkdown, activeRevision, addNote, adoptProposed, buildPacket, declineProposed, dismissNote, notesFor, proposedRevision, recordGenerated, restoreRevision, revisions,
  RevisionConflict, saveUserEdit, Step, WikiSection, type DocType,
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

const compact = (e: StoredEvent) => ({
  id: e.id, type: e.eventType, actor: e.actor, source: e.source, summary: displaySummary(e), at: e.occurredAt,
  confidence: e.captureConfidence, notable: NOTABLE.has(e.eventType),
  outcome: e.eventType === "test_result" ? effectiveTest(e).outcome : (e.payload as any).status ?? null,
});

export async function startServer(store: Store, opts: ServerOptions = {}): Promise<RunningServer> {
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const webDir = opts.webDir ?? DEFAULT_WEB_DIR;
  const recorders = new Map<string, Recorder>();
  const inFlight = new Map<string, Promise<unknown>>();

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
  for (const p of store.listProjects())
    if (store.db.prepare("SELECT 1 FROM update_job WHERE project_id = ? AND status = 'queued'").get(p.id)) setTimeout(() => runUpdates(p.id), 2_000);
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
      return store.listProjects().map((p) => ({ ...p, recorderRunning: recorders.has(p.id), stats: store.stats(p.id) }));
    if (parts[0] !== "projects" || !parts[1]) throw new HttpError(404, "Not found");
    const p = project(parts[1]);
    const sub = parts.slice(2);

    if (sub.length === 1 && sub[0] === "overview" && method === "GET") {
      const recent = store.db.prepare("SELECT id FROM event WHERE project_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 12").all(p.id) as { id: number }[];
      const explained = (store.db.prepare("SELECT COUNT(DISTINCT unit_id) n FROM explanation WHERE project_id = ?").get(p.id) as { n: number }).n;
      const episodes = loadEpisodes(store, p.id);
      return {
        project: { ...p, recorderRunning: recorders.has(p.id) },
        settings: store.projectSettings(p.id),
        stats: store.stats(p.id),
        sources: {
          git: git.isGitRepo(p.rootPath),
          hooksProject: hookInstall.installedIn("project", p.rootPath),
          hooksUser: hookInstall.installedIn("user"),
        },
        gaps: store.gaps(p.id),
        recent: store.eventsById(p.id, recent.map((r) => r.id)).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).map(compact),
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
      return eps.map((e) => ({ ...e, explained: explained.has(e.id) }));
    }

    if (sub[0] === "episodes" && sub[2] === "events" && method === "GET") return episodeEvents(store, p.id, sub[1]!).map(compact);

    if (sub[0] === "episodes" && sub[2] === "explanation" && method === "GET") {
      const all = storedExplanations(store, p.id, sub[1]!);
      const latestPerModel = [...new Map(all.map((x) => [`${x.requestedModel || x.model}|${x.depth}`, x])).values()];
      const settings = store.projectSettings(p.id);
      return { explanations: latestPerModel, estimate: estimate(store, p.id, [sub[1]!]), settings: { model: settings.model ?? null, depth: settings.depth },
        busy: inFlight.has(`${p.id}:${sub[1]}`) };
    }

    if (sub[0] === "episodes" && sub[2] === "explain" && method === "POST") {
      const unit = sub[1]!;
      if (!loadEpisodes(store, p.id).some((e) => e.id === unit)) throw new HttpError(404, "No such episode");
      const model = body?.model ?? undefined;
      if (model !== undefined && (typeof model !== "string" || !MODEL_NAME.test(model))) throw new HttpError(400, "Invalid model name");
      const key = `${p.id}:${unit}`;
      if (inFlight.has(key)) throw new HttpError(409, "This episode is already being explained");
      const job = explainEpisode(store, p.id, unit, getProvider(p.id), { model, force: body?.force === true, log: (m) => log(`[${p.name}] ${m}`) });
      inFlight.set(key, job);
      try {
        const x = await job;
        return { unitId: x.unitId, cached: x.cached, model: x.model, costUsd: x.costUsd, ok: x.validation.ok };
      } catch (e) {
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
        const stored = storedSection(store, p.id, s.key, brief.hash);
        return { ...s, sources: brief.sources.length, chars: brief.chars, generated: !!stored, stale: stored?.stale ?? false, model: stored?.model ?? null };
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
      const job = generateSection(store, p.id, key, getProvider(p.id), { model, force: body?.force === true, log: (m) => log(`[${p.name}] wiki ${key}: ${m}`) });
      inFlight.set(flight, job);
      try {
        const s = await job;
        return { key, cached: s.cached, ok: s.validation.ok, model: s.model };
      } catch (e) {
        const msg = (e as Error).message;
        log(`[${p.name}] wiki ${key} failed: ${msg}`);
        throw new HttpError(502, /^(Claude Code|Claude is|Your Anthropic|No valid API key|There is no captured)/.test(msg) ? msg : "The model call failed. Check Claude Code's sign-in, then try again.");
      } finally {
        inFlight.delete(flight);
      }
    }

    if (sub[0] === "updates") {
      if (method === "GET") {
        const outdated = findOutdated(store, p.id);
        const steps = outdated.filter((o) => o.type === "step").map((o) => o.key);
        const est = steps.length ? estimate(store, p.id, steps, { force: true }) : null;
        const wikiTok = outdated.filter((o) => o.type === "wiki").map((o) => estimateSectionTokens(store, p.id, buildBrief(store, p.id, o.key as SectionKey)));
        const tokens = { prompt: (est?.promptTokens ?? 0) + wikiTok.reduce((n, t) => n + t.promptTokens, 0),
          output: (est?.outputTokens ?? 0) + wikiTok.reduce((n, t) => n + t.outputTokens, 0),
          low: (est?.tokensLow ?? 0) + wikiTok.reduce((n, t) => n + t.low, 0), high: (est?.tokensHigh ?? 0) + wikiTok.reduce((n, t) => n + t.high, 0),
          calibrated: (est?.tokensCalibrated ?? true) && wikiTok.every((t) => t.calibrated), basis: est?.tokenBasis ?? wikiTok[0]?.basis ?? "" };
        return { outdated, estimate: est, tokens, jobs: listJobs(store, p.id, 30), running: runners.has(p.id),
          settings: { model: store.projectSettings(p.id).model ?? null, maxUsdPerRun: store.projectSettings(p.id).maxUsdPerRun ?? null } };
      }
      if (method !== "POST") throw new HttpError(405, "Method not allowed");
      if (sub[1] === "run") {
        const outdated = findOutdated(store, p.id);
        const wanted = Array.isArray(body?.items) ? outdated.filter((o) => body.items.some((i: any) => i?.type === o.type && i?.key === o.key)) : outdated;
        const queued = enqueue(store, p.id, wanted.map((o) => ({ type: o.type, key: o.key })));
        runUpdates(p.id);
        return { queued };
      }
      if (sub[1] === "cancel") return { cancelled: cancelQueued(store, p.id) };
      throw new HttpError(404, "Not found");
    }

    if (sub[0] === "export" && method === "GET") {
      const r = exportGuideMarkdown(store, p.id);
      return { filename: `${p.name.replace(/[^\w.-]+/g, "-")}-guide.md`, markdown: r.markdown, counts: r.counts };
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
            ? buildPacket(store, p.id, key, { depth: active.meta.depth ?? store.projectSettings(p.id).depth }).hash !== active.meta.packetHash
            : buildBrief(store, p.id, key as SectionKey).hash !== active.meta.inputHash;
        const slim = (r: ReturnType<typeof activeRevision>) => r && { id: r.id, origin: r.origin, status: r.status, note: r.note, createdAt: r.createdAt, model: r.meta.model ?? null, userEdited: !!r.meta.userEdited };
        return { active, proposed: proposedRevision(store, p.id, type, key), stale, history: revisions(store, p.id, type, key).map(slim), notes: notesFor(store, p.id, type, key, { all: true }) };
      }
      if (method === "GET" && action === "revision") {
        const r = revisions(store, p.id, type, key).find((x) => x.id === Number(url.searchParams.get("id")));
        if (!r) throw new HttpError(404, "No such revision");
        return { revision: r };
      }
      if (method !== "POST") throw new HttpError(405, "Method not allowed");
      try {
        if (action === "edit") {
          const parsed = (type === "step" ? Step : WikiSection).safeParse(body?.content);
          if (!parsed.success) throw new HttpError(400, "The edited document is not in the expected shape");
          const note = typeof body?.note === "string" ? body.note.slice(0, 500) : undefined;
          return saveUserEdit(store, p.id, type, key, parsed.data, Number(body?.baseId), note);
        }
        if (action === "adopt") return adoptProposed(store, p.id, type, key, Number(body?.id));
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
        store.updateProjectSettings(p.id, patch);
      } else if (method !== "GET") throw new HttpError(405, "Method not allowed");
      const s2 = store.projectSettings(p.id);
      return { model: s2.model ?? null, depth: s2.depth, auth: s2.auth ?? "account", maxUsdPerRun: s2.maxUsdPerRun ?? null };
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
        artifacts: store.artifactsFor(id).map((a) => {
          const buf = store.blobs.get(a.contentHash);
          const text = buf ? buf.toString("utf8") : null;
          return { ...a, content: text && text.length > ARTIFACT_LIMIT ? text.slice(0, ARTIFACT_LIMIT) : text, truncated: !!text && text.length > ARTIFACT_LIMIT };
        }),
      };
    }

    if (sub[0] === "search" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      return store.search(p.id, q, 60).map((h) => ({ ...compact(h.event), snippet: h.snippet }));
    }

    if (sub[0] === "recording" && method === "POST") {
      const action = body?.action;
      const running = recorders.get(p.id);
      if (action === "start") {
        if (running) return { state: store.getProject(p.id)!.recordingState };
        const rec = new Recorder(store, p.id, { log: (m) => log(`[${p.name}] ${m}`) });
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
      return { state: store.getProject(p.id)!.recordingState, recorderRunning: recorders.has(p.id) };
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
