import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Segment } from "../narrate";
import { chooseVoices } from "../voices";
import { naturalClip, useNaturalVoice, type NaturalStatus } from "../natural";
import { NaturalVoiceDialog } from "./NaturalVoiceDialog";

const RATES = [0.85, 1, 1.25, 1.5];
type Engine = "browser" | "natural";

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode: the choice just won't be remembered */
  }
};

const supported = () => typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

/**
 * Reads segments aloud, with the browser's own voices or (when installed and chosen) the natural
 * voice, which Dena's server speaks on this computer. `index` is -1 when idle. Segments are
 * spoken one at a time because browsers cut off long utterances; `token` ignores the end-events
 * that cancelling itself causes. For the natural voice the next piece is prepared while the
 * current one plays.
 */
export function usePresenter(segments: Segment[], natural: NaturalStatus | null) {
  const [index, setIndex] = useState(-1);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [rate, setRateState] = useState(() => Number(read("dena.presenter.rate")) || 1);
  const [voiceURI, setVoiceState] = useState(() => read("dena.presenter.voice") ?? "");
  const [engine, setEngineState] = useState<Engine>(() => (read("dena.presenter.engine") === "natural" ? "natural" : "browser"));
  const [naturalVoice, setNaturalVoiceState] = useState(() => read("dena.presenter.naturalVoice") ?? "af_heart");
  const [chosen, setChosen] = useState<ReturnType<typeof chooseVoices<SpeechSynthesisVoice>>>({ list: [], best: undefined, hasPremium: false });
  const segs = useRef(segments);
  const token = useRef(0);
  const audio = useRef<HTMLAudioElement | null>(null);
  const clips = useRef(new Map<number, Promise<string>>());
  const best = useRef<SpeechSynthesisVoice | undefined>(undefined);
  best.current = chosen.best;
  segs.current = segments;
  // The natural voice only counts once the server says it is installed.
  const useNatural = engine === "natural" && natural?.state === "ready";
  const opts = useRef({ rate, voiceURI, naturalVoice, useNatural });
  opts.current = { rate, voiceURI, naturalVoice, useNatural };

  useEffect(() => {
    if (!supported()) return;
    const load = () => setChosen(chooseVoices(window.speechSynthesis.getVoices()));
    load();
    window.speechSynthesis.addEventListener?.("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener?.("voiceschanged", load);
  }, []);

  const dropClips = useCallback(() => {
    for (const p of clips.current.values()) p.then((u) => URL.revokeObjectURL(u), () => {});
    clips.current.clear();
  }, []);

  const halt = useCallback(() => {
    token.current++;
    if (supported()) window.speechSynthesis.cancel();
    const a = audio.current;
    if (a) {
      a.onended = null;
      a.onerror = null;
      a.pause();
      a.removeAttribute("src");
    }
    dropClips();
    setLoading(false);
  }, [dropClips]);

  const stop = useCallback(() => {
    halt();
    setIndex(-1);
    setPaused(false);
  }, [halt]);

  const clip = useCallback((i: number): Promise<string> | null => {
    const seg = segs.current[i];
    if (!seg) return null;
    let p = clips.current.get(i);
    if (!p) {
      p = naturalClip(seg.text, opts.current.naturalVoice);
      p.catch(() => clips.current.delete(i));
      clips.current.set(i, p);
    }
    return p;
  }, []);

  const speak = useCallback((i: number) => {
    const t = ++token.current;
    if (supported()) window.speechSynthesis.cancel();
    audio.current?.pause();
    const seg = segs.current[i];
    if (!seg) {
      stop();
      return;
    }
    setIndex(i);
    setPaused(false);
    setProblem(null);

    if (opts.current.useNatural) {
      setLoading(true);
      const mine = clip(i)!;
      mine.then((url) => {
        if (token.current !== t) return;
        setLoading(false);
        const a = (audio.current ??= new Audio());
        a.onerror = () => token.current === t && (setProblem("The natural voice could not play that."), stop());
        a.onended = () => {
          if (token.current !== t) return;
          // Earlier clips are done with; keep the one being prepared.
          const done = clips.current.get(i);
          clips.current.delete(i);
          done?.then((u) => URL.revokeObjectURL(u), () => {});
          speak(i + 1);
        };
        a.src = url;
        a.playbackRate = opts.current.rate;
        void a.play().catch(() => {});
        void clip(i + 1)?.catch(() => {}); // prepare the next piece while this one plays
      }, (e: Error) => {
        if (token.current !== t) return;
        setProblem(`The natural voice stopped: ${e.message}`);
        stop();
      });
      return;
    }

    const synth = window.speechSynthesis;
    const u = new SpeechSynthesisUtterance(seg.text);
    u.rate = opts.current.rate;
    // A voice you picked wins; otherwise the best installed local one (if any), else the browser default.
    const v = synth.getVoices().find((x) => x.voiceURI === opts.current.voiceURI) ?? best.current;
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
    u.onend = () => {
      if (token.current === t) speak(i + 1);
    };
    u.onerror = () => {
      if (token.current === t) stop();
    };
    synth.speak(u);
  }, [stop, clip]);

  /** The first segment of the next (or previous) part of the page. */
  const jump = useCallback((dir: 1 | -1) => {
    const all = segs.current;
    const here = index < 0 ? 0 : index;
    const anchor = all[here]?.anchor;
    if (dir === 1) {
      const n = all.findIndex((s, i) => i > here && s.anchor !== anchor);
      if (n < 0) stop();
      else speak(n);
      return;
    }
    // Back: restart this part if we are past its start, otherwise go to the start of the one before.
    let start = here;
    while (start > 0 && all[start - 1]!.anchor === anchor) start--;
    if (start < here) return speak(start);
    if (start === 0) return speak(0);
    const prev = all[start - 1]!.anchor;
    let p = start - 1;
    while (p > 0 && all[p - 1]!.anchor === prev) p--;
    speak(p);
  }, [index, speak, stop]);

  const toggle = useCallback(() => {
    if (index < 0) return speak(0);
    if (opts.current.useNatural) {
      const a = audio.current;
      if (paused) void a?.play().catch(() => {});
      else a?.pause();
    } else if (paused) window.speechSynthesis.resume();
    else window.speechSynthesis.pause();
    setPaused(!paused);
  }, [index, paused, speak]);

  const setRate = (r: number) => {
    setRateState(r);
    write("dena.presenter.rate", String(r));
    opts.current.rate = r;
    if (index < 0) return;
    if (opts.current.useNatural && audio.current) audio.current.playbackRate = r; // no need to regenerate
    else speak(index); // a browser voice can't change speed mid-sentence
  };
  const setVoice = (uri: string) => {
    setVoiceState(uri);
    write("dena.presenter.voice", uri);
    opts.current.voiceURI = uri;
    if (index >= 0 && !opts.current.useNatural) speak(index);
  };
  const setNaturalVoice = (v: string) => {
    setNaturalVoiceState(v);
    write("dena.presenter.naturalVoice", v);
    opts.current.naturalVoice = v;
    if (index >= 0 && opts.current.useNatural) {
      dropClips();
      speak(index);
    }
  };
  const setEngine = (e: Engine) => {
    setEngineState(e);
    write("dena.presenter.engine", e);
    opts.current.useNatural = e === "natural" && natural?.state === "ready";
    if (index >= 0) {
      dropClips();
      speak(index);
    }
  };

  // Leaving the page (or the page changing under the voice) ends the reading.
  useEffect(() => stop, [stop]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else stop();
  }, [segments, stop]);

  // Highlight and follow the part being read.
  const anchor = index >= 0 ? segments[index]?.anchor : undefined;
  useEffect(() => {
    if (!anchor) return;
    const el = document.querySelector<HTMLElement>(`[data-narr="${anchor.replace(/["\\]/g, "\\$&")}"]`);
    if (!el) return;
    el.classList.add("narrating");
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    return () => el.classList.remove("narrating");
  }, [anchor]);

  return {
    supported: supported(), index, paused, loading, problem, rate, setRate, voices: chosen.list, hasPremium: chosen.hasPremium, voiceURI, setVoice,
    engine, setEngine, useNatural, naturalVoice, setNaturalVoice, toggle, stop, jump, speak,
  };
}

