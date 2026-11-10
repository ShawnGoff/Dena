import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "@dena/core";
import { startServer, type RunningServer } from "../src/server.ts";
import { createVoiceManager, pruneOtherPlatforms, VoiceError, type VoiceBackend, type VoiceStatus } from "../src/voice.ts";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** A speech process that answers with fixed bytes naming what it was asked, so no model is needed. */
const FAKE_WORKER = `
process.on("message", (m) => {
  if (m.type !== "speak") return;
  if (m.text.includes("FAIL")) return process.send({ id: m.id, error: "boom" });
  process.send({ id: m.id, wav: Buffer.from("RIFF|" + m.voice + "|" + m.speed + "|" + m.text) });
});
`;

describe("voice manager", () => {
  let dir: string;
  let workerPath: string;
  const make = () => createVoiceManager({ dir, workerPath, idleMs: 60_000 });
  beforeAll(() => {
    const w = tmp("dena-vw-");
    workerPath = path.join(w, "worker.mjs");
    fs.writeFileSync(workerPath, FAKE_WORKER);
  });
  const fresh = () => {
    dir = path.join(tmp("dena-voice-"), "voice");
    fs.mkdirSync(dir, { recursive: true });
  };
  const markReady = () => fs.writeFileSync(path.join(dir, "ready.json"), "{}");

  it("is off until installed and refuses to speak", async () => {
    fresh();
    fs.rmSync(dir, { recursive: true });
    const v = make();
    expect(v.status().state).toBe("off");
    expect(v.status().sizeBytes).toBeNull();
    await expect(v.speak("Hello.")).rejects.toMatchObject({ status: 409 });
    v.close();
  });

  it("speaks through the child process, one piece at a time and in order", async () => {
    fresh();
    markReady();
    const v = make();
    expect(v.status().state).toBe("ready");
    const out = await Promise.all(["One.", "Two.", "Three."].map((t) => v.speak(t, { voice: "bf_emma", speed: 1.25 })));
    expect(out.map(String)).toEqual(["RIFF|bf_emma|1.25|One.", "RIFF|bf_emma|1.25|Two.", "RIFF|bf_emma|1.25|Three."]);
    v.close();
  });

  it("falls back to the default voice for unknown names and clamps speed", async () => {
    fresh();
    markReady();
    const v = make();
    expect(String(await v.speak("Hi.", { voice: "../../etc/passwd", speed: 99 }))).toBe("RIFF|af_heart|2|Hi.");
    expect(String(await v.speak("Hi.", { speed: 0.01 }))).toBe("RIFF|af_heart|0.5|Hi.");
    v.close();
  });

  it("rejects empty and over-long text, and reports a failed piece without breaking the next", async () => {
    fresh();
    markReady();
    const v = make();
    await expect(v.speak("   ")).rejects.toMatchObject({ status: 400 });
    await expect(v.speak("x".repeat(801))).rejects.toMatchObject({ status: 413 });
    await expect(v.speak("FAIL please")).rejects.toBeInstanceOf(VoiceError);
    expect(String(await v.speak("Fine."))).toContain("Fine.");
    v.close();
  });

  it("remove deletes the whole voice folder and returns to off", async () => {
    fresh();
    markReady();
    fs.writeFileSync(path.join(dir, "model.bin"), "x".repeat(1000));
    const v = make();
    expect(v.status().sizeBytes).toBeGreaterThanOrEqual(1000);
    await v.remove();
    expect(fs.existsSync(dir)).toBe(false);
    expect(v.status().state).toBe("off");
    await expect(v.speak("Hi.")).rejects.toMatchObject({ status: 409 });
  });

  it("keeps only this platform's runtime binaries", () => {
    fresh();
    const bin = path.join(dir, "node_modules", "onnxruntime-node", "bin", "napi-v3");
    for (const p of ["darwin", "linux", "win32"]) for (const a of ["arm64", "x64"]) {
      fs.mkdirSync(path.join(bin, p, a), { recursive: true });
      fs.writeFileSync(path.join(bin, p, a, "lib"), "x");
    }
    pruneOtherPlatforms(dir, "darwin", "arm64");
    expect(fs.readdirSync(bin)).toEqual(["darwin"]);
    expect(fs.readdirSync(path.join(bin, "darwin"))).toEqual(["arm64"]);
  });
});

