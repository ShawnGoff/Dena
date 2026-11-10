import { fork, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { denaRoot } from "@dena/core";

/**
 * The optional natural voice: Kokoro, a small speech model that runs on this computer.
 *
 * Nothing is installed until the owner agrees. Then the speech runtime is installed into
 * ~/.dena/voice (npm, scripts off) and the model is downloaded once into the same folder, so
 * removing the voice is deleting that folder. Text is spoken by a child process on this
 * machine and never sent anywhere; only the install and model download use the network.
 */

/** Pinned: the runtime is whatever this version resolves to when the owner agrees. */
export const KOKORO_VERSION = "1.2.1";
/** Voices graded A or B by the model's authors, English only. */
export const NATURAL_VOICES: Record<string, string> = {
  af_heart: "Heart (US, female)", af_bella: "Bella (US, female)", af_nicole: "Nicole (US, female)",
  bf_emma: "Emma (UK, female)",
  // Hidden for now, still supported by the model: am_michael "Michael (US, male)", bm_george "George (UK, male)".
};
export const DEFAULT_NATURAL_VOICE = "af_heart";
export const MAX_SPEAK_CHARS = 800;

export type VoiceState = "off" | "installing" | "ready" | "error";
export interface VoiceStatus {
  state: VoiceState;
  /** What the install is doing now, in words. */
  step: string | null;
  /** 0-100 while a download reports its size, else null. */
  percent: number | null;
  error: string | null;
  /** Disk used by the installed voice. */
  sizeBytes: number | null;
  dir: string;
  voices: Record<string, string>;
  /** Roughly what installing will download and keep, for the consent text. */
  approxMb: number;
}

export interface VoiceBackend {
  status(): VoiceStatus;
  /** Starts installing in the background; poll status(). */
  install(): void;
  cancel(): void;
  remove(): Promise<void>;
  /** WAV bytes for one short piece of text. */
  speak(text: string, opts?: { voice?: string; speed?: number }): Promise<Buffer>;
  close(): void;
}

export class VoiceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const dirSize = (dir: string): number => {
  let n = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) n += fs.statSync(p).size;
    }
  };
  try {
    walk(dir);
  } catch {
    /* folder missing or changing underneath us */
  }
  return n;
};

/** onnxruntime-node ships binaries for every platform; keep this one's. */
export function pruneOtherPlatforms(dir: string, platform = process.platform, arch = process.arch): void {
  const bin = path.join(dir, "node_modules", "onnxruntime-node", "bin");
  try {
    for (const v of fs.readdirSync(bin)) {
      for (const plat of fs.readdirSync(path.join(bin, v))) {
        const p = path.join(bin, v, plat);
        if (plat !== platform) fs.rmSync(p, { recursive: true, force: true });
        else
          for (const a of fs.readdirSync(p)) if (a !== arch) fs.rmSync(path.join(p, a), { recursive: true, force: true });
      }
    }
  } catch {
    /* layout changed: leave the files, they only cost disk */
  }
}

export interface VoiceOptions {
  dir: string;
  log?: (m: string) => void;
  /** Overridable for tests. */
  workerPath?: string;
  /** How long an idle speech process lives before it is stopped. */
  idleMs?: number;
}

