import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "@dena/core";
import { startServer, type RunningServer } from "../src/server.ts";
import type { GenerateResult, Provider } from "@dena/engine";

/** Answers every explain call with a minimal valid step, citing E1, and records which model was asked for. */
class FakeProvider implements Provider {
  name = "fake";
  models: (string | undefined)[] = [];
  async generate(_s: string, _u: string, _schema: object, o?: { model?: string }): Promise<GenerateResult> {
    this.models.push(o?.model);
    const props = (_schema as any).properties;
    if (props?.updates) // a targeted update: add one statement from the new evidence
      return { json: { title: "Added a quaternion helper", summary: "s", updates: [{ section: "whatHappened", replaces: "", text: "The owner added context.", kind: "owner_stated", evidence: [[..._u.matchAll(/^\[(E\d+)\]/gm)].map((m) => m[1])[0]] }], remove: [], uncertainty: [] },
        model: "fake-default", costUsd: 0, durationMs: 1 };
    if (props?.symbols) { // a code explainer call
      const symbols = [..._u.matchAll(/<symbol key=("[^"]*")/g)].map((m) => ({ key: JSON.parse(m[1]!), summary: "Does a thing.", how: [], learn: [], watch: [] }));
      return { json: { symbols, ...(props.file ? { file: { purpose: "A helper.", fitsIn: [], learn: [], readingOrder: [] } } : {}) }, model: "fake-default", costUsd: 0, durationMs: 1 };
    }
    return { json: { title: "Added a quaternion helper", summary: "s", whatHappened: [{ text: "The user asked for it.", kind: "observed", evidence: ["E1"] }],
      whyItMattered: [], howItWorks: [], decisions: [], concepts: [], uncertainty: [] }, model: o?.model ?? "fake-default", costUsd: 0.002, durationMs: 1 };
  }
}
const fake = new FakeProvider();

let home: string;
let web: string;
let store: Store;
let srv: RunningServer;
let pid: string;

/** Raw request so tests can set any Host header (fetch forbids that). */
function req(pathname: string, opts: { method?: string; host?: string; token?: string | null; body?: unknown; type?: string } = {}) {
  return new Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const data = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const r = http.request({
      host: "127.0.0.1", port: srv.port, path: pathname, method: opts.method ?? "GET",
      headers: {
        host: opts.host ?? `127.0.0.1:${srv.port}`,
        ...(opts.token === null ? {} : { "x-dena-token": opts.token ?? srv.token }),
        ...(data ? { "content-type": opts.type ?? "application/json", "content-length": Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode!, json, headers: res.headers, text });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dena-srv-"));
  web = fs.mkdtempSync(path.join(os.tmpdir(), "dena-web-"));
  fs.writeFileSync(path.join(web, "index.html"), "<!doctype html><title>Dena</title>");
  store = new Store(home);
  pid = store.createProject("demo", "/nonexistent/demo").id;
  store.ingest(pid, {
    sessions: [], artifacts: [{ sourceEventId: "f1", role: "diff", artifactType: "diff", content: "+hello world" }], gaps: [],
    links: [{ source: "t", fromSourceEventId: "f1", toSourceEventId: "p1", linkType: "in_response_to", strength: "observed", basis: "test" }],
    events: [
      { sessionId: null, source: "t", sourceEventId: "p1", eventType: "prompt_submitted", occurredAt: "2026-10-01T10:00:00Z", actor: "user", summary: "Add a quaternion helper", payload: { text: "Add a quaternion helper" }, captureConfidence: "observed" },
      { sessionId: null, source: "t", sourceEventId: "f1", eventType: "file_modified", occurredAt: "2026-10-01T10:01:00Z", actor: "ai_agent", summary: "Modified src/math.ts", payload: { file: "src/math.ts" }, captureConfidence: "observed" },
    ],
  });
  srv = await startServer(store, { port: 0, webDir: web, provider: fake });
});
afterAll(async () => {
  await srv.close();
  store.close();
  for (const d of [home, web]) fs.rmSync(d, { recursive: true, force: true });
});

describe("local server security", () => {
  it("rejects API calls without the token or with a wrong one", async () => {
    expect((await req("/api/projects", { token: null })).status).toBe(401);
    expect((await req("/api/projects", { token: "x".repeat(32) })).status).toBe(401);
  });
  it("rejects foreign Host headers (DNS rebinding)", async () => {
    expect((await req("/api/projects", { host: "evil.example:80" })).status).toBe(421);
    expect((await req("/", { host: `attacker.test:${srv.port}` })).status).toBe(421);
  });
  it("sends no CORS headers and never leaks internals in errors", async () => {
    const r = await req("/api/projects/does-not-exist/overview");
    expect(r.status).toBe(404);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    expect(r.json).toEqual({ error: "No such project" });
  });
  it("only accepts JSON bodies and blocks path traversal", async () => {
    expect((await req(`/api/projects/${pid}/recording`, { method: "POST", body: { action: "pause" }, type: "text/plain" })).status).toBe(415);
    expect((await req("/../../etc/passwd")).text).not.toContain("root:");
  });
  it("serves the page with a strict content policy and no referrer", async () => {
    const r = await req("/", { token: null });
    expect(r.status).toBe(200);
    expect(r.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
  });
});

describe("local server API", () => {
  it("lists projects and gives an overview", async () => {
    expect((await req("/api/projects")).json[0]).toMatchObject({ name: "demo", recorderRunning: false });
    const o = (await req(`/api/projects/${pid}/overview`)).json;
    expect(o.stats.byType.length).toBeGreaterThan(0);
    expect(o.recent[0]).toMatchObject({ summary: "Modified src/math.ts", notable: true });
  });
  it("builds episodes and returns their events", async () => {
    const eps = (await req(`/api/projects/${pid}/episodes`)).json;
    expect(eps).toHaveLength(1);
    const evs = (await req(`/api/projects/${pid}/episodes/${eps[0].id}/events`)).json;
    expect(evs.map((e: any) => e.type)).toEqual(["prompt_submitted", "file_modified"]);
  });
  it("returns an event with its links and artifact content", async () => {
    const id = store.timeline(pid).find((e) => e.sourceEventId === "f1")!.id;
    const d = (await req(`/api/projects/${pid}/events/${id}`)).json;
    expect(d.artifacts[0].content).toBe("+hello world");
    expect(d.links[0]).toMatchObject({ linkType: "in_response_to", strength: "observed", other: { summary: "Add a quaternion helper" } });
  });
  it("searches, treating punctuation as plain text", async () => {
    expect((await req(`/api/projects/${pid}/search?q=quaternion`)).json[0].summary).toBe("Add a quaternion helper");
    expect((await req(`/api/projects/${pid}/search?q=${encodeURIComponent('quat" OR * NEAR(')}`)).status).toBe(200);
  });
});

describe("explanations API", () => {
  it("explains an episode on request, caches it, and honours a per-request model", async () => {
    const [ep] = (await req(`/api/projects/${pid}/episodes`)).json;
    const before = (await req(`/api/projects/${pid}/episodes/${ep.id}/explanation`)).json;
    expect(before.explanations).toEqual([]);
    expect(before.estimate.modelCalls).toBe(1);

    const r = (await req(`/api/projects/${pid}/episodes/${ep.id}/explain`, { method: "POST", body: {} })).json;
    expect(r).toMatchObject({ cached: false, ok: true });
    const after = (await req(`/api/projects/${pid}/episodes/${ep.id}/explanation`)).json;
    expect(after.explanations[0].step.title).toBe("Added a quaternion helper");
    expect(after.explanations[0].stale).toBe(false);

    await req(`/api/projects/${pid}/episodes/${ep.id}/explain`, { method: "POST", body: { model: "opus", force: true } });
    expect(fake.models.at(-1)).toBe("opus");
    expect((await req(`/api/projects/${pid}/episodes/${ep.id}/explanation`)).json.explanations).toHaveLength(2);
  });

  it("rejects model names that could become command-line flags", async () => {
    const [ep] = (await req(`/api/projects/${pid}/episodes`)).json;
    for (const model of ["--dangerously-skip-permissions", "-p", "a b", "x".repeat(80)])
      expect((await req(`/api/projects/${pid}/episodes/${ep.id}/explain`, { method: "POST", body: { model } })).status).toBe(400);
    expect((await req(`/api/projects/${pid}/settings`, { method: "POST", body: { model: "--x" } })).status).toBe(400);
  });

  it("reads and updates the model and depth settings", async () => {
    expect((await req(`/api/projects/${pid}/settings`, { method: "POST", body: { model: "haiku", depth: "concise" } })).json).toMatchObject({ model: "haiku", depth: "concise" });
    expect((await req(`/api/projects/${pid}/settings`, { method: "POST", body: { model: null } })).json.model).toBeNull();
  });
});

describe("memory API", () => {
  it("builds and returns project memory", async () => {
    const m = (await req(`/api/projects/${pid}/memory`)).json;
    expect(m.components.map((c: any) => c.title)).toContain("src");
    expect(Object.keys(m.episodes).length).toBeGreaterThan(0);
    expect(m.concepts).toEqual([]);
  });
});

describe("document revisions API", () => {
  it("edits with conflict detection, rejects malformed content, stores notes, and restores", async () => {
    const [ep] = (await req(`/api/projects/${pid}/episodes`)).json;
    await req(`/api/projects/${pid}/episodes/${ep.id}/explain`, { method: "POST", body: {} });
    const q = `/api/projects/${pid}/doc?type=step&key=${ep.id}`;
    const d = (await req(q)).json;
    expect(d.active.origin).toBe("generated");

    const content = { ...d.active.content, summary: "Owner's summary" };
    const edited = await req(`/api/projects/${pid}/doc/edit`, { method: "POST", body: { type: "step", key: ep.id, content, baseId: d.active.id } });
    expect(edited.json.origin).toBe("user");
    const stale = await req(`/api/projects/${pid}/doc/edit`, { method: "POST", body: { type: "step", key: ep.id, content, baseId: d.active.id } });
    expect(stale.status).toBe(409);
    const bad = await req(`/api/projects/${pid}/doc/edit`, { method: "POST", body: { type: "step", key: ep.id, content: { title: 1 }, baseId: edited.json.id } });
    expect(bad.status).toBe(400);

    expect((await req(`/api/projects/${pid}/doc/note`, { method: "POST", body: { type: "step", key: ep.id, kind: "context", text: "It was a demo." } })).status).toBe(200);
    const after = (await req(q)).json;
    expect(after.notes[0]).toMatchObject({ kind: "context", text: "It was a demo." });
    expect(after.stale).toBe(true); // a new note changes what the writer would see
    await req(`/api/projects/${pid}/doc/restore`, { method: "POST", body: { type: "step", key: ep.id, id: d.active.id } });
    expect((await req(q)).json.active.content.summary).toBe(d.active.content.summary);

    // A targeted update: the note is new evidence; the result waits for review with its diff.
    const offer = (await req(q)).json;
    expect(offer.update).toMatchObject({ needsModel: true, fresh: 1 });
    expect(offer.update.send).toBeLessThan(offer.update.of);
    const u = await req(`/api/projects/${pid}/doc/update`, { method: "POST", body: { type: "step", key: ep.id } });
    expect(u.status).toBe(200);
    expect(u.json.diff.added.map((x: any) => x.text)).toEqual(["The owner added context."]);
    const waiting = (await req(q)).json;
    expect(waiting.proposed.meta.targeted).toBe(true);
    expect(waiting.update).toBeNull();
    await req(`/api/projects/${pid}/doc/adopt`, { method: "POST", body: { type: "step", key: ep.id, id: waiting.proposed.id } });
    const applied = (await req(q)).json;
    expect(applied.stale).toBe(false);
    expect(applied.active.content.whatHappened.map((c: any) => c.text)).toContain("The owner added context.");
  });
});

describe("recording left on", () => {
  it("resumes a project marked recording when no recorder is alive, recording the gap from the last heartbeat", async () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), "dena-resume-"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dena-resume-root-"));
    const s = new Store(h);
    const p = s.createProject("left-on", root);
    s.setRecordingState(p.id, "recording");
    const lastBeat = new Date(Date.now() - 10 * 60_000).toISOString();
    s.setCursor(p.id, "dena", "recorder_heartbeat", JSON.stringify({ pid: 99999, at: lastBeat }));
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "dena-noclaude-")); // keep the test away from real transcripts
    const srv2 = await startServer(s, { port: 0, webDir: web, provider: fake, recorder: { claudeHome } });
    const r = await new Promise<any>((resolve) => {
      http.get({ host: "127.0.0.1", port: srv2.port, path: "/api/projects", headers: { host: `127.0.0.1:${srv2.port}`, "x-dena-token": srv2.token } }, (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve(JSON.parse(t)));
      });
    });
    expect(r[0]).toMatchObject({ recordingState: "recording", recorderRunning: true, recorderHere: true });
    expect(s.gaps(p.id).some((g) => g.source === "dena" && g.fromTime === lastBeat)).toBe(true);
    await srv2.close();
    expect(s.getProject(p.id)!.recordingState).toBe("stopped"); // a clean shutdown records it
    s.close();
    for (const d of [h, root]) fs.rmSync(d, { recursive: true, force: true });
  });

  it("leaves a project alone when another live recorder is beating", async () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), "dena-live-"));
    const s = new Store(h);
    const p = s.createProject("busy", "/nonexistent/busy");
    s.setRecordingState(p.id, "recording");
    s.setCursor(p.id, "dena", "recorder_heartbeat", JSON.stringify({ pid: 4242, at: new Date().toISOString() }));
    const srv2 = await startServer(s, { port: 0, webDir: web, provider: fake });
    const r = await new Promise<any>((resolve) => {
      http.get({ host: "127.0.0.1", port: srv2.port, path: "/api/projects", headers: { host: `127.0.0.1:${srv2.port}`, "x-dena-token": srv2.token } }, (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve(JSON.parse(t)));
      });
    });
    expect(r[0]).toMatchObject({ recorderRunning: true, recorderHere: false, recorderElsewherePid: 4242 });
    await srv2.close();
    s.close();
    fs.rmSync(h, { recursive: true, force: true });
  });
});

