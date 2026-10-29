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