/** The HTTP side, with a fake backend: the same checks the web page's requests go through. */
class FakeVoice implements VoiceBackend {
  state: VoiceStatus["state"] = "off";
  calls: string[] = [];
  status(): VoiceStatus { return { state: this.state, step: null, percent: null, error: null, sizeBytes: null, dir: "/x", voices: { af_heart: "Heart" }, approxMb: 420 }; }
  install() { this.calls.push("install"); this.state = "ready"; }
  cancel() { this.calls.push("cancel"); }
  async remove() { this.calls.push("remove"); this.state = "off"; }
  async speak(text: string, o?: { voice?: string; speed?: number }) {
    if (this.state !== "ready") throw new VoiceError(409, "The natural voice is not installed");
    return Buffer.from(`WAV:${o?.voice ?? ""}:${o?.speed}:${text}`);
  }
  close() {}
}

describe("voice routes", () => {
  let srv: RunningServer;
  const fake = new FakeVoice();
  const call = (p: string, o: { method?: string; body?: unknown; token?: string | null } = {}) =>
    new Promise<{ status: number; type: string; body: Buffer }>((resolve, reject) => {
      const data = o.body === undefined ? null : JSON.stringify(o.body);
      const r = http.request({ host: "127.0.0.1", port: srv.port, path: p, method: o.method ?? "GET",
        headers: { host: `127.0.0.1:${srv.port}`, ...(o.token === null ? {} : { "x-dena-token": o.token ?? srv.token }), ...(data ? { "content-type": "application/json" } : {}) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode!, type: String(res.headers["content-type"]), body: Buffer.concat(chunks) }));
      });
      r.on("error", reject);
      if (data) r.write(data);
      r.end();
    });
  beforeAll(async () => {
    const home = tmp("dena-vhome-");
    const web = tmp("dena-vweb-");
    fs.writeFileSync(path.join(web, "index.html"), "<!doctype html>");
    srv = await startServer(new Store(home), { port: 0, webDir: web, voice: fake });
  });
  afterAll(() => srv.close());

  it("needs the token for every voice call", async () => {
    expect((await call("/api/voice", { token: null })).status).toBe(401);
    expect((await call("/api/voice/speak", { method: "POST", body: { text: "Hi." }, token: null })).status).toBe(401);
  });

  it("reports status, installs, and removes", async () => {
    expect(JSON.parse((await call("/api/voice")).body.toString()).state).toBe("off");
    expect(JSON.parse((await call("/api/voice/install", { method: "POST", body: {} })).body.toString()).state).toBe("ready");
    expect(JSON.parse((await call("/api/voice/remove", { method: "POST", body: {} })).body.toString()).state).toBe("off");
    expect(fake.calls).toEqual(["install", "remove"]);
  });

  it("answers speak with audio, or a clear error when not installed", async () => {
    const no = await call("/api/voice/speak", { method: "POST", body: { text: "Hi." } });
    expect(no.status).toBe(409);
    fake.state = "ready";
    const ok = await call("/api/voice/speak", { method: "POST", body: { text: "Hello there.", voice: "bf_emma", speed: 1.5 } });
    expect(ok.status).toBe(200);
    expect(ok.type).toBe("audio/wav");
    expect(ok.body.toString()).toBe("WAV:bf_emma:1.5:Hello there.");
  });
});

describe("presenter model route", () => {
  it("needs the token, says 404 when there is no model, and serves the owner's file when there is", async () => {
    const home = tmp("dena-bust-");
    const web = tmp("dena-bweb-");
    fs.writeFileSync(path.join(web, "index.html"), "<!doctype html>");
    const srv = await startServer(new Store(home), { port: 0, webDir: web, voice: new FakeVoice() });
    const get = (token: string | null) => new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: srv.port, path: "/api/presenter/bust", headers: { host: `127.0.0.1:${srv.port}`, ...(token ? { "x-dena-token": token } : {}) } }, (r) => {
        const c: Buffer[] = [];
        r.on("data", (d) => c.push(d));
        r.on("end", () => resolve({ status: r.statusCode!, type: String(r.headers["content-type"]), body: Buffer.concat(c).toString() }));
      }).on("error", reject);
    });
    expect((await get(null)).status).toBe(401);
    expect((await get(srv.token)).status).toBe(404);
    fs.mkdirSync(path.join(home, "presenter"), { recursive: true });
    fs.writeFileSync(path.join(home, "presenter", "bust.glb"), "glTF-bytes");
    const ok = await get(srv.token);
    expect(ok.status).toBe(200);
    expect(ok.type).toBe("model/gltf-binary");
    expect(ok.body).toBe("glTF-bytes");
    await srv.close();
  });
});
