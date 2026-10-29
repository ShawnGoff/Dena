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