/**
 * "Listen" for a page. Closed it is one button; open it is a small player that stays in view
 * while the page scrolls along with the voice.
 */
export function Presenter({ segments, label = "Listen" }: { segments: Segment[]; label?: string }) {
  const nv = useNaturalVoice();
  const p = usePresenter(segments, nv.status);
  const [dialog, setDialog] = useState(false);
  const active = p.index >= 0;
  const parts = useMemo(() => new Set(segments.map((s) => s.anchor)).size, [segments]);
  // Once a download the owner asked for finishes, switch to the natural voice.
  const wantNatural = useRef(false);
  useEffect(() => {
    if (dialog && nv.status?.state === "installing") wantNatural.current = true;
    if (wantNatural.current && nv.status?.state === "ready") {
      wantNatural.current = false;
      p.setEngine("natural");
    }
  });
  if (!p.supported || segments.length === 0) return null;

  // Turning the natural voice on from the player: ask first if it is not installed yet.
  const pickEngine = (e: Engine) => {
    if (e === "natural" && nv.status?.state !== "ready") return setDialog(true);
    p.setEngine(e);
  };
  const dlg = dialog && nv.status && (
    <NaturalVoiceDialog status={nv.status} err={nv.err} onInstall={() => void nv.install()} onCancel={() => void nv.cancel()}
      onRemove={() => void nv.remove().then(() => { p.setEngine("browser"); setDialog(false); })} onClose={() => setDialog(false)} />
  );

  if (!active)
    return (
      <div className="presenter idle">
        <button className="btn" onClick={() => p.speak(0)} title="Read this page aloud. Nothing is sent anywhere.">🔊 {label}</button>
        {nv.status && <button className="linkish small" onClick={() => setDialog(true)}>{nv.status.state === "ready" ? "Natural voice" : "Get a natural voice…"}</button>}
        {p.problem && <span className="error small">{p.problem}</span>}
        {dlg}
      </div>
    );
  const here = segments.slice(0, p.index + 1);
  const part = new Set(here.map((s) => s.anchor)).size;
  return (
    <div className="presenter" role="region" aria-label="Presenter">
      <button className="btn" onClick={() => p.jump(-1)} aria-label="Previous part" title="Previous part">⏮</button>
      <button className="btn primary" onClick={p.toggle} aria-label={p.paused ? "Resume" : "Pause"}>{p.paused ? "▶ Resume" : "⏸ Pause"}</button>
      <button className="btn" onClick={() => p.jump(1)} aria-label="Next part" title="Next part">⏭</button>
      <button className="btn" onClick={p.stop} aria-label="Stop">⏹ Stop</button>
      <span className="faint small">Part {part} of {parts}{p.loading ? " · preparing…" : ""}</span>
      <span className="presenter-spacer" />
      <label className="small faint">Speed{" "}
        <select value={p.rate} onChange={(e) => p.setRate(Number(e.target.value))} aria-label="Speed">
          {RATES.map((r) => <option key={r} value={r}>{r}×</option>)}
        </select>
      </label>
      {nv.status && (
        <label className="small faint">Engine{" "}
          <select value={p.useNatural ? "natural" : "browser"} onChange={(e) => pickEngine(e.target.value as Engine)} aria-label="Engine">
            <option value="browser">Computer voice</option>
            <option value="natural">{nv.status.state === "ready" ? "Natural voice (on this computer)" : "Natural voice (download…)"}</option>
          </select>
        </label>
      )}
      {p.useNatural && nv.status ? (
        <label className="small faint">Voice{" "}
          <select value={p.naturalVoice} onChange={(e) => p.setNaturalVoice(e.target.value)} aria-label="Voice">
            {Object.entries(nv.status.voices).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
      ) : p.voices.length > 1 && (
        <label className="small faint">Voice{" "}
          <select value={p.voiceURI} onChange={(e) => p.setVoice(e.target.value)} aria-label="Voice">
            <option value="">{p.hasPremium ? "Best installed" : "Default"}</option>
            {p.voices.map((c) => <option key={c.voice.voiceURI} value={c.voice.voiceURI}>{c.label}</option>)}
          </select>
        </label>
      )}
      {!p.useNatural && !p.hasPremium && !nv.status && (
        <span className="faint small presenter-hint" style={{ flexBasis: "100%" }}>
          For a more natural voice, install an Enhanced or Premium one: {/Mac/i.test(navigator.platform) ? "System Settings → Accessibility → Spoken Content → System Voice → Manage Voices" : "in your system's speech or text-to-speech settings"}, then reload this page.
        </span>
      )}
      {p.problem && <span className="error small" style={{ flexBasis: "100%" }}>{p.problem}</span>}
      {dlg}
    </div>
  );
}
