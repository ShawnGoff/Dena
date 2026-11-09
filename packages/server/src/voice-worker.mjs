// Speaks for Dena's natural voice. Run by the server as a child process inside ~/.dena/voice,
// where the speech runtime is installed. Plain JavaScript so it runs the same from the source
// tree and from the installed package.
//   node voice-worker.mjs prefetch   download the model once, reporting progress, then exit
//   node voice-worker.mjs            answer {id, type:"speak", text, voice, speed} with {id, wav}
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.env.DENA_VOICE_DIR;
if (!dir || !process.send) process.exit(2);

const { KokoroTTS } = await import(pathToFileURL(path.join(dir, "node_modules", "kokoro-js", "dist", "kokoro.js")).href);

/** Percent over all files seen so far, so the model file (nearly all the bytes) drives it. */
const files = new Map();
const progress = (p) => {
  // Only the model file is large; counting the small config files made the bar jump to 100% at the start.
  if (p?.status !== "progress" || !p.total || p.total < 1e6) return;
  files.set(p.file, { loaded: p.loaded, total: p.total });
  let l = 0;
  let t = 0;
  for (const f of files.values()) { l += f.loaded; t += f.total; }
  process.send({ type: "progress", percent: (l / t) * 100 });
};

let model = null;
const load = (cb) => (model ??= KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu", progress_callback: cb }));

if (process.argv[2] === "prefetch") {
  await load(progress);
  process.send({ type: "ready" });
  process.exit(0);
}

process.on("message", async (m) => {
  if (m?.type !== "speak") return;
  try {
    const tts = await load();
    const audio = await tts.generate(m.text, { voice: m.voice, speed: m.speed });
    process.send({ id: m.id, wav: Buffer.from(audio.toWav()) });
  } catch (e) {
    process.send({ id: m.id, error: String(e?.message ?? e) });
  }
});