describe("activity API", () => {
  it("lists sessions, returns one with entries, and exports Markdown", async () => {
    const list = (await req(`/api/projects/${pid}/activity`)).json;
    expect(Array.isArray(list)).toBe(true);
    if (list.length) {
      const one = (await req(`/api/projects/${pid}/activity/session?id=${encodeURIComponent(list[0].id)}`)).json;
      expect(Array.isArray(one.entries)).toBe(true);
      const ex = (await req(`/api/projects/${pid}/activity/export?id=${encodeURIComponent(list[0].id)}`)).json;
      expect(ex.markdown).toContain("what the AI did");
    }
  });
});

describe("code explainers API", () => {
  it("lists files, explains one, and refuses paths outside the project", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dena-srv-code-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/math.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
    const cp = store.createProject("code-demo", root).id;
    try {
      const list = (await req(`/api/projects/${cp}/code`)).json;
      expect(list.files.map((f: any) => f.path)).toEqual(["src/math.ts"]);
      const before = (await req(`/api/projects/${cp}/code/file?path=src/math.ts`)).json;
      expect(before.symbols.map((s: any) => `${s.key}:${s.status}`)).toEqual(["add:new"]);
      expect(before.pending.calls).toBe(1);
      const r = await req(`/api/projects/${cp}/code/explain`, { method: "POST", body: { path: "src/math.ts" } });
      expect(r.status).toBe(200);
      expect(r.json.explained).toBe(1);
      const after = (await req(`/api/projects/${cp}/code/file?path=src/math.ts`)).json;
      expect(after.symbols[0].doc.summary).toBe("Does a thing.");
      expect(after.fileDoc.current).toBe(true);
      expect((await req(`/api/projects/${cp}/code/export?path=src/math.ts`)).json.markdown).toContain("# src/math.ts");
      expect((await req(`/api/projects/${cp}/code/file?path=${encodeURIComponent("../../etc/passwd")}`)).status).toBe(404);
      expect((await req(`/api/projects/${cp}/code/explain`, { method: "POST", body: { path: "/etc/passwd" } })).status).toBe(404);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("how the AI built this API", () => {
  it("serves a step's process and a page's, and 404s anything else", async () => {
    const [ep] = (await req(`/api/projects/${pid}/episodes`)).json;
    const step = await req(`/api/projects/${pid}/how-built?type=step&key=${ep.id}`);
    expect(step.status).toBe(200);
    expect(step.json.scope).toBe("this episode");
    expect((await req(`/api/projects/${pid}/how-built?type=wiki&key=overview`)).json.scope).toBe("the whole project");
    expect((await req(`/api/projects/${pid}/how-built?type=wiki&key=nope`)).status).toBe(404);
  });
});

describe("updates left waiting", () => {
  it("do not resume on their own when Dena starts; they wait for a yes", async () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), "dena-wait-"));
    const s = new Store(h);
    const p = s.createProject("waiting", "/nonexistent/waiting");
    s.ingest(p.id, { sessions: [], artifacts: [], gaps: [], links: [], events: [
      { sessionId: null, source: "t", sourceEventId: "p1", eventType: "prompt_submitted", occurredAt: "2026-10-01T10:00:00Z", actor: "user", summary: "Add a thing", payload: { text: "Add a thing" }, captureConfidence: "observed" },
      { sessionId: null, source: "t", sourceEventId: "f1", eventType: "file_modified", occurredAt: "2026-10-01T10:01:00Z", actor: "ai_agent", summary: "Modified a.ts", payload: { file: "a.ts" }, captureConfidence: "observed" },
    ] });
    const ep = s.db.prepare("SELECT id FROM work_unit WHERE project_id = ?").get(p.id) as { id: string } | undefined;
    const { loadEpisodes, enqueue } = await import("@dena/engine");
    const key = ep?.id ?? loadEpisodes(s, p.id)[0]!.id;
    enqueue(s, p.id, [{ type: "step", key }]);
    const calls = fake.models.length;
    const srv2 = await startServer(s, { port: 0, webDir: web, provider: fake });
    const get = (pathname: string, method = "GET") => new Promise<any>((resolve) => {
      const r = http.request({ host: "127.0.0.1", port: srv2.port, path: pathname, method, headers: { host: `127.0.0.1:${srv2.port}`, "x-dena-token": srv2.token, "content-type": "application/json" } }, (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve(JSON.parse(t)));
      });
      r.end(method === "POST" ? "{}" : undefined);
    });
    await new Promise((r) => setTimeout(r, 2_500)); // the old behaviour resumed after 2 seconds
    const u = await get(`/api/projects/${p.id}/updates`);
    expect(u.waitingFromBefore).toBe(true);
    expect(u.jobs[0].status).toBe("queued");
    expect(fake.models.length).toBe(calls); // no model call happened
    await get(`/api/projects/${p.id}/updates/resume`, "POST");
    let after: any;
    for (let i = 0; i < 40; i++) {
      after = await get(`/api/projects/${p.id}/updates`);
      if (after.jobs[0].status !== "queued" && after.jobs[0].status !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(after.waitingFromBefore).toBe(false);
    expect(after.jobs[0].status).toBe("done");
    await srv2.close();
    s.close();
    fs.rmSync(h, { recursive: true, force: true });
  });
});

describe("explaining the remaining steps", () => {
  it("states the estimate, explains what is missing, and then has nothing left", async () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), "dena-rest-"));
    const s = new Store(h);
    const p = s.createProject("rest", "/nonexistent/rest");
    s.ingest(p.id, { sessions: [], artifacts: [], gaps: [], links: [], events: [
      { sessionId: null, source: "t", sourceEventId: "p1", eventType: "prompt_submitted", occurredAt: "2026-10-01T10:00:00Z", actor: "user", summary: "Add a thing", payload: { text: "Add a thing" }, captureConfidence: "observed" },
      { sessionId: null, source: "t", sourceEventId: "f1", eventType: "file_modified", occurredAt: "2026-10-01T10:01:00Z", actor: "ai_agent", summary: "Modified a.ts", payload: { file: "a.ts" }, captureConfidence: "observed" },
    ] });
    const srv2 = await startServer(s, { port: 0, webDir: web, provider: fake });
    const call = (pathname: string, method = "GET") => new Promise<any>((resolve) => {
      const r = http.request({ host: "127.0.0.1", port: srv2.port, path: pathname, method, headers: { host: `127.0.0.1:${srv2.port}`, "x-dena-token": srv2.token, "content-type": "application/json" } }, (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(t) }));
      });
      r.end(method === "POST" ? "{}" : undefined);
    });
    const plan = (await call(`/api/projects/${p.id}/guide/plan`)).json;
    expect(plan).toMatchObject({ steps: 1, explained: 0, missing: 1 });
    expect(plan.estimate.modelCalls).toBe(1);
    const r = await call(`/api/projects/${p.id}/guide/explain-rest`, "POST");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ explained: 1, leftForNextRun: 0 });
    expect((await call(`/api/projects/${p.id}/guide/plan`)).json.missing).toBe(0);
    await srv2.close();
    s.close();
    fs.rmSync(h, { recursive: true, force: true });
  });
});