export function createVoiceManager(o: VoiceOptions): VoiceBackend {
  const log = o.log ?? (() => {});
  const readyFile = path.join(o.dir, "ready.json");
  const workerPath = o.workerPath ?? path.join(denaRoot(), "packages", "server", "src", "voice-worker.mjs");
  let state: VoiceState = fs.existsSync(readyFile) ? "ready" : "off";
  let step: string | null = null;
  let percent: number | null = null;
  let error: string | null = null;
  let installer: { stop: () => void } | null = null;
  let worker: ChildProcess | null = null;
  let idle: NodeJS.Timeout | undefined;
  const pending = new Map<number, { resolve: (b: Buffer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let nextId = 1;
  let chain: Promise<unknown> = Promise.resolve();

  const stopWorker = () => {
    clearTimeout(idle);
    const w = worker;
    worker = null;
    w?.kill();
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new VoiceError(503, "The voice stopped"));
      pending.delete(id);
    }
  };

  const startWorker = (): ChildProcess => {
    if (worker) return worker;
    const w = fork(workerPath, [], { cwd: o.dir, serialization: "advanced", env: { ...process.env, DENA_VOICE_DIR: o.dir }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    w.stderr?.on("data", (d) => log(`[voice] ${String(d).trim().slice(0, 300)}`));
    w.on("message", (m: any) => {
      const p = pending.get(m?.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(m.id);
      if (m.error) p.reject(new VoiceError(500, "The voice could not speak that"));
      else p.resolve(Buffer.from(m.wav));
    });
    w.on("exit", () => {
      if (worker === w) stopWorker();
    });
    worker = w;
    return w;
  };

  const setIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(stopWorker, o.idleMs ?? 5 * 60_000);
    idle.unref();
  };

  const runNpm = (signal: { cancelled: boolean }, kids: ChildProcess[]) =>
    new Promise<void>((resolve, reject) => {
      const c = spawn("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: o.dir, shell: process.platform === "win32", stdio: ["ignore", "ignore", "pipe"] });
      kids.push(c);
      let err = "";
      c.stderr?.on("data", (d) => (err += d));
      c.on("error", (e) => reject(e));
      c.on("exit", (code) => (signal.cancelled ? reject(new VoiceError(499, "Cancelled")) : code === 0 ? resolve() : reject(new Error(`npm install failed: ${err.trim().slice(-300)}`))));
    });

  const prefetch = (signal: { cancelled: boolean }, kids: ChildProcess[]) =>
    new Promise<void>((resolve, reject) => {
      const c = fork(workerPath, ["prefetch"], { cwd: o.dir, env: { ...process.env, DENA_VOICE_DIR: o.dir }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
      kids.push(c);
      let err = "";
      let ok = false;
      c.stderr?.on("data", (d) => (err += d));
      c.on("message", (m: any) => {
        if (m?.type === "progress") percent = Math.max(0, Math.min(100, Math.round(m.percent)));
        if (m?.type === "ready") ok = true;
      });
      c.on("error", reject);
      c.on("exit", () => (signal.cancelled ? reject(new VoiceError(499, "Cancelled")) : ok ? resolve() : reject(new Error(`model download failed: ${err.trim().slice(-300)}`))));
    });

  return {
    status() {
      return {
        state, step, percent, error, dir: o.dir, voices: NATURAL_VOICES, approxMb: 330,
        sizeBytes: state === "ready" ? dirSize(o.dir) : null,
      };
    },

    install() {
      if (state === "installing" || state === "ready") return;
      state = "installing";
      error = null;
      percent = null;
      step = "Installing the speech runtime";
      const signal = { cancelled: false };
      const kids: ChildProcess[] = [];
      installer = { stop: () => { signal.cancelled = true; for (const k of kids) k.kill(); } };
      void (async () => {
        try {
          fs.mkdirSync(o.dir, { recursive: true });
          fs.writeFileSync(path.join(o.dir, "package.json"), JSON.stringify({ name: "dena-voice", private: true, dependencies: { "kokoro-js": KOKORO_VERSION } }, null, 2));
          await runNpm(signal, kids);
          pruneOtherPlatforms(o.dir);
          step = "Downloading the voice model";
          percent = 0;
          await prefetch(signal, kids);
          fs.writeFileSync(readyFile, JSON.stringify({ kokoro: KOKORO_VERSION, at: new Date().toISOString() }));
          state = "ready";
          step = null;
          percent = null;
        } catch (e) {
          const cancelled = signal.cancelled;
          state = cancelled ? "off" : "error";
          error = cancelled ? null : (e as Error).message;
          step = null;
          percent = null;
          if (!cancelled) log(`[voice] ${(e as Error).message}`);
        } finally {
          installer = null;
        }
      })();
    },

    cancel() {
      installer?.stop();
    },

    async remove() {
      installer?.stop();
      stopWorker();
      // Only ever the voice folder itself, never a path from a request.
      fs.rmSync(o.dir, { recursive: true, force: true });
      state = "off";
      error = null;
      step = null;
      percent = null;
    },

    speak(text, opts = {}) {
      if (state !== "ready") return Promise.reject(new VoiceError(409, "The natural voice is not installed"));
      const t = text.replace(/\s+/g, " ").trim();
      if (!t) return Promise.reject(new VoiceError(400, "Nothing to say"));
      if (t.length > MAX_SPEAK_CHARS) return Promise.reject(new VoiceError(413, "Too much text for one piece"));
      const voice = opts.voice && opts.voice in NATURAL_VOICES ? opts.voice : DEFAULT_NATURAL_VOICE;
      const speed = Math.min(2, Math.max(0.5, Number(opts.speed) || 1));
      // One at a time: the model uses all the processor it can get.
      const run = () =>
        new Promise<Buffer>((resolve, reject) => {
          const w = startWorker();
          const id = nextId++;
          const timer = setTimeout(() => { pending.delete(id); reject(new VoiceError(504, "The voice took too long")); stopWorker(); }, 90_000);
          pending.set(id, { resolve, reject, timer });
          w.send({ id, type: "speak", text: t, voice, speed });
          setIdle();
        });
      const next = chain.then(run, run);
      chain = next.catch(() => {});
      return next;
    },

    close() {
      installer?.stop();
      stopWorker();
    },
  };
}
