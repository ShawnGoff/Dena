import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StoredEvent, Store } from "@dena/core";
import { git, hookInstall, Recorder } from "@dena/adapters";
import { episodeEvents, loadEpisodes, rebuildEpisodes } from "@dena/engine";

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
}

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
  id: e.id, type: e.eventType, actor: e.actor, source: e.source, summary: e.summary, at: e.occurredAt,
  confidence: e.captureConfidence, notable: NOTABLE.has(e.eventType),
  outcome: (e.payload as any).outcome ?? (e.payload as any).status ?? null,
});

export async function startServer(store: Store, opts: ServerOptions = {}): Promise<RunningServer> {
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const webDir = opts.webDir ?? DEFAULT_WEB_DIR;
  const recorders = new Map<string, Recorder>();
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

    if (sub[0] === "events" && sub.length === 2 && method === "GET") {
      const id = Number(sub[1]);
      const [e] = store.eventsById(p.id, [id]);
      if (!e) throw new HttpError(404, "No such event");
      const links = store.linksFor(id);
      const others = new Map(store.eventsById(p.id, links.map((l) => l.otherId)).map((o) => [o.id, o]));
      const unit = store.db.prepare("SELECT unit_id FROM work_unit_event WHERE project_id = ? AND event_id = ?").get(p.id, id) as { unit_id: string } | undefined;
      return {
        event: e,
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
      for (const [id, r] of recorders) {
        recorders.delete(id);
        await r.stop();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