describe("adding projects", () => {
  it("suggests folders used with Claude Code, can forget one, and adds a folder with its past", async () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), "dena-add-"));
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "dena-claudehome-"));
    const work = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".dena-test-work-"))); // under home, so it counts as a work folder
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".dena-test-other-")));
    for (const [dir, cwd] of [["a", work], ["b", other]] as [string, string][]) {
      fs.mkdirSync(path.join(claudeHome, "projects", dir), { recursive: true });
      fs.writeFileSync(path.join(claudeHome, "projects", dir, "s.jsonl"), JSON.stringify({ type: "user", cwd }) + "\n");
    }
    const s = new Store(h);
    const srv2 = await startServer(s, { port: 0, webDir: web, provider: fake, recorder: { claudeHome } });
    const call = (pathname: string, method = "GET", body?: unknown) => new Promise<any>((resolve) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const r = http.request({ host: "127.0.0.1", port: srv2.port, path: pathname, method,
        headers: { host: `127.0.0.1:${srv2.port}`, "x-dena-token": srv2.token, ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) } }, (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(t) }));
      });
      r.end(data);
    });
    try {
      const found = (await call("/api/discover")).json.folders.map((f: any) => f.path).sort();
      expect(found).toEqual([work, other].sort());
      expect((await call("/api/discover/dismiss", "POST", { path: other })).json.folders.map((f: any) => f.path)).toEqual([work]);
      expect((await call("/api/projects", "POST", { path: "/private/tmp" })).status).toBe(400);
      expect((await call("/api/projects", "POST", { path: path.join(work, "missing") })).status).toBe(400);
      const added = await call("/api/projects", "POST", { path: work.replace(os.homedir(), "~"), name: "Work" });
      expect(added.status).toBe(200);
      expect(added.json.project).toMatchObject({ name: "Work", rootPath: work });
      expect(added.json.transcriptsKeptDays).toBeGreaterThan(0);
      expect((await call("/api/discover")).json.folders).toEqual([]); // covered now, and the other was dismissed
      expect((await call("/api/projects", "POST", { path: work })).status).toBe(409);
    } finally {
      await srv2.close();
      s.close();
      for (const d of [h, claudeHome, work, other]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("organising projects", () => {
  it("groups a project under a folder, and removes a project from Dena without touching its files", async () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), "dena-org-"));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "dena-org-work-"));
    fs.writeFileSync(path.join(work, "keep.txt"), "mine");
    const s = new Store(h);
    const p = s.createProject("org", work);
    s.ingest(p.id, { sessions: [], artifacts: [], gaps: [], links: [], events: [
      { sessionId: null, source: "t", sourceEventId: "p1", eventType: "prompt_submitted", occurredAt: "2026-10-01T10:00:00Z", actor: "user", summary: "x", payload: {}, captureConfidence: "observed" },
    ] });
    s.db.prepare("INSERT INTO code_call (project_id, file, symbols, with_file_page, attempts, input_chars, created_at) VALUES (?, 'a.ts', 1, 0, 1, 10, ?)").run(p.id, new Date().toISOString());
    const srv2 = await startServer(s, { port: 0, webDir: web, provider: fake });
    const call = (pathname: string, method = "GET", body?: unknown) => new Promise<any>((resolve) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const r = http.request({ host: "127.0.0.1", port: srv2.port, path: pathname, method,
        headers: { host: `127.0.0.1:${srv2.port}`, "x-dena-token": srv2.token, ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) } }, (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(t) }));
      });
      r.end(data);
    });
    try {
      expect((await call(`/api/projects/${p.id}/settings`, "POST", { folder: "  Games  " })).json.folder).toBe("Games");
      expect((await call("/api/projects")).json[0].folder).toBe("Games");
      expect((await call(`/api/projects/${p.id}/settings`, "POST", { folder: null })).json.folder).toBeNull();
      const r = await call(`/api/projects/${p.id}`, "DELETE");
      expect(r.json).toMatchObject({ removed: true, folder: work });
      expect((await call("/api/projects")).json).toEqual([]);
      expect(fs.readFileSync(path.join(work, "keep.txt"), "utf8")).toBe("mine"); // the folder is untouched
      expect(JSON.parse(fs.readFileSync(path.join(h, "dismissed-folders.json"), "utf8"))).toContain(work); // not suggested again
    } finally {
      await srv2.close();
      s.close();
      for (const d of [h, work]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("browsing for a folder", () => {
  it("lists folders inside the home folder only", async () => {
    const home = fs.realpathSync(os.homedir());
    const inHome = await req("/api/browse");
    expect(inHome.status).toBe(200);
    expect(inHome.json.path).toBe(home);
    expect(inHome.json.parent).toBeNull();
    expect(inHome.json.dirs.every((d: any) => !d.name.startsWith("."))).toBe(true);
    expect((await req(`/api/browse?path=${encodeURIComponent("/etc")}`)).status).toBe(403);
    expect((await req(`/api/browse?path=${encodeURIComponent(home + "/../..")}`)).status).toBe(403);
  });
});
