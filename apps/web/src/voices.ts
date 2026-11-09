/**
 * Chooses which of the system's voices to offer. Operating systems ship joke voices and robotic
 * legacy ones beside the good ones, and some browsers add "online" voices that send the text to
 * the provider, so the picker hides the first, ranks by quality, and labels the last.
 */
export interface VoiceInfo { voiceURI: string; name: string; lang: string; localService: boolean }

export interface VoiceChoice<V extends VoiceInfo = VoiceInfo> { voice: V; label: string; online: boolean; premium: boolean }

const NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy)\b/i;
const PREMIUM = /premium|enhanced|siri|neural|natural/i;

export function chooseVoices<V extends VoiceInfo>(all: V[]): { list: VoiceChoice<V>[]; best: V | undefined; hasPremium: boolean } {
  const list = all
    .filter((v) => /^en/i.test(v.lang) && !NOVELTY.test(v.name))
    .map((voice) => {
      const online = !voice.localService;
      const premium = !online && PREMIUM.test(voice.name);
      return { voice, online, premium, label: online ? `${voice.name} (online: text is sent to the provider)` : voice.name };
    })
    // Premium first, then ordinary local voices, then online ones; stable within each group.
    .map((c, i) => ({ c, i, rank: c.premium ? 0 : c.online ? 2 : 1 }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.c);
  const best = list.find((c) => c.premium)?.voice;
  return { list, best, hasPremium: !!best };
}
